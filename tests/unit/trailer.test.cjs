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
  // The review threads: served from a FILE when one is named, so the writer's
  // refusal case can hand it a real unresolved thread, and the empty answer
  // otherwise (which is what every merge-gate case here needs).
  '  "api graphql"*)',
  '    if [ -n "${SHIPYARD_TRAILER_THREADS:-}" ]; then cat "$SHIPYARD_TRAILER_THREADS";',
  '    else echo \'{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\'; fi ;;',
  // The writer's own view is matched by its FIELD LIST, not by the absence of
  // `--repo`: with `--repo acme/demo` its argv starts `pr view 9 --repo` too, the
  // same prefix as the reviewers.cjs call below, and the first matching case wins.
  // No other stubbed call asks for `body,headRefOid`.
  '  *"--json body,headRefOid"*) cat "$SHIPYARD_TRAILER_PRVIEW" ;;',
  // reviewers.cjs asks for the review DECISION with an explicit --repo, which is
  // a different argv shape from the body read below. Unanswered it merely warns
  // (the call is tolerated), but then every writer case would run with a stub
  // printing errors, and a real refusal would be indistinguishable from noise.
  '  "pr view 9 --repo"*) echo \'{"reviewDecision":null}\' ;;',
  // The merge gate re-reads the PR from live GitHub by design — this IS the body
  // under test. The writer reads the same call for `body,headRefOid`.
  '  "pr view 9 --json"*) cat "$SHIPYARD_TRAILER_PRVIEW" ;;',
  // The writer's only mutation. The body is captured to a file rather than
  // echoed, because it is multi-line by definition: asserting on it through the
  // stub's stdout would depend on shell quoting, which is the thing that made
  // hand-assembling this trailer unreliable in the first place.
  '  "pr edit 9"*)',
  '    prev=""',
  '    for a in "$@"; do',
  '      if [ "$prev" = "--body" ]; then printf \'%s\' "$a" > "$SHIPYARD_TRAILER_EDIT"; fi',
  '      prev="$a"',
  '    done',
  '    echo "https://example/pr/9" ;;',
  // gh returns its own `bucket` beside `state`, and check-state.cjs reads the
  // bucket: a row without one is PENDING, so a bucket-less stub would have the
  // gate refuse "1 check(s) still running" and none of the trailer cases below
  // would ever reach the trailer.
  '  "pr checks 9"*) echo \'[{"name":"build","state":"SUCCESS","bucket":"pass"}]\' ;;',
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

// ═══════════════════════════════════════════════════════════════════════════
// A CONFORM VERDICT IS BOUND TO THE HEAD IT JUDGED
//
// Everything above pins that an EXTRA key changes no verdict. `head=` is the one
// key that must: it says which diff arch-review actually judged. The sequence
// that costs the most is ordinary — verdict → undraft → a bot review lands on
// the now-undrafted PR → review-fix pushes → CI goes green again — and the
// untouched trailer would otherwise still read `conform` for code that is no
// longer on the branch. It happened on PR #31 and twice after it, and the guards
// were stripping the trailer BY HAND to force a re-review.
//
// The reader is exercised directly here (it is pure), and the three consumers
// through their own fixtures in sentinel.test.cjs / front.test.cjs.
// ═══════════════════════════════════════════════════════════════════════════

const TRAILER = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gate-trailer.cjs');
const { USAGE, parseGate, gateKind, gateConform, gateWhy } = require(TRAILER);

const SHA_A = 'abc123abc123abc123abc123abc123abc123abcd';
const SHA_B = 'def456def456def456def456def456def456defa';

suite('the trailer reader: head= is a key like any other, and a bound verdict');

test('parseGate reads head= out of the line', () => {
  assert.deepStrictEqual(
    parseGate('gate_status: arch-review=conform, head=abc123'),
    { 'arch-review': 'conform', head: 'abc123' }
  );
});

test('the LAST gate_status line still wins, head and all', () => {
  // The property the whole file exists to protect, now over two heads: a
  // re-verdict appends, so the newest line is the current one.
  const body = [
    'gate_status: arch-review=conform, head=aaaaaaa',
    '',
    'gate_status: arch-review=conform, head=bbbbbbb',
  ].join('\n');
  assert.strictEqual(parseGate(body).head, 'bbbbbbb');
  // …and an unknown key still passes through untouched beside it.
  assert.strictEqual(
    parseGate('gate_status: arch-review=conform, someday=42, head=abc123').someday,
    '42'
  );
});

test('gateKind separates the four states, and only one of them is conform', () => {
  const conformTrailer = (head) => ({ 'arch-review': 'conform', ...(head ? { head } : {}) });
  // Same head: the ordinary path.
  assert.strictEqual(gateKind(conformTrailer(SHA_A), SHA_A), 'conform');
  // Different head: the verdict is about code that is not on the branch.
  assert.strictEqual(gateKind(conformTrailer(SHA_A), SHA_B), 'stale');
  // Neither side knows a head — a trailer from the previous release on a board
  // synced by it. Nothing to compare, so the verdict stands. This is the only
  // direction compatibility runs in, and the case that must not regress a board
  // mid-upgrade.
  assert.strictEqual(gateKind(conformTrailer(null), null), 'conform');
  // The board KNOWS the head and the trailer does not: fail-closed, because
  // nothing can say which diff was judged.
  assert.strictEqual(gateKind(conformTrailer(null), SHA_B), 'unbound');
  // No verdict at all, with or without a head on the board.
  assert.strictEqual(gateKind(null, SHA_B), 'unrecorded');
  assert.strictEqual(gateKind({ 'arch-review': 'violation', head: SHA_B }, SHA_B), 'unrecorded');
  // An empty head string is an absent head — gh omits the field, a stub prints
  // "", a hand-written trailer says `head=`, and all three mean the same thing.
  assert.strictEqual(gateKind(conformTrailer(SHA_A), ''), 'stale');
  assert.strictEqual(gateKind({ 'arch-review': 'conform', head: '' }, ''), 'conform');
  // gateConform is exactly "kind === conform", which is what the three readers
  // call. Asserted, not assumed: they must not be able to drift apart.
  for (const [gate, head] of [[conformTrailer(SHA_A), SHA_A], [conformTrailer(SHA_A), SHA_B],
    [conformTrailer(null), null], [conformTrailer(null), SHA_B], [null, SHA_B]]) {
    assert.strictEqual(gateConform(gate, head), gateKind(gate, head) === 'conform');
  }
});

test('a short-sha trailer counts as stale rather than being prefix-matched', () => {
  // Fail-CLOSED on the one gate that decides what lands: tolerance would let a
  // 7-char coincidence pass. It costs one re-review and self-heals the moment
  // the writer records the full oid.
  assert.strictEqual(gateKind({ 'arch-review': 'conform', head: SHA_A.slice(0, 7) }, SHA_A), 'stale');
});

test('gateWhy names BOTH SHAs for a stale verdict, and no remedy', () => {
  // Both, or the remedy ("re-judge this head") is a guess — and "no conform
  // trailer" would be a lie about a body that visibly carries one. The remedy is
  // the caller's to add: the board says what is owed, the guard says why it
  // refuses, and gateWhy must not force one file's words on the other.
  const why = gateWhy({ 'arch-review': 'conform', head: SHA_A }, SHA_B);
  assert.ok(why.includes('abc123a'), why);
  assert.ok(why.includes('def456d'), why);
  assert.strictEqual(gateWhy({ 'arch-review': 'conform', head: SHA_A }, SHA_A), null, 'conform has no why');
});

test('gateWhy says a headless trailer predates head binding', () => {
  const why = gateWhy({ 'arch-review': 'conform' }, SHA_B);
  assert.ok(/predates head binding/.test(why), why);
  // The unrecorded phrase is the one three existing messages embed verbatim, so
  // it must keep naming the trailer the agent is supposed to look for.
  assert.ok(gateWhy(null, null).includes('arch-review=conform'), gateWhy(null, null));
});

suite('gate-trailer write: one line, bound to the live head, never over a thread');

const EDIT = path.join(W, 'edited-body.txt');
const THREADS = path.join(W, 'threads.json');

// One unresolved thread in the shape reviewers.cjs actually counts (`isResolved:
// false`, one comment) — a payload it cannot walk would refuse for the wrong
// reason and the test would pass while measuring nothing.
const oneOpenThread = JSON.stringify({
  data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [{
      id: 'T_kw1', isResolved: false, isOutdated: false, path: 'a.js', line: 1,
      comments: { totalCount: 1, pageInfo: { hasNextPage: false },
        nodes: [{ author: { login: 'coderabbitai' }, body: 'nit', url: 'https://example/1' }] },
    }],
  } } } },
});

function writeTrailer({ body, headRefOid, threads, args } = {}) {
  fs.writeFileSync(PRVIEW, JSON.stringify({ number: 9, body: body === undefined ? 'Ticket: T-01-01\n' : body, ...(headRefOid === null ? {} : { headRefOid: headRefOid || SHA_A }) }));
  try { fs.unlinkSync(EDIT); } catch { /* not written yet */ }
  const env = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, SHIPYARD_TRAILER_PRVIEW: PRVIEW, SHIPYARD_TRAILER_EDIT: EDIT };
  if (threads) { fs.writeFileSync(THREADS, threads); env.SHIPYARD_TRAILER_THREADS = THREADS; }
  const r = spawnSync(process.execPath, [TRAILER, ...(args || ['write', '9', '--arch-review', 'conform', '--drift-check', 'fresh', '--degenerate-green', 'clean'])], { encoding: 'utf8', env });
  return { ...r, edited: fs.existsSync(EDIT) ? fs.readFileSync(EDIT, 'utf8') : null };
}

test('the written trailer carries the live head, and there is exactly ONE of them', () => {
  // The stale line is STRIPPED, not appended past: a body with two lines hides
  // the verdict above it, which is the failure mode the suites above pin. Here it
  // cannot happen by construction.
  const r = writeTrailer({
    body: `Ticket: T-01-01\n\nProblem: x\n\ngate_status: arch-review=conform, drift-check=fresh, degenerate-green=clean, checks=green, head=${SHA_B}`,
    headRefOid: SHA_A,
  });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = r.edited.split('\n').filter((l) => /^\s*gate_status:/i.test(l));
  assert.strictEqual(lines.length, 1, `expected one trailer, got:\n${r.edited}`);
  assert.ok(lines[0].includes(`head=${SHA_A}`), lines[0]);
  assert.ok(!r.edited.includes(SHA_B), `the superseded head survived:\n${r.edited}`);
  assert.ok(r.edited.startsWith('Ticket: T-01-01'), `the body was not preserved:\n${r.edited}`);
  // Writer → reader round trip: what this script writes is what the three
  // readers accept for that head, and reject for any other. Asserting the text
  // alone would pin the format and not the agreement.
  assert.strictEqual(gateConform(parseGate(r.edited), SHA_A), true);
  assert.strictEqual(gateConform(parseGate(r.edited), SHA_B), false);
});

test('an unresolved thread refuses the write, and nothing is edited', () => {
  // "Writing it while a thread is open is falsifying the gate" was a sentence in
  // pr-sentinel.md. It is now a refusal — and the PR body must be untouched,
  // because a half-written verdict is worse than none.
  const r = writeTrailer({ threads: oneOpenThread });
  assert.notStrictEqual(r.status, 0, `expected a refusal, got exit 0:\n${r.stdout}`);
  assert.strictEqual(r.edited, null, `the body was edited anyway:\n${r.edited}`);
  assert.ok(/unresolved review thread/.test(r.stderr), r.stderr);
});

test('a PR reporting no head refuses too, rather than writing a headless trailer', () => {
  // Otherwise the writer would manufacture the exact legacy shape the readers
  // now fail closed on, and the next reader would call it `unbound`.
  const r = writeTrailer({ headRefOid: null });
  assert.notStrictEqual(r.status, 0, `expected a refusal, got exit 0:\n${r.stdout}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/headRefOid/.test(r.stderr), r.stderr);
});

test('threads it cannot read refuse as well — the writer is not softer than the gate', () => {
  const r = writeTrailer({ threads: 'not json at all' });
  assert.notStrictEqual(r.status, 0, `expected a refusal, got exit 0:\n${r.stdout}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/review threads/.test(r.stderr), r.stderr);
});

test('a missing required flag is a usage error, not a trailer with holes in it', () => {
  const r = writeTrailer({ args: ['write', '9', '--arch-review', 'conform'] });
  assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/--drift-check/.test(r.stderr), r.stderr);
});

suite('the command docs call the writer instead of assembling a trailer by hand');

// The docs are the delivery channel for anything a dispatched agent does, so a
// doc still showing `gh pr edit --body "…gate_status…"` keeps producing exactly
// the trailer this ticket exists to stop: one with no head, and sometimes two of
// them. Pinned against the script's own USAGE rather than a copy of it.
const DOCS = [
  path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'commands', 'deliver.md'),
  path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'references', 'pr-sentinel.md'),
];
const REQUIRED_FLAGS = ['--arch-review', '--drift-check', '--degenerate-green'];

// `--repo` is OPTIONAL to the script and mandatory in practice, which is why it
// needs a pin of its own rather than a row in REQUIRED_FLAGS: the writer resolves
// the repository from the cwd when it is absent, so a snippet that omits it
// teaches an agent standing anywhere else to write the verdict onto a
// same-numbered PR next door. The refusal round 1 added catches a MISSPELT
// `--repo`; nothing can catch an omitted one, so the only defence is that every
// doc showing the invocation shows the qualifier. `deliver.md` and the script's
// USAGE carried it and `pr-sentinel.md` did not — the three texts disagreeing
// about the one flag that decides WHICH repository is written to.
const OPTIONAL_FLAGS = ['--repo'];

test('both docs name the optional --repo qualifier, which decides which repo is written to', () => {
  for (const f of OPTIONAL_FLAGS) {
    assert.ok(USAGE.includes(f), `the script's USAGE no longer names ${f} — update OPTIONAL_FLAGS and the docs together`);
  }
  for (const doc of DOCS) {
    const text = fs.readFileSync(doc, 'utf8');
    // Inside a gate-trailer invocation, not merely somewhere in the file: every
    // one of these docs mentions `--repo` for other scripts too.
    const calls = text.split('\n').reduce((acc, line, i, all) => {
      if (/gate-trailer\.cjs write/.test(line)) acc.push(all.slice(i, i + 3).join('\n'));
      return acc;
    }, []);
    assert.ok(calls.length > 0, `${path.basename(doc)} does not call the trailer writer`);
    for (const call of calls) {
      for (const f of OPTIONAL_FLAGS) {
        assert.ok(call.includes(f), `${path.basename(doc)} invokes gate-trailer.cjs write without ${f}:\n${call}`);
      }
    }
  }
});

test('both docs invoke gate-trailer.cjs write with every flag the script requires', () => {
  for (const f of REQUIRED_FLAGS) {
    assert.ok(USAGE.includes(f), `the script's USAGE no longer names ${f} — update REQUIRED_FLAGS and the docs together`);
  }
  for (const doc of DOCS) {
    const text = fs.readFileSync(doc, 'utf8');
    assert.ok(/gate-trailer\.cjs write/.test(text), `${path.basename(doc)} does not call the trailer writer`);
    for (const f of REQUIRED_FLAGS) {
      assert.ok(text.includes(f), `${path.basename(doc)} omits ${f}`);
    }
  }
});

test('neither doc hand-writes a gate_status: line into a gh pr edit body', () => {
  for (const doc of DOCS) {
    const lines = fs.readFileSync(doc, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/gh pr edit/.test(line)) return;
      const window = lines.slice(i, i + 4);
      const hand = window.findIndex((l) => /gate_status:/.test(l));
      assert.strictEqual(
        hand, -1,
        `${path.basename(doc)}:${i + 1} still assembles a trailer by hand:\n${window.join('\n')}`
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// THE WRITER ACCEPTS ONLY WHAT ITS USAGE NAMES
//
// This script is THE single writer of the merge gate, and its argv parsing used
// to check only that a flag was present with a value not itself starting with
// `--`. So `--arch-review confrom --drift-check freshh --checks red` exited 0 and
// wrote all three into the trailer verbatim, and `--rep acme/other` left `--repo`
// unset and recorded the verdict against whatever repository the cwd resolved to.
//
// The severity is NOT a hole in the merge gate: `gateKind` compares
// `arch-review` against `conform` case-insensitively, so a typo reads as
// `unrecorded` and costs an extra arch-review — the fail-CLOSED direction. What
// it was is a single writer whose contract lived in its USAGE string instead of
// in its code, which is this repository's standing defect class. So the
// vocabulary is now enforced, at exit 2 (a usage error) and before any `gh` call.
//
// The two directions are tested together on purpose: a writer stricter than the
// readers would refuse a trailer the gate accepts, and a writer looser than its
// own docs is where this started.
// ═══════════════════════════════════════════════════════════════════════════

suite('gate-trailer write: the vocabulary its USAGE names, and nothing else');

// The three required flags, as a baseline the cases below override one key of.
const REQUIRED = { 'arch-review': 'conform', 'drift-check': 'fresh', 'degenerate-green': 'clean' };
const argsWith = (over = {}, extra = []) => {
  const out = ['write', '9'];
  for (const [k, v] of Object.entries({ ...REQUIRED, ...over })) out.push(`--${k}`, v);
  return out.concat(extra);
};

// REFUSED. Each row is a value (or an argument) the USAGE does not name.
for (const [what, over, extra, expected] of [
  // A typo in any of the four keys.
  ['a misspelt conform verdict', { 'arch-review': 'confrom' }, [], /--arch-review/],
  ['a misspelt drift verdict', { 'drift-check': 'freshh' }, [], /--drift-check/],
  ['a misspelt degenerate-green report', { 'degenerate-green': 'cleen' }, [], /--degenerate-green/],
  ['a misspelt check state', {}, ['--checks', 'greeen'], /--checks/],
  // A verdict that is real but must never be written: `violation` and
  // `adr-outdated` END the action (pr-sentinel.md / deliver.md) — the fixer
  // pushes or the ticket is escalated, and no trailer is written at all. So the
  // refusal is a documented rule, not only a typo guard.
  ['the violation verdict, which ends the action instead', { 'arch-review': 'violation' }, [], /violation|conform/],
  ['the adr-outdated verdict, which escalates instead', { 'arch-review': 'adr-outdated' }, [], /conform/],
  // `drifted` never reaches a PR: a drifted ticket is PARKED by drift-record
  // before it is executed, so it has no branch, no PR and no verdict to record.
  ['a drifted verdict, which parks the ticket rather than reaching a PR', { 'drift-check': 'drifted' }, [], /--drift-check/],
  // `--degenerate-green` is closed in SHAPE, not in vocabulary: `counts.total`
  // is any non-negative integer. These are outside the shape.
  ['a negative finding count', { 'degenerate-green': '-1' }, [], /--degenerate-green/],
  ['a fractional finding count', { 'degenerate-green': '3.5' }, [], /--degenerate-green/],
  ['a check state other than green, on a trailer only written for a green PR', {}, ['--checks', 'red'], /--checks/],
  // The argument the readers can never notice: a misspelt `--repo` used to be
  // ignored, leaving the repo to be resolved from the cwd — a verdict written
  // onto a same-numbered PR in the wrong repository. Silently misrouting the
  // trailer is worse than a typo inside one.
  ['a misspelt --repo, which used to silently retarget the write', {}, ['--rep', 'acme/other'], /--rep\b/],
  ['a stray positional argument', {}, ['oops'], /oops/],
]) {
  test(`refused: ${what}`, () => {
    const r = writeTrailer({ args: argsWith(over, extra) });
    assert.strictEqual(r.status, 2, `expected a usage refusal (exit 2), got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.strictEqual(r.edited, null, `the PR body was edited anyway:\n${r.edited}`);
    assert.ok(expected.test(r.stderr), `refusal does not name the offending input: ${r.stderr}`);
    assert.ok(/usage: /.test(r.stderr), `a usage error must print the usage: ${r.stderr}`);
  });
}

// ACCEPTED. Every value the current callers legitimately pass must still write.
// Without these the refusals above could be satisfied by a writer that refuses
// everything, which would take the conveyor down rather than tighten it.
for (const [what, over, extra, expected] of [
  ['the detector reporting a count', { 'degenerate-green': '3' }, [], 'degenerate-green=3'],
  ['a two-digit count', { 'degenerate-green': '12' }, [], 'degenerate-green=12'],
  ['zero findings written as a number rather than `clean`', { 'degenerate-green': '0' }, [], 'degenerate-green=0'],
  ['the detector having exited 2', { 'degenerate-green': 'skipped' }, [], 'degenerate-green=skipped'],
  ['drift-check not having run for this ticket', { 'drift-check': 'skipped' }, [], 'drift-check=skipped'],
  ['--checks green stated explicitly', {}, ['--checks', 'green'], 'checks=green'],
  ['--checks omitted, which defaults to green', {}, [], 'checks=green'],
  // The sentinel passes `--repo` on every call (without it a cross-repo ticket
  // resolves to the wrong repository), so the argument scan must not eat it.
  ['--repo, which the sentinel passes on every call', {}, ['--repo', 'acme/demo'], 'arch-review=conform'],
]) {
  test(`accepted: ${what}`, () => {
    const r = writeTrailer({ args: argsWith(over, extra) });
    assert.strictEqual(r.status, 0, `expected the write to succeed\n${r.stdout}\n${r.stderr}`);
    const lines = r.edited.split('\n').filter((l) => /^\s*gate_status:/i.test(l));
    assert.strictEqual(lines.length, 1, `expected one trailer, got:\n${r.edited}`);
    assert.ok(lines[0].includes(expected), `expected \`${expected}\` in: ${lines[0]}`);
  });
}

test('the writer accepts exactly the casing the readers do, and no other', () => {
  // `gateKind` lowercases before comparing, so `CONFORM` IS a conform verdict to
  // all three readers. A writer that refused it would be stricter than the gate
  // it writes for; one that accepted `confrom` would be looser than its own docs.
  const r = writeTrailer({ args: argsWith({ 'arch-review': 'CONFORM', 'drift-check': 'Skipped' }) });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(gateConform(parseGate(r.edited), SHA_A), true, `the reader must accept what was written:\n${r.edited}`);
  assert.strictEqual(gateKind(parseGate(r.edited), SHA_B), 'stale', 'and still bind it to the head it judged');
});

test('a rejected value is refused BEFORE the PR is read, not after', () => {
  // A usage error must cost no network round trip and must never be discovered
  // between reading the body and writing it back. With no PR view file present
  // at all, the stub would fail loudly on any `gh pr view`; the refusal must
  // still be the vocabulary one.
  const r = spawnSync(process.execPath, [TRAILER, ...argsWith({ 'arch-review': 'confrom' })], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, SHIPYARD_TRAILER_PRVIEW: path.join(W, 'does-not-exist.json') },
  });
  assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.ok(/--arch-review/.test(r.stderr), r.stderr);
  assert.ok(!/gh pr view/.test(r.stderr), `the PR was read before the argv was checked: ${r.stderr}`);
});

// ════════════════════════════════════════════════════════════════════════════
// AN ARGUMENT GIVEN TWICE IS REFUSED, NOT SILENTLY HALVED
//
// The suite above pins that the writer refuses a value its USAGE does not name.
// It did that by looking each flag up with `argv.indexOf()`, which takes the
// FIRST occurrence — so a DUPLICATE was accepted at exit 0 and the later value
// dropped without a word. `--checks green --checks red` wrote `checks=green`;
// `--arch-review conform --arch-review violation` wrote `conform`.
//
// For the three value-checked keys that is fail-SAFE (the surviving value is the
// validated one) and merely contradicts the principle the file had just
// established. For `--repo` it is not safe at all: nothing validates that value,
// so `--repo a/b --repo c/d` writes the verdict to `a/b`, and a caller whose
// SECOND `--repo` is the intended one — a wrapper appending the qualifier to a
// command that already carries one — records the verdict onto a same-numbered PR
// in another repository. That is the exact defect the unknown-argument refusal
// exists to prevent, reached through a different door, and no reader downstream
// can detect it: the trailer is well-formed, it is just on the wrong PR.
//
// So there is no "harmless duplicate" exception. Deciding harmlessness means
// comparing the two values and guessing which was meant, and refusing to guess
// is the whole posture of this script.
// ════════════════════════════════════════════════════════════════════════════

suite('gate-trailer write: each flag once, and a duplicate is a usage error');

for (const [what, extra, flag] of [
  // The case the reviewer raised, verbatim: the later value is not the one written.
  ['--checks given twice', ['--checks', 'green', '--checks', 'red'], '--checks'],
  // The one that matters most in principle: two opposite architecture verdicts in
  // one invocation exited 0 and recorded the first.
  ['two opposing --arch-review verdicts', ['--arch-review', 'violation'], '--arch-review'],
  // The one that matters most in consequence: an unvalidated value, so the
  // surviving occurrence decides WHICH repository the verdict lands on.
  ['--repo given twice, which silently picks a repository', ['--repo', 'acme/demo', '--repo', 'acme/other'], '--repo'],
  ['--drift-check given twice', ['--drift-check', 'skipped'], '--drift-check'],
  ['--degenerate-green given twice', ['--degenerate-green', 'skipped'], '--degenerate-green'],
  // No harmless-duplicate exception: identical values are refused too, because
  // the alternative is a writer that compares values and guesses.
  ['the same flag twice with the same value', ['--checks', 'green', '--checks', 'green'], '--checks'],
]) {
  test(`refused: ${what}`, () => {
    const r = writeTrailer({ args: argsWith({}, extra) });
    assert.strictEqual(r.status, 2, `expected a usage refusal (exit 2), got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.strictEqual(r.edited, null, `the PR body was edited anyway:\n${r.edited}`);
    assert.ok(r.stderr.includes(flag), `the refusal does not name ${flag}: ${r.stderr}`);
    // Named as a duplicate, not as an unknown argument: the flag IS one the
    // writer knows, and a reader told "unexpected argument" would go looking for
    // a typo that is not there.
    assert.ok(/more than once|twice|duplicat/i.test(r.stderr), `the refusal does not say it is a duplicate: ${r.stderr}`);
    assert.ok(/usage: /.test(r.stderr), `a usage error must print the usage: ${r.stderr}`);
  });
}

test('a flag whose value is missing names THAT flag, not the next flag\'s value', () => {
  // The parity hazard, as its live symptom. Round 1 scanned for unknown arguments
  // with `for (i = 2; i < argv.length; i += 2)`, a stride that assumes every flag
  // takes exactly one value. It is true of all five today, so the assumption did
  // not admit an invalid trailer — it mis-DIAGNOSED valid-looking input: `--repo`
  // with no value reported `unexpected argument "conform"`, naming the NEXT
  // flag's value, and an agent reading that goes hunting for a typo in the word
  // `conform`. The same stride would refuse legitimate input outright the moment
  // a flag that takes no value is added. Arity now lives in the one loop that
  // consumes it, so a missing value is reported against the flag that is missing
  // it.
  const r = writeTrailer({
    args: ['write', '9', '--repo', '--arch-review', 'conform', '--drift-check', 'fresh', '--degenerate-green', 'clean'],
  });
  assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/--repo needs a value/.test(r.stderr), `the refusal blames the wrong argument: ${r.stderr}`);
  assert.ok(!/"conform"/.test(r.stderr), `the refusal names the next flag's value: ${r.stderr}`);
});

test('the sentinel\'s own invocation, flag for flag, still writes', () => {
  // The refusals above are only safe if the call the conveyor actually makes
  // survives them. This is that call verbatim — the qualifier the guard passes on
  // every gate write, a `skipped` drift verdict (the ordinary case: drift-check
  // runs before execution, not at the gate), a clean detector report, and no
  // `--checks`, which defaults to green. A parser change that refuses this row
  // takes delivery down rather than tightening it. The PR number is the harness's;
  // what is pinned is the flag sequence.
  const r = writeTrailer({
    args: ['write', '9', '--repo', 'serhii-nochevnyi/shipyard',
      '--arch-review', 'conform', '--drift-check', 'skipped', '--degenerate-green', 'clean'],
  });
  assert.strictEqual(r.status, 0, `the guard's own invocation was refused\n${r.stdout}\n${r.stderr}`);
  const lines = r.edited.split('\n').filter((l) => /^\s*gate_status:/i.test(l));
  assert.strictEqual(lines.length, 1, `expected one trailer, got:\n${r.edited}`);
  assert.ok(lines[0].includes('arch-review=conform'), lines[0]);
  assert.ok(lines[0].includes('drift-check=skipped'), lines[0]);
  assert.ok(lines[0].includes('degenerate-green=clean'), lines[0]);
  assert.ok(lines[0].includes('checks=green'), lines[0]);
  assert.ok(lines[0].includes(`head=${SHA_A}`), lines[0]);
  // And what it wrote is what the three readers accept for that head.
  assert.strictEqual(gateConform(parseGate(r.edited), SHA_A), true);
});

test('a duplicate is refused BEFORE the PR is read, like every other usage error', () => {
  // Same property the vocabulary suite pins: a usage error must cost no network
  // round trip. With no PR view file present the stub fails loudly on any
  // `gh pr view`, so the refusal must still be the duplicate one.
  const r = spawnSync(process.execPath, [TRAILER, ...argsWith({}, ['--checks', 'green', '--checks', 'red'])], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, SHIPYARD_TRAILER_PRVIEW: path.join(W, 'does-not-exist.json') },
  });
  assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.ok(/--checks/.test(r.stderr), r.stderr);
  assert.ok(!/gh pr view/.test(r.stderr), `the PR was read before the argv was checked: ${r.stderr}`);
});

// ════════════════════════════════════════════════════════════════════════════
// A VERDICT SURVIVES A HEAD MOVE IT PROVABLY COVERS
//
// Binding the verdict to a head (the suites above) made a `base-merge` cost a
// full re-judgement even when it changed nothing at all. Measured on T-25-05:
// the same tree object, the same diff against the new base, and arch-review re-run
// anyway at ~150k tokens — 42% of that ticket's cost.
//
// The exception is a PROOF, not a tolerance, and it is two object identities:
//
//   1. the two heads resolve to the SAME tree, and
//   2. the tree of the NEW merge base equals the `base_tree=` the trailer
//      recorded when the verdict was rendered.
//
// Together they entail that the judged diff and the candidate diff are the same
// diff. Compared as OBJECTS rather than as diffs on purpose: a diff is a
// rendering that depends on rename detection, context size, whitespace and
// `diff.algorithm`, while two shas have no such surface (ADR-006 D2). The
// `base_tree` is recorded as a TREE and never as a branch name, because the old
// base branch gets reaped and a rule that recomputes `mergebase(<old base>, …)`
// dies with it.
//
// The refusals are written first and there are more of them than happy paths: a
// gate that fails OPEN is the failure this verb could introduce, and it would be
// invisible in the happy path.
// ════════════════════════════════════════════════════════════════════════════

const TREE_ZERO = '0000000000000000000000000000000000000000';

const g = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
};

// A REAL repository, because a carry is a claim about tree objects and there is
// no way to hand-build one. Three knobs, one per condition under test:
//
//   move: 'empty-commit'  a new sha over the same tree — the shape a base-merge
//                         that changed nothing produces, and the case a head-SHA
//                         comparison cannot tell from a real push.
//         'content'       the merge brought content: a different tree.
//   base: 'same'          the recorded base tree IS the new merge base's tree.
//         'whitespace'    the recorded tree differs from the new merge base's
//                         tree in trailing whitespace ONLY. Two distinct objects
//                         that `git diff -w` reports as identical — the case an
//                         object comparison and a diff comparison disagree on.
function carryRepo({ move = 'empty-commit', base = 'same' } = {}) {
  const repo = fs.mkdtempSync(path.join(W, 'carry-'));
  g(repo, ['init', '-q']);
  g(repo, ['config', 'user.email', 't@e']);
  g(repo, ['config', 'user.name', 'T']);
  const w = (rel, body) => fs.writeFileSync(path.join(repo, rel), body);

  w('a.txt', 'x\ny\n');
  g(repo, ['add', '.']);
  g(repo, ['commit', '-qm', 'c0']);
  const treeBefore = g(repo, ['rev-parse', 'HEAD^{tree}']);
  if (base === 'whitespace') {
    w('a.txt', 'x \ny\n');
    g(repo, ['commit', '-qam', 'a trailing space and nothing else']);
  }
  g(repo, ['branch', 'base']);

  g(repo, ['checkout', '-qb', 'child']);
  w('child.txt', 'child\n');
  g(repo, ['add', '.']);
  g(repo, ['commit', '-qm', 'child']);
  const from = g(repo, ['rev-parse', 'HEAD']);
  if (move === 'content') {
    w('child.txt', 'child+more\n');
    g(repo, ['commit', '-qam', 'more work, a different tree']);
  } else {
    g(repo, ['commit', '-q', '--allow-empty', '-m', 'a new sha over the same tree']);
  }
  const to = g(repo, ['rev-parse', 'HEAD']);

  return {
    repo,
    from,
    to,
    fromTree: g(repo, ['rev-parse', `${from}^{tree}`]),
    toTree: g(repo, ['rev-parse', `${to}^{tree}`]),
    // What the trailer recorded, and what the merge base is NOW. Equal unless
    // the fixture was asked for a base that moved.
    judgedBaseTree: base === 'whitespace' ? treeBefore : g(repo, ['rev-parse', 'base^{tree}']),
    newBaseTree: g(repo, ['rev-parse', 'base^{tree}']),
  };
}

const conformTrailerFor = (head, baseTree) => `${PREAMBLE}gate_status: arch-review=conform, `
  + `drift-check=fresh, degenerate-green=clean, checks=green`
  + `${baseTree ? `, base_tree=${baseTree}` : ''}, head=${head}`;

// The carry runner. `--worktree` is passed explicitly rather than relying on the
// cwd, because that is how base-merge.cjs calls it (an agent's cwd is its own
// worktree, which may not be the one being merged).
function carry(fixture, { body, headRefOid, baseRefName = 'base', args, from, to } = {}) {
  fs.writeFileSync(PRVIEW, JSON.stringify({
    number: 9,
    baseRefName,
    body: body === undefined ? conformTrailerFor(fixture.from, fixture.judgedBaseTree) : body,
    ...(headRefOid === null ? {} : { headRefOid: headRefOid || fixture.from }),
  }));
  try { fs.unlinkSync(EDIT); } catch { /* not written yet */ }
  const env = {
    ...process.env,
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    SHIPYARD_TRAILER_PRVIEW: PRVIEW,
    SHIPYARD_TRAILER_EDIT: EDIT,
  };
  const r = spawnSync(process.execPath, [TRAILER, ...(args || [
    'carry', 'T-01-01', '--pr', '9',
    '--from', from || fixture.from, '--to', to || fixture.to,
    '--worktree', fixture.repo, '--json',
  ])], { encoding: 'utf8', env });
  return { ...r, edited: fs.existsSync(EDIT) ? fs.readFileSync(EDIT, 'utf8') : null };
}

suite('gate-trailer write: base_tree records the base the verdict was rendered against');

test('parseGate reads base_tree, and a trailer without it parses as before', () => {
  const withIt = parseGate(`gate_status: arch-review=conform, base_tree=${SHA_B}, head=${SHA_A}`);
  assert.strictEqual(withIt.base_tree, SHA_B);
  assert.strictEqual(withIt.head, SHA_A);
  const without = parseGate(`gate_status: arch-review=conform, head=${SHA_A}`);
  assert.deepStrictEqual(without, { 'arch-review': 'conform', head: SHA_A });
  assert.ok(!('base_tree' in without), 'no key is invented for a trailer that records none');
  // And the reader is untouched by the new key in both directions.
  assert.strictEqual(gateConform(withIt, SHA_A), true);
  assert.strictEqual(gateKind(withIt, SHA_B), 'stale');
});

test('the writer records base_tree beside head when it is given one', () => {
  const r = writeTrailer({
    args: ['write', '9', '--arch-review', 'conform', '--drift-check', 'fresh',
      '--degenerate-green', 'clean', '--base-tree', SHA_B],
  });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = r.edited.split('\n').filter((l) => /^\s*gate_status:/i.test(l));
  assert.strictEqual(lines.length, 1, `expected one trailer, got:\n${r.edited}`);
  assert.ok(lines[0].includes(`base_tree=${SHA_B}`), lines[0]);
  assert.ok(lines[0].includes(`head=${SHA_A}`), lines[0]);
  assert.strictEqual(parseGate(r.edited).base_tree, SHA_B, 'the writer and the reader must agree');
});

test('--base-tree is optional, and its absence writes the trailer it wrote before', () => {
  // The one direction backwards compatibility runs in: the guard's pinned
  // invocation does not pass it yet, and must keep writing a trailer the readers
  // accept. What it must NOT do is invent a base_tree nobody measured.
  const r = writeTrailer();
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(!/base_tree/.test(r.edited), `a base_tree was invented:\n${r.edited}`);
  assert.strictEqual(gateConform(parseGate(r.edited), SHA_A), true);
});

test('an ABBREVIATED base_tree is rejected on write, not silently accepted', () => {
  // A reader cannot lengthen an abbreviation, and the carry compares object
  // identities — a seven-character value would make every comparison false while
  // looking like a recorded proof.
  for (const bad of [SHA_B.slice(0, 7), SHA_B.slice(0, 39), `${SHA_B}0`, 'not-a-tree', '']) {
    const r = writeTrailer({
      args: ['write', '9', '--arch-review', 'conform', '--drift-check', 'fresh',
        '--degenerate-green', 'clean', '--base-tree', bad],
    });
    assert.strictEqual(r.status, 2, `expected a usage refusal for "${bad}", got ${r.status}\n${r.stderr}`);
    assert.strictEqual(r.edited, null, `the PR body was edited anyway:\n${r.edited}`);
    assert.ok(/--base-tree/.test(r.stderr), r.stderr);
    assert.ok(/usage: /.test(r.stderr), r.stderr);
    // Refused for its VALUE, not because the flag is unknown. Without this the
    // whole case passes against a writer that has never heard of --base-tree,
    // which is what it looked like before the flag existed.
    assert.ok(!/unexpected argument/.test(r.stderr), `--base-tree is not accepted at all: ${r.stderr}`);
  }
});

test('--base-tree given twice is a duplicate like every other flag', () => {
  const r = writeTrailer({
    args: ['write', '9', '--arch-review', 'conform', '--drift-check', 'fresh',
      '--degenerate-green', 'clean', '--base-tree', SHA_A, '--base-tree', SHA_B],
  });
  assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/more than once|twice|duplicat/i.test(r.stderr), r.stderr);
});

suite('gate-trailer carry: the refusals, which are the whole of the safety');

test('a trailer with NO base_tree never carries — absent proof is not proof', () => {
  // The backwards-compatible direction, and the one a future reader will be
  // tempted to relax: everything else about this carry is provable, and the
  // answer is still no, because nothing can say which base was judged.
  const fx = carryRepo();
  const r = carry(fx, { body: conformTrailerFor(fx.from, null) });
  assert.strictEqual(r.status, 1, `expected a refusal, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null, `the trailer was rewritten anyway:\n${r.edited}`);
  // Refused FOR THE ABSENCE, in those words. Asserting merely that the message
  // mentions `base_tree` passed against a mutant that had deleted this check
  // entirely: the abbreviation check below caught the empty string and refused
  // with its own message, so the test was green while the rule was gone. The
  // two refusals must be distinguishable, or neither is pinned.
  assert.ok(/records no `base_tree=`/.test(r.stderr), r.stderr);
  assert.ok(/absent proof is not proof/.test(r.stderr), r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).carried, false, r.stdout);
});

test('an abbreviated base_tree in the trailer does not carry either', () => {
  const fx = carryRepo();
  const r = carry(fx, { body: conformTrailerFor(fx.from, fx.judgedBaseTree.slice(0, 7)) });
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  // Its OWN message, not the absent-proof one: an abbreviation is a recorded
  // value that cannot be compared, and a reader sent looking for a missing key
  // would go hunting in the wrong place.
  assert.ok(/full forty/.test(r.stderr), r.stderr);
  assert.ok(!/absent proof/.test(r.stderr), r.stderr);
});

test('the merge brought CONTENT: refused, with both tree shas in the message', () => {
  const fx = carryRepo({ move: 'content' });
  const r = carry(fx);
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null, `the trailer was rewritten anyway:\n${r.edited}`);
  assert.ok(r.stderr.includes(fx.fromTree), `the judged tree is not named: ${r.stderr}`);
  assert.ok(r.stderr.includes(fx.toTree), `the candidate tree is not named: ${r.stderr}`);
  assert.notStrictEqual(fx.fromTree, fx.toTree, 'the fixture must actually move the tree');
});

test('the BASE tree moved under an identical head tree: refused', () => {
  // The condition that makes this a proof rather than a heuristic. A retarget
  // moves the base under an unchanged tree, and the same code against a
  // different base is a different diff — measured on T-25-03, where one tree
  // showed 7 files against its own base and 12 against the epic.
  //
  // MUTATION NOTE. This fixture's two base trees differ in trailing whitespace
  // only, so `git diff -w` calls them identical while the objects differ. That is
  // deliberate: replace the object comparison with a whitespace-tolerant diff
  // comparison and this test is the one that fails. It is the disagreement the
  // acceptance criterion asks for — a rename does not produce one, because both
  // renderings of a rename are non-empty, while a whitespace-only difference
  // renders as no difference at all.
  const fx = carryRepo({ base: 'whitespace' });
  assert.notStrictEqual(fx.judgedBaseTree, fx.newBaseTree, 'the fixture must move the base tree');
  assert.strictEqual(fx.fromTree, fx.toTree, 'and it must NOT move the head tree');
  assert.strictEqual(
    spawnSync('git', ['-C', fx.repo, 'diff', '-w', '--quiet', fx.judgedBaseTree, fx.newBaseTree]).status, 0,
    'the fixture must be a case an object comparison and a diff comparison disagree on'
  );
  const r = carry(fx);
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(r.stderr.includes(fx.judgedBaseTree), `the judged base tree is not named: ${r.stderr}`);
  assert.ok(r.stderr.includes(fx.newBaseTree), `the new base tree is not named: ${r.stderr}`);
});

test('a trailer written for a THIRD head is not carried onto a fourth', () => {
  const fx = carryRepo();
  const r = carry(fx, { body: conformTrailerFor(SHA_B, fx.judgedBaseTree) });
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/def456d/.test(r.stderr), r.stderr);
});

test('a non-conform trailer has no verdict to carry', () => {
  const fx = carryRepo();
  const r = carry(fx, {
    body: `${PREAMBLE}gate_status: arch-review=violation, base_tree=${fx.judgedBaseTree}, head=${fx.from}`,
  });
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/arch-review=conform/.test(r.stderr), r.stderr);
});

test('a PR that has moved past the judged head is refused, not carried forward', () => {
  // The carry re-binds head=, so it must not re-bind onto a branch someone has
  // pushed to in the meantime: that push is unjudged content, and the trailer
  // being stale is the correct state.
  const fx = carryRepo();
  const r = carry(fx, { headRefOid: SHA_B });
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/def456d/.test(r.stderr), r.stderr);
});

test('a sha the repository does not have refuses rather than assuming', () => {
  const fx = carryRepo();
  const r = carry(fx, { to: TREE_ZERO });
  assert.strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.strictEqual(r.edited, null);
  assert.ok(/--to/.test(r.stderr), r.stderr);
});

test('a usage error is a usage error, and costs no PR read', () => {
  const fx = carryRepo();
  for (const [what, args, expected] of [
    ['no ticket', ['carry', '--pr', '9'], /ticket/],
    ['no --pr', ['carry', 'T-01-01', '--from', fx.from, '--to', fx.to], /--pr/],
    ['no --from', ['carry', 'T-01-01', '--pr', '9', '--to', fx.to], /--from/],
    ['an unknown flag', ['carry', 'T-01-01', '--pr', '9', '--from', fx.from, '--to', fx.to, '--basetree', 'x'], /--basetree/],
    ['a duplicate flag', ['carry', 'T-01-01', '--pr', '9', '--pr', '10', '--from', fx.from, '--to', fx.to], /more than once/],
    ['a flag with no value', ['carry', 'T-01-01', '--pr', '--from', fx.from, '--to', fx.to], /--pr needs a value/],
  ]) {
    const r = carry(fx, { args });
    assert.strictEqual(r.status, 2, `${what}: expected exit 2, got ${r.status}\n${r.stderr}`);
    assert.strictEqual(r.edited, null, `${what}: the PR body was edited anyway`);
    assert.ok(expected.test(r.stderr), `${what}: ${r.stderr}`);
    assert.ok(/usage: /.test(r.stderr), `${what}: a usage error must print the usage: ${r.stderr}`);
  }
});

suite('gate-trailer carry: what a proved carry writes, and what it refuses to claim');

test('the same tree under a new sha carries the verdict onto the new head', () => {
  // THE case. `from` and `to` are different commits with the same tree — which is
  // what a base-merge that resolved to the branch's own content produces, and
  // what a head-SHA comparison cannot tell from a real push.
  const fx = carryRepo();
  assert.notStrictEqual(fx.from, fx.to, 'the fixture must move the head sha');
  assert.strictEqual(fx.fromTree, fx.toTree, 'and must not move the tree');

  const r = carry(fx);
  assert.strictEqual(r.status, 0, `expected the carry to be proved\n${r.stdout}\n${r.stderr}`);
  const lines = r.edited.split('\n').filter((l) => /^\s*gate_status:/i.test(l));
  assert.strictEqual(lines.length, 1, `expected one trailer, got:\n${r.edited}`);
  assert.ok(r.edited.startsWith('Ticket: T-01-01'), `the body was not preserved:\n${r.edited}`);

  // The whole point, stated through the readers rather than through the text:
  // the verdict now counts for the NEW head and no longer for the old one.
  const gate = parseGate(r.edited);
  assert.strictEqual(gateConform(gate, fx.to), true, `the new head is not conform:\n${lines[0]}`);
  assert.strictEqual(gateKind(gate, fx.from), 'stale', 'the old head must no longer read conform');
  assert.strictEqual(gate.base_tree, fx.judgedBaseTree, 'the proof it was measured against is kept');
  assert.strictEqual(gate['drift-check'], 'fresh', 'every other recorded key survives');
  assert.strictEqual(gate.carried_from, fx.from, 'the head a judge actually read is recorded');
  assert.strictEqual(JSON.parse(r.stdout).carried, true, r.stdout);
});

test('checks=green NEVER carries — a green is measured by CI against a base', () => {
  // The merge commit is a new merge base, so CI has not built this commit and a
  // carried `checks=green` would be a claim about a build nobody ran. Dropping
  // the key is the mechanical form of that rule; nothing reads it, and the merge
  // gate asks live GitHub for the check state either way.
  const fx = carryRepo();
  const r = carry(fx);
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(
    conformTrailerFor(fx.from, fx.judgedBaseTree).includes('checks=green'),
    'the fixture body must carry a green to lose'
  );
  assert.ok(!/checks=/.test(r.edited), `a green was carried onto an unbuilt commit:\n${r.edited}`);
  assert.ok(!('checks' in parseGate(r.edited)), 'the reader must see no check claim at all');
});

test('a chain of carries keeps the head a judge actually read', () => {
  // Carry twice. `carried_from` must stay the FIRST head — the one whose diff a
  // judge looked at — or the audit trail says a verdict was rendered against a
  // commit nobody ever judged.
  const fx = carryRepo();
  const first = carry(fx);
  assert.strictEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);

  const third = g(fx.repo, ['rev-parse', 'HEAD']);
  g(fx.repo, ['commit', '-q', '--allow-empty', '-m', 'another sha over the same tree']);
  const fourth = g(fx.repo, ['rev-parse', 'HEAD']);
  const second = carry(fx, {
    body: first.edited, headRefOid: third, from: third, to: fourth,
  });
  assert.strictEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const gate = parseGate(second.edited);
  assert.strictEqual(gateConform(gate, fourth), true);
  assert.strictEqual(gate.carried_from, fx.from, 'the originally judged head must survive the chain');
});

done();
