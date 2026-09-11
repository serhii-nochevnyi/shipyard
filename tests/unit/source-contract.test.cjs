'use strict';

// Assertions about the SHAPE of our own source — the facts a behavioural test
// cannot reach because they are properties of the file rather than of a run.
//
// Each of the ones here was measured as unasserted. The first is a single
// argument that carries a whole mechanism: `state-sync.cjs` passes its
// `epicInfo` into `computeFront` as `epics`, and without it `leftBehind()` sees
// no epic records and answers 0 for every ticket. Deleting that one line left
// four suites green, because every unit test builds `epics` by hand and the
// sentinel smoke never asserts the count off a real sync. The failure direction
// is safe — the flag reads 0 and the stop gate blocks rather than hatching —
// which is precisely the shape this repo already knows costs it: a gate that
// quietly stops enforcing while looking healthy.
//
// The second is a byte. One NUL anywhere in a file makes `grep` classify the
// whole file as binary, and every grep over it then degrades SILENTLY rather
// than erroring — differently depending on HOW the reader's grep is invoked,
// which is the worst part, because it makes the verdict a property of the
// caller and not of the file. Measured on the mutant this test was written
// against — one 0x00 inserted into `front.cjs`, read with BSD grep
// 2.6.0-FreeBSD: `-n` and `-o` print "Binary file … matches" and not one
// matching line while still exiting 0, `-q` also exits 0, and under `-I`
// (skip binary files — what this machine's own `grep` wrapper passes, and what
// ripgrep-style tools do by default) `-q` exits 1 and `-c` prints nothing at
// all for a phrase the file plainly contains. So a contract written as
// `grep -q <phrase> <script>` either passes without having read a line or
// fails for a reason that has nothing to do with the phrase, and any pipeline
// that consumes matched LINES sees an empty result. This repository asserts
// exactly that way — `tests/smoke/docs-smoke.sh` is a grep contract — over
// exactly these directories, so a NUL in one of them hollows out the guards
// instead of breaking them. `grep -a` fixes one call site and must then be
// remembered at every future one, by everyone; refusing the byte fixes the
// class, and a printable composite-key separator keeps every collision
// guarantee a NUL had.
//
// The third is a shape git cannot see. Two branches of one cascade added a
// byte-identical `cleanup()` + `trap cleanup EXIT INT TERM` block to
// `epic-branch.sh` independently; the conveyor lands every ticket PR with
// `--squash`, so the two copies share no SHA and no ancestor commit carries
// the hunk. A 3-way merge compares against the merge BASE, and when the same
// hunk arrives on both sides after that base the only safe answer git has is
// "keep both". So the merge exited 0 with two definitions in the file, and in
// shell the second definition silently wins while the second trap replaces the
// first. `bash -n` accepts it — both copies are valid — which is why the smoke
// suite stayed green, and the ownership rule in `base-merge.cjs` could not
// help, because there was no conflict to own. A clean exit was used to answer
// "did this merge produce a coherent file", which it does not answer. It
// recurred on the very next base-merge of the same round, so the check is a
// SWEEP over every tracked shell script and not a list of the functions that
// happened to collide: a list is the shape T-27-07 replaced. Its two arms are
// asserted SEPARATELY below, because a one-armed implementation passes half
// the cases and looks exactly as green.
//
// The fourth is an identifier that must never appear at all: `transitionName`.
// Jira's MCP schema refuses it in a sentence — "Name of the transition itself,
// not the target status — the two often differ, so 'Done' does not match a
// transition named 'Review->Done'." — so a projector keyed on transition names
// works against the workflow it was written for and silently does nothing on
// the next one. It is a NEGATIVE pin, landed before the projector it guards,
// and "outside a comment" is defined PER FILE TYPE because getting that wrong
// is how a sweep goes quietly inert: `.cjs`/`.mjs`/`.sh` may name what they
// forbid on a comment line, while `.md` gets NO exemption — the command docs
// and `references/` files are the prompts an agent reads, and the Codex
// generator ships them verbatim, so a prompt that spells the identifier is
// exactly the defect. `.planning/` is outside the sweep, the same exclusion
// ADR-006 D7 gave the gsd-core pin and for the same reason: plans and ADRs
// must be able to name what they forbid.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const REPO = path.join(__dirname, '..', '..');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Tracked files only, and enumerated by git rather than by a directory walk: an
// untracked scratch copy of a script is not something we ship, and judging one
// would make the suite depend on whatever debris a worktree happens to hold.
const tracked = (...dirs) =>
  execFileSync('git', ['ls-files', '-z', '--', ...dirs], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

// Extract a call site by scanning for balanced parens from the first
// `name(` — tolerant of reformatting (single line, different indentation, a
// trailing comma) that a fixed-shape regex would break on. Only the first
// occurrence of `<name>(` is matched, which is enough here: `computeFront`'s
// only call syntax in state-sync.cjs is the real dispatch — every other
// mention is either a destructured import (`{ computeFront, ... }`, no `(`
// immediately after) or plain prose in a comment.
const extractCall = (src, name) => {
  const start = src.indexOf(`${name}(`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + name.length; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null; // unbalanced — never a valid call site
};

suite('source contract');

test('state-sync passes its epic records into computeFront', () => {
  const src = readRepo('plugins/delivery-pipeline/scripts/state-sync.cjs');
  // Assert the SHAPE of the contract — a field literally named `epics:`
  // reaching computeFront's options object — not the name of the local
  // variable that happens to hold it today. A rename of `epicInfo` that still
  // passes `epics: <whatever>` satisfies the contract and must not fail here;
  // only the call SITE is inspected, so a match elsewhere in the file (e.g. a
  // comment) cannot satisfy it either. The call site is located by balanced
  // parens (see extractCall above), not by a fixed line-break shape, so a
  // harmless reformat of the call (single line, different indentation, a
  // trailing comma) does not break this test.
  const call = extractCall(src, 'computeFront');
  assert.ok(call, 'expected to find the computeFront(tickets, state, { ... }) call in state-sync.cjs');
  // The real call site carries a block comment ahead of the `epics:` line (this
  // file explains every field it passes), so the KEY is not textually adjacent
  // to the preceding `{`/`,` — comments must be stripped before the object-shape
  // check below, or a harmless comment edit could flip this test independently
  // of the actual code. Line and block comments only; this file's call sites
  // contain no string literal with `//` or `/*` in it, so a full tokenizer is
  // not needed here.
  const stripped = call.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // The key's PRESENCE is the contract, not the shape of its value: `epics:
  // epicInfo`, `epics: epicInfo ?? []`, `epics: epicInfo.map(...)` and the
  // shorthand `{ epics }` all satisfy it alike, so the match must not require a
  // bare-identifier value the way `/epics:\s*\w+/` did — that failed a harmless
  // refactor to any of the forms above even though the field still reached
  // computeFront. Matched only where `epics` is an object-literal KEY
  // (immediately preceded by `{` or `,` once comments are stripped), so a
  // `foo: epics` local, or a comment mentioning "epics", cannot satisfy it by
  // accident.
  assert.ok(
    /[{,]\s*epics\s*(?::|(?=[\s,}]))/.test(stripped),
    'state-sync.cjs must pass an `epics` field into computeFront — without it leftBehind() sees no epic records and every left_behind count reads 0'
  );
});

test('no script in the deterministic layer contains a NUL byte', () => {
  const files = tracked(
    'plugins/delivery-pipeline/scripts',
    'capabilities/delivery-pipeline/checks',
    'scripts'
  );
  // A raw count is an arbitrary threshold that drifts as the deterministic
  // layer grows or gets consolidated — asserting that a specific, always-
  // present script actually came back is a stable check that a broken sweep
  // (wrong cwd, wrong paths, `git ls-files` returning nothing) still catches,
  // without needing an edit every time the file count moves.
  assert.ok(
    files.includes('plugins/delivery-pipeline/scripts/front.cjs'),
    `expected the deterministic-layer sweep to include plugins/delivery-pipeline/scripts/front.cjs, git listed ${files.length} files total: ${files.join(', ')}`
  );
  const binary = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(REPO, rel));
    const at = buf.indexOf(0);
    if (at >= 0) binary.push(`${rel} (byte 0x00 at offset ${at})`);
  }
  assert.strictEqual(
    binary.length, 0,
    `these scripts are binary to grep, so every grep contract over them degrades silently — no lines printed, and a \`grep -q\` answer that depends on the grep:\n  ${binary.join('\n  ')}`
  );
});

// ── The duplicate-definition sweep ───────────────────────────────────────────
//
// Two arms, and they are independent: a duplicated function name, and more than
// one top-level `trap` line. Column 0 on purpose for both. A shell function is
// defined at the left margin in every script we ship, while an INDENTED `trap`
// inside a function or a subshell is a legitimate pattern that may sit beside a
// top-level one — anchoring at the margin keeps that from reading as a defect.
const duplicateDefinitions = (src) => {
  const fnLines = new Map();
  const trapLines = [];
  src.split('\n').forEach((line, i) => {
    const m = /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)/.exec(line);
    if (m) {
      if (!fnLines.has(m[1])) fnLines.set(m[1], []);
      fnLines.get(m[1]).push(i + 1);
    }
    if (/^trap /.test(line)) trapLines.push(i + 1);
  });
  return {
    functions: [...fnLines.entries()]
      .filter(([, at]) => at.length > 1)
      .map(([name, at]) => ({ name, lines: at })),
    traps: trapLines.length > 1 ? trapLines : [],
  };
};

// One finding per arm, phrased so the reader can open the file at the line. The
// function arm NAMES THE FUNCTION: "epic-branch.sh has a duplicate" sends the
// reader hunting through 400 lines, which is how a finding gets ignored.
const findingsIn = (rel, src) => {
  const dup = duplicateDefinitions(src);
  return [
    ...dup.functions.map(
      (f) => `${rel}: ${f.name}() is defined ${f.lines.length} times (lines ${f.lines.join(', ')}) — in shell the last definition silently wins`
    ),
    ...(dup.traps.length
      ? [`${rel}: ${dup.traps.length} top-level \`trap\` lines (${dup.traps.join(', ')}) — the last one replaces the others, so the earlier handlers never run`]
      : []),
  ];
};

// The same code path over the live tree and over the fixtures below: a detector
// exercised only on fixtures guards nothing, and one exercised only on the live
// tree states no subject of its own.
const sweep = (root, rels) =>
  rels.flatMap((rel) => findingsIn(rel, fs.readFileSync(path.join(root, rel), 'utf8')));

// The same file set `tests/unit/run.sh` runs `bash -n` over. That is the
// justification for the set rather than a taste: this sweep is the check
// `bash -n` cannot make — both copies of a duplicated block parse — over exactly
// the files `bash -n` already sees.
const trackedShell = () =>
  tracked(
    'plugins/delivery-pipeline/scripts',
    'capabilities/delivery-pipeline/checks',
    'scripts',
    'tests/smoke',
    'tests/unit'
  ).filter((rel) => rel.endsWith('.sh'));

const fixture = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-srccontract-'));
  fs.writeFileSync(path.join(dir, name), body);
  return dir;
};

// The real block, verbatim in shape: a `cleanup()` that releases the git lock
// plus its trap. Duplicating exactly this is what a base-merge produced twice in
// one guard round.
const CLEANUP_BLOCK = [
  'cleanup() {',
  '  local st=$?',
  '  set +e',
  '  $lock_held && rm -rf "$git_lock"',
  '  return $st',
  '}',
  'trap cleanup EXIT INT TERM',
].join('\n');

test('no tracked shell script defines a function twice or sets a second top-level trap', () => {
  const files = trackedShell();
  // The anchor is the file the real duplication landed in — a broken sweep
  // (wrong cwd, wrong paths, `git ls-files` returning nothing) sweeps zero files
  // and reports zero findings, which is indistinguishable from a clean tree.
  assert.ok(
    files.includes('plugins/delivery-pipeline/scripts/epic-branch.sh'),
    `expected the shell sweep to include plugins/delivery-pipeline/scripts/epic-branch.sh, git listed ${files.length} shell files: ${files.join(', ')}`
  );
  const findings = sweep(REPO, files);
  assert.strictEqual(
    findings.length, 0,
    `a squash-merged cascade can add the same block twice with no conflict, and neither git nor \`bash -n\` says a word:\n  ${findings.join('\n  ')}`
  );
});

test('two definitions of one function are a finding, named by file and by function', () => {
  const dir = fixture('dup-fn.sh', [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cleanup() {',
    '  rm -rf "$tmp"',
    '}',
    'work() { :; }',
    'cleanup() {',
    '  rm -rf "$tmp"',
    '}',
    'work',
    '',
  ].join('\n'));
  const file = path.join(dir, 'dup-fn.sh');
  // Half of the defect: the file is VALID shell. `bash -n` passing is not a
  // second opinion here, it is the reason this test has to exist.
  execFileSync('bash', ['-n', file]);
  const findings = sweep(dir, ['dup-fn.sh']);
  assert.strictEqual(findings.length, 1, `expected exactly the duplicated cleanup(), got:\n  ${findings.join('\n  ')}`);
  assert.ok(/dup-fn\.sh/.test(findings[0]), `the finding must name the file: ${findings[0]}`);
  assert.ok(/cleanup\(\)/.test(findings[0]), `the finding must name the function: ${findings[0]}`);
  assert.ok(/\b3\b/.test(findings[0]) && /\b7\b/.test(findings[0]), `the finding must name both lines: ${findings[0]}`);
  // `work()` is defined once and must not be dragged in.
  assert.ok(!/work/.test(findings[0]), `only the duplicated function is a finding: ${findings[0]}`);
});

test('a second top-level trap is a finding on its own, with no function duplicated', () => {
  const dir = fixture('dup-trap.sh', [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'trap "rm -rf $tmp" EXIT',
    'inner() {',
    '  trap - INT',   // indented: legitimate, and must not count
    '}',
    'trap "echo bye" EXIT',
    '',
  ].join('\n'));
  execFileSync('bash', ['-n', path.join(dir, 'dup-trap.sh')]);
  const findings = sweep(dir, ['dup-trap.sh']);
  // Asserted SEPARATELY from the function arm: the mutation that deletes this
  // arm leaves the function case green, so a single combined assertion over a
  // fixture carrying both would report a passing sweep with one arm missing.
  assert.strictEqual(findings.length, 1, `expected exactly the second trap, got:\n  ${findings.join('\n  ')}`);
  assert.ok(/trap/.test(findings[0]), `the finding must say which arm fired: ${findings[0]}`);
  assert.ok(/\b3\b/.test(findings[0]) && /\b7\b/.test(findings[0]), `the finding must name both trap lines (3 and 7), not the indented one: ${findings[0]}`);
  assert.ok(!/\b5\b/.test(findings[0]), `an indented trap inside a function is not a top-level handler: ${findings[0]}`);
  assert.strictEqual(
    duplicateDefinitions(fs.readFileSync(path.join(dir, 'dup-trap.sh'), 'utf8')).functions.length, 0,
    'the trap arm must fire with no function duplicated — otherwise this fixture is testing the other arm'
  );
});

test('the epic/27 duplication reproduces as a fixture and is caught on both arms', () => {
  const dir = fixture('epic-branch.sh', [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'lock_held=false',
    'git_lock=/tmp/lock',
    CLEANUP_BLOCK,
    // What the base-merge kept: the same block again, byte for byte, with no
    // conflict, because a squash merge left git no evidence the two hunks are
    // one change.
    CLEANUP_BLOCK,
    'echo work',
    '',
  ].join('\n'));
  execFileSync('bash', ['-n', path.join(dir, 'epic-branch.sh')]);
  const findings = sweep(dir, ['epic-branch.sh']);
  assert.strictEqual(findings.length, 2, `both arms fire on the real case, got:\n  ${findings.join('\n  ')}`);
  assert.ok(findings.some((f) => /cleanup\(\)/.test(f)), `the duplicated function must be named:\n  ${findings.join('\n  ')}`);
  assert.ok(findings.some((f) => /trap/.test(f)), `the duplicated trap must be named:\n  ${findings.join('\n  ')}`);
});

// ── The negative pin: a transition NAME is never a target status ─────────────
//
// See the fourth header paragraph for WHY. The rule this code implements, said
// once here so a reader never has to infer it from the regexes:
//
//   .cjs / .mjs — exempt on a line whose first non-space is `//` or `/*`
//   .sh         — exempt on a line whose first non-space is `#`
//   everything else (.md, .json, and any extension added later) — NO exemption
//
// Fail-closed on the default is the whole point: markdown has no comment form
// an agent does not read, and a new file type must be reasoned about here
// rather than exempted by silence. Note this deliberately does NOT reuse the
// model-id sweep's single COMMENT regex — that one treats `#` and `>` as
// comments in every file type, which would exempt a markdown heading and a
// blockquote and hand the md arm back its exemption.
//
// A bare `*` is NOT a comment opener here, even though it continues a JSDoc
// block: `workflows/*.mjs` build agent prompts as template literals, so a
// markdown bullet inside one (`  * transition it with …`) starts with `*` and
// would be exempted — a prompt spelling the identifier, which is exactly the
// defect the md arm exists to catch, arriving through the second prompt
// channel. An inner line of a `/* … */` block loses its exemption as a result,
// which is the fail-closed direction and costs nothing: no swept file names
// the identifier at all.
const COMMENT_FORMS = {
  '.cjs': /^\s*(?:\/\/|\/\*)/,
  '.mjs': /^\s*(?:\/\/|\/\*)/,
  '.sh': /^\s*#/,
};

// One constant, so pointing the sweep at something that does not exist — the
// mutation that proves the non-empty assertion still bites — is a one-token
// edit rather than a rewrite of the test.
const SWEPT_DIRS = ['plugins/delivery-pipeline', 'scripts'];

// The identifier itself, and only it. `transition.id` / `transitionId` are the
// CORRECT arguments — the id is the only one both connected MCP variants take —
// so they are not matched here.
const TRANSITION_NAME = /transitionName/;

// The MCP's own words, carried into the failure message: a match without the
// reason sends the reader to a rename, and a rename is not the fix.
const SCHEMA_SENTENCE =
  "the MCP schema says \"Name of the transition itself, not the target status — the two often differ, so 'Done' does not match a transition named 'Review->Done'\", so a projector keyed on transition names works against the workflow it was written for and silently does nothing on the next one";

// Tracked-file paths in, findings out — the same code path over the live tree
// and over the fixture below, for the reason the shell sweep states above.
const transitionNameOffenders = (root, rels) => {
  const offenders = [];
  for (const rel of rels) {
    const exempt = COMMENT_FORMS[path.extname(rel)];
    fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      if (!TRANSITION_NAME.test(line)) return;
      if (exempt && exempt.test(line)) return;
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return offenders;
};

test('`transitionName` appears in no script and no prompt we ship', () => {
  const files = tracked(...SWEPT_DIRS);
  // TWO anchors, one per swept dir. `git ls-files -- a b` with one pathspec
  // pointing at nothing still returns the other's files, so a single anchor
  // cannot tell a half-resolved sweep from a whole one. The markdown anchor is
  // the deliberate half: the md arm is what goes inert if someone ever narrows
  // this sweep to code files, and the prompts are where the defect would ship.
  for (const anchor of [
    'plugins/delivery-pipeline/commands/deliver.md',
    'scripts/gen-codex-shipyard.cjs',
  ]) {
    assert.ok(
      files.includes(anchor),
      `expected the transitionName sweep to include ${anchor}; git listed ${files.length} files under ${SWEPT_DIRS.join(', ')} — a sweep that certifies whatever it is pointed at is worse than no sweep`
    );
  }
  const offenders = transitionNameOffenders(REPO, files);
  assert.strictEqual(
    offenders.length, 0,
    `a transition NAME is never a target status — ${SCHEMA_SENTENCE}. Resolve the id through getTransitionsForJiraIssue instead:\n  ${offenders.join('\n  ')}`
  );
});

const VERIFICATION_RULE = 'Every checkable claim about the codebase, a test, delivery state, or a completed action must name the exact command that checked it and the relevant path, output, or exit status';
const VERIFICATION_EVIDENCE = 'A claim without command-backed evidence is not verification';
const ROLE_REFERENCES = [
  'plugins/delivery-pipeline/references/arch-review.md',
  'plugins/delivery-pipeline/references/ci-fix.md',
  'plugins/delivery-pipeline/references/drift-check.md',
  'plugins/delivery-pipeline/references/integrator.md',
  'plugins/delivery-pipeline/references/inv-research.md',
  'plugins/delivery-pipeline/references/pr-sentinel.md',
  'plugins/delivery-pipeline/references/review-fix.md',
];
const PROMPT_BUILDERS = [
  'plugins/delivery-pipeline/workflows/executors.mjs',
  'plugins/delivery-pipeline/workflows/drift-gate.mjs',
  'plugins/delivery-pipeline/workflows/fix-round.mjs',
];
const normalized = (src) => src.replace(/\s+/g, ' ').toLowerCase();

test('command-backed verification rule reaches every delivery boundary', () => {
  const canonical = readRepo('plugins/delivery-pipeline/skills/delivery-rules/SKILL.md');
  assert.ok(canonical.includes('## Rule zero: make claims executable'), 'the canonical delivery rules must define rule zero');
  assert.ok(normalized(canonical).includes(normalized(VERIFICATION_RULE)), 'the canonical delivery rules must state the exact-command requirement');
  assert.ok(normalized(canonical).includes(normalized(VERIFICATION_EVIDENCE)), 'the canonical delivery rules must reject claims without evidence');

  for (const rel of ROLE_REFERENCES) {
    const src = readRepo(rel);
    assert.ok(src.includes('## Verification contract'), `${rel} must carry the verification contract for direct role dispatch`);
    assert.ok(normalized(src).includes(normalized(VERIFICATION_RULE)), `${rel} must require the exact command for every checkable claim`);
    assert.ok(normalized(src).includes(normalized(VERIFICATION_EVIDENCE)), `${rel} must reject claims without command-backed evidence`);
  }

  for (const rel of PROMPT_BUILDERS) {
    const src = readRepo(rel);
    assert.ok(src.includes('agent('), `${rel} must retain its agent dispatch caller`);
    assert.ok(src.includes('Rule zero:'), `${rel} must repeat rule zero because its prompt bypasses the role document`);
    assert.ok(normalized(src).includes(normalized(VERIFICATION_RULE)), `${rel} must pass the exact-command requirement into its prompt`);
    assert.ok(normalized(src).includes(normalized(VERIFICATION_EVIDENCE)), `${rel} must pass the evidence requirement into its prompt`);
  }

  const arch = readRepo('plugins/delivery-pipeline/references/arch-review.md');
  assert.ok(/unverified checkable claim as a `violation`/.test(arch), 'arch-review must turn an unverified claim into a violation');
  assert.ok(/missing command:/.test(arch), 'arch-review violations must name the missing command');

  const drift = readRepo('plugins/delivery-pipeline/workflows/drift-gate.mjs');
  assert.ok(/required: \['id', 'verdict', 'moved', 'reuse_candidates', 'evidence'\]/.test(drift), 'drift-gate must require its evidence channel');
  assert.ok(/evidence:\s*\{/.test(drift), 'drift-gate must expose evidence in the result schema');
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflowArgs = {
  executors: {
    tickets: [{ id: 'T-30-01', planPath: '/p/30-01-PLAN.md', branch: 'ticket/T-30-01', prBase: 'epic/30', worktreePath: '/w/T-30-01' }],
  },
  'drift-gate': {
    tickets: [{ id: 'T-30-01', planPath: '/p/30-01-PLAN.md', baseRef: 'origin/epic/30' }],
    driftRefPath: '/p/drift-check.md',
  },
  'fix-round': {
    prs: [{ id: 'T-30-01', pr: 109, branch: 'ticket/T-30-01', worktreePath: '/w/T-30-01', planPath: '/p/30-01-PLAN.md', needsCiFix: true, needsReviewFix: false }],
    ciFixRefPath: '/p/ci-fix.md',
    reviewFixRefPath: '/p/review-fix.md',
    reinitScript: '/p/reviewers.cjs',
  },
};

async function renderedPrompt(name) {
  const source = readRepo(`plugins/delivery-pipeline/workflows/${name}.mjs`)
    .replace(/^export const meta/m, 'const meta');
  const calls = [];
  const agent = async (prompt) => {
    calls.push(prompt);
    if (name === 'executors') return { id: 'T-30-01', status: 'blocked', summary: 'test' };
    if (name === 'drift-gate') return { id: 'T-30-01', verdict: 'fresh', moved: [], reuse_candidates: [], evidence: ['git status --short — /repo — exit 0'] };
    return { id: 'T-30-01', pr: 109, pushed: false, status: 'no-op', notes: '', hypothesis: 'none' };
  };
  const parallel = async (thunks) => Promise.all(thunks.map((thunk) => thunk()));
  await new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', source)(agent, parallel, () => {}, () => {}, workflowArgs[name]);
  assert.strictEqual(calls.length, 1, `${name} must dispatch one prompt in the rendered-contract fixture`);
  return calls[0];
}

test('the runtime-rendered prompt carries command-backed evidence requirements', async () => {
  for (const name of PROMPT_BUILDERS) {
    const workflow = name.split('/').pop().replace(/\.mjs$/, '');
    const prompt = await renderedPrompt(workflow);
    assert.ok(normalized(prompt).includes(normalized(VERIFICATION_RULE)), `${workflow} runtime prompt must carry the complete command/evidence rule`);
    assert.ok(normalized(prompt).includes(normalized(VERIFICATION_EVIDENCE)), `${workflow} runtime prompt must carry the no-evidence prohibition`);
  }
});

test('the comment exemption is per file type — and markdown gets none', () => {
  const dir = fixture('code.cjs', [
    "// transitionName is what this file must never call — naming it is fine",
    "const ok = { transition: { id } };",
    "callIt({ transitionName: 'Done' });",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'hook.sh'), [
    '#!/usr/bin/env bash',
    '# transitionName is banned; a comment may say so',
    'echo "$transitionName"',
    '',
  ].join('\n'));
  // Markdown's nearest thing to a comment, and the whole reason the md arm has
  // no exemption: an agent reads an HTML comment in a prompt exactly like prose.
  fs.writeFileSync(path.join(dir, 'prompt.md'), [
    '# Deliver',
    '<!-- transitionName -->',
    '',
  ].join('\n'));
  const offenders = transitionNameOffenders(dir, ['code.cjs', 'hook.sh', 'prompt.md']);
  assert.deepStrictEqual(
    offenders.sort(),
    [
      "code.cjs:3: callIt({ transitionName: 'Done' });",
      'hook.sh:3: echo "$transitionName"',
      'prompt.md:2: <!-- transitionName -->',
    ].sort(),
    'exactly the three uncommented occurrences are findings — the two comment lines are not'
  );
});

done();
