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
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { codexStaticVariants } = require('../../plugins/delivery-pipeline/scripts/gsd-tune.cjs');
const pipelineConfig = require('../../plugins/delivery-pipeline/scripts/pipeline-config.cjs');
const rollout = require('../../plugins/delivery-pipeline/scripts/run-rollout.cjs');
const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createDurableRecorder } = boundaryModule;
const { createCodexDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
const {
  CLAUDE_MODEL_ALIASES,
  createClaudeDispatchAdapter,
  createClaudeWorkflowDispatch,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');

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
  assert.ok(!/recorded:\s*\{/.test(drift), 'drift-gate must not accept an agent-owned recorded status');
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sourceDispatchStore = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-source-contract-dispatch-'));
const sourceDispatchRecorder = createDurableRecorder(sourceDispatchStore);
const sourceDispatchCapabilities = Object.freeze({
  supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
  supportedEfforts: ['high', 'medium', 'max'],
  observedModel: false,
  observedEffort: false,
});
const sourceHostEvidence = new WeakMap();
let sourceLaunch = 0;
const sourceApplicationEvidence = ({ result }) => {
  const evidence = sourceHostEvidence.get(result);
  if (!evidence) throw new Error('test Claude host returned no application evidence');
  return evidence;
};
const sourceArtifactConsumer = ({ artifact, result, record }) => {
  const role = artifact && artifact.role;
  const ticket = artifact && artifact.ticket ? artifact.ticket : record.ticket;
  const evidenceIndex = {
    path: role === 'drift-check'
      ? '.shipyard-drift-evidence.md'
      : '.shipyard-repair-evidence.md',
    bytes: 0,
    content_bytes: 0,
    sha256: '0'.repeat(64),
    digest: '0'.repeat(64),
  };
  const findingsIndex = {
    path: `.shipyard-role-artifacts/${record.receipt.dispatch_id}/findings.json`,
    bytes: 0,
    content_bytes: 0,
    sha256: '0'.repeat(64),
    digest: '0'.repeat(64),
  };
  const envelope = role === 'drift-check'
    ? {
        schema: 'shipyard.drift-result.v1',
        version: 1,
        role,
        ticket,
        subject: ticket,
        verdict: result.verdict || 'fresh',
        moved_count: Array.isArray(result.moved) ? result.moved.length : 0,
        reuse_candidates_count: Array.isArray(result.reuse_candidates) ? result.reuse_candidates.length : 0,
        evidence_count: Array.isArray(result.evidence) ? result.evidence.length : 0,
        summary: '',
        evidence_index: evidenceIndex,
        evidence_index_ref: evidenceIndex,
        findings_index: findingsIndex,
        findings_index_ref: findingsIndex,
      }
    : {
        schema: 'shipyard.repair-result.v1',
        version: 1,
        role,
        ticket,
        subject: ticket,
        pr: artifact.pr || result.pr || 1,
        status: result.status || 'escalate',
        pushed: typeof result.pushed === 'boolean' ? result.pushed : false,
        summary: typeof result.notes === 'string' && result.notes.trim() ? result.notes.slice(0, 500) : 'test repair summary',
        notes: typeof result.notes === 'string' && result.notes.trim() ? result.notes.slice(0, 500) : 'test repair notes',
        hypothesis: typeof result.hypothesis === 'string' ? result.hypothesis.slice(0, 500) : 'test hypothesis',
        evidence_index: evidenceIndex,
        evidence_index_ref: evidenceIndex,
        findings_index: findingsIndex,
        findings_index_ref: findingsIndex,
      };
  return {
    schema: 'shipyard.role-artifact.v1',
    artifact_ref: `/source-contract/${ticket}/.shipyard-role-artifact.json`,
    artifact_path: `/source-contract/${ticket}/.shipyard-role-artifact.json`,
    artifact_digest: '1'.repeat(64),
    envelope,
    evidence_index: evidenceIndex,
    findings_index: findingsIndex,
  };
};
const sourceDispatchFactory = (options) => createClaudeWorkflowDispatch({
  ...options,
  capabilities: options.capabilities === undefined ? sourceDispatchCapabilities : options.capabilities,
  recorder: options.recorder === undefined ? sourceDispatchRecorder : options.recorder,
  applicationEvidence: options.applicationEvidence === undefined
    ? sourceApplicationEvidence
    : options.applicationEvidence,
  artifactConsumer: options.artifactConsumer === undefined
    ? sourceArtifactConsumer
    : options.artifactConsumer,
});
process.on('exit', () => {
  try { fs.rmSync(sourceDispatchStore, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
const workflowArgs = {
  executors: {
    tickets: [{ id: 'T-30-01', planPath: '/p/30-01-PLAN.md', branch: 'ticket/T-30-01', prBase: 'epic/30', worktreePath: '/w/T-30-01', model: 'sonnet', effort: 'max' }],
  },
  'drift-gate': {
    tickets: [{ id: 'T-30-01', planPath: '/p/30-01-PLAN.md', baseRef: 'origin/epic/30', worktreePath: '/w/T-30-01', model: 'opus', effort: 'max' }],
    driftRefPath: '/p/drift-check.md',
  },
  'fix-round': {
    prs: [{ id: 'T-30-01', pr: 109, branch: 'ticket/T-30-01', base: 'epic/30', worktreePath: '/w/T-30-01', planPath: '/p/30-01-PLAN.md', needsCiFix: true, needsReviewFix: false, model: 'opus', effort: 'medium' }],
    ciFixRefPath: '/p/ci-fix.md',
    reviewFixRefPath: '/p/review-fix.md',
    reinitScript: '/p/reviewers.cjs',
  },
};

async function renderedPrompt(name) {
  const source = readRepo(`plugins/delivery-pipeline/workflows/${name}.mjs`)
    .replace(/^export const meta/m, 'const meta');
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const result = name === 'executors'
      ? { id: 'T-30-01', status: 'blocked', summary: 'test' }
      : name === 'drift-gate'
        ? { id: 'T-30-01', verdict: 'fresh', moved: [], reuse_candidates: [], evidence: ['git status --short — /repo — exit 0'] }
        : { id: 'T-30-01', pr: 109, pushed: false, status: 'no-op', notes: '', hypothesis: 'none' };
    sourceHostEvidence.set(result, {
      launch_id: `test-source-launch-${++sourceLaunch}`,
      applied_model: opts.model,
      applied_effort: opts.effort,
    });
    return result;
  };
  const parallel = async (thunks) => Promise.all(thunks.map((thunk) => thunk()));
  await new AsyncFunction(
    'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source
  )(agent, parallel, () => {}, () => {}, workflowArgs[name], sourceDispatchFactory);
  assert.strictEqual(calls.length, 1, `${name} must dispatch one prompt in the rendered-contract fixture`);
  const expectedSelection = {
    executors: { model: 'sonnet', effort: 'max' },
    'drift-gate': { model: 'opus', effort: 'max' },
    'fix-round': { model: 'opus', effort: 'medium' },
  }[name];
  assert.deepStrictEqual(
    { model: calls[0].opts.model, effort: calls[0].opts.effort },
    expectedSelection,
    `${name} must pass caller-resolved model and effort into its callback`
  );
  return calls[0].prompt;
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

// ── ADR-014 is the only GSD launch path ─────────────────────────────────────
//
// These are source-contract tests because the failure this ticket closes is a
// launch shape: the GSD coordinator can look successful while its researcher,
// planner, or checker was spawned by a generic/inherited path. The fixtures
// below use the real runtime adapters and boundary, so the assertions cover
// the selection and receipt fields those adapters currently enforce without
// contacting either runtime. The typed callback and its host-owned receipt
// attestation are part of the executable contract; context.gsd_role, agentType,
// or self-asserted evidence alone never count as proof.
const dispatchResolution = (runtime, role, signals, dispatchId) =>
  policy.resolveDispatch({ runtime, role, signals, dispatch_id: dispatchId });

const capabilitiesFor = (resolutions) => ({
  supportedModels: [...new Set(resolutions.map((resolution) => resolution.model))],
  supportedEfforts: [...new Set(resolutions.map((resolution) => resolution.effort))],
  supportedSelections: resolutions.map((resolution) => ({
    model: resolution.model,
    effort: resolution.effort,
  })),
});

const expectCode = (fn, code) => {
  assert.throws(
    fn,
    (error) => error && error.code === code,
    `expected dispatch refusal ${code}`
  );
};

const applicationEvidence = (selection, launchId, effort = selection.effort, extra = {}) => ({
  launch_id: launchId,
  applied_model: selection.model,
  applied_effort: effort,
  observed_model: selection.model,
  observed_effort: effort,
  ...extra,
});

const codexApplicationEvidence = (selection, launchId, extra = {}) => applicationEvidence(
  { model: selection.model, effort: selection.reasoning_effort },
  launchId,
  selection.reasoning_effort,
  extra,
);

function writeGeneratedResearchAgent(agentsDir, resolution) {
  const content = [
    `# shipyard-policy-id = "${policy.POLICY.id}"`,
    `# shipyard-policy-version = "${resolution.policy_version}"`,
    `# shipyard-policy-hash = "${resolution.policy_hash}"`,
    '# shipyard-policy-runtime = "codex"',
    `# shipyard-policy-role = "${resolution.role}"`,
    `# shipyard-policy-rung = "${resolution.rung}"`,
    `name = "${resolution.agent_file.replace(/\.toml$/, '')}"`,
    `model = "${resolution.model}"`,
    `model_reasoning_effort = "${resolution.effort}"`,
    "developer_instructions = '''\nagent\n'''",
    '',
  ].join('\n');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, resolution.agent_file), content);
  fs.writeFileSync(path.join(agentsDir, '.shipyard-manifest.json'), JSON.stringify({
    policy_id: policy.POLICY.id,
    policy_version: resolution.policy_version,
    policy_hash: resolution.policy_hash,
    agent_files: [resolution.agent_file],
    agent_digests: {
      [resolution.agent_file]: crypto.createHash('sha256').update(content).digest('hex'),
    },
  }) + '\n');
}

test('decompose documents the three explicit boundary dispatches and refusal rules', () => {
  const source = readRepo('plugins/delivery-pipeline/commands/decompose.md');
  const boundarySection = source.slice(
    source.indexOf('## Step 0.5 — Mandatory GSD runtime dispatch'),
    source.indexOf('## Step 1 — Clarify the mode and the ticket size')
  );
  for (const phrase of [
    'createDispatchBoundary',
    'createCodexDispatchAdapter',
    'createClaudeDispatchAdapter',
    'createDurableRecorder',
    'requireGsdRole',
    'boundary.dispatch',
    'pipelineConfig.resolveDispatch',
    'Before every researcher, planner, or checker callback',
    'configuration-free fallback',
    'gsd-phase-researcher',
    'gsd-planner',
    'gsd-plan-checker',
    'Sol/high',
    'Sol/xhigh',
    'receipt.compliance',
    'generic-agent',
    'inherited',
    'pipeline-config.cjs',
    'resolveDispatch',
    'pipeline.fable: auto',
    'context.gsd_role',
    'agentType',
    'agent_type',
    'launchTypedGsd',
    'typedGsdCallback',
    'gsd_launch_mechanism',
    'source-contract fixtures exercise',
  ]) {
    assert.ok(boundarySection.includes(phrase), `decompose.md must state the boundary contract: ${phrase}`);
  }
  assert.ok(/direct\s+inline/.test(boundarySection), 'decompose.md must refuse direct inline launches');
  for (const phrase of [
    '**Codex runtime — logical model ladder**',
    '**Workflow-native alias runtime — native alias ladder**',
    'opus/medium',
    'opus/max',
  ]) {
    assert.ok(source.includes(phrase), `decompose.md must state the runtime-specific ladder: ${phrase}`);
  }
  for (const phrase of ['role: research', 'role: decomposition']) {
    assert.ok(source.includes(phrase), `decompose.md must route the GSD role explicitly: ${phrase}`);
  }
  assert.ok(
    !boundarySection.includes('"model_profile"') && !boundarySection.includes('"models"'),
    'GSD model profiles and model maps must not be launch authority'
  );
  assert.ok(
    normalized(source).includes(normalized('If GSD, the Skill, callback wiring, or the durable recorder is unavailable, refuse before launching'))
      && normalized(source).includes(normalized('do not run the Skill opaquely')),
    'an opaque GSD Skill invocation must be refused'
  );
  assert.ok(normalized(source).includes(normalized('do not prompt the user to run an external command')), 'Skill fallback must not escape the receipt boundary');
  assert.ok(normalized(source).includes(normalized('there is no receipt-bound decomposition fallback')), 'missing receipts must fail closed');
});

test('the documented GSD boundary call selects typed callbacks and refuses a missing role', () => {
  const cases = [
    { runtime: 'codex', role: 'decomposition', gsd_role: 'gsd-planner' },
    { runtime: 'claude', role: 'decomposition', gsd_role: 'gsd-planner' },
  ];

  for (const item of cases) {
    const resolution = dispatchResolution(item.runtime, item.role, {}, `documented-${item.runtime}`);
    const calls = [];
    const application = item.runtime === 'codex'
      ? codexApplicationEvidence
      : (selection, launchId, extra = {}) => applicationEvidence(selection, launchId, selection.effort, extra);
    const host = {
      capabilities: capabilitiesFor([resolution]),
      launch(selection) {
        calls.push('generic');
        return application(selection, `${item.runtime}-generic`);
      },
      launchTypedGsd(selection, context) {
        calls.push(context.gsd_role);
        return application(selection, `${item.runtime}-typed`, {
          gsd_role: context.gsd_role,
          gsd_launch_mechanism: context.gsd_launch_mechanism,
        });
      },
    };
    const adapter = item.runtime === 'codex'
      ? createCodexDispatchAdapter({ host, capabilities: host.capabilities })
      : createClaudeDispatchAdapter({ host, capabilities: host.capabilities });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-doc-call-'));
    const recorder = createDurableRecorder(path.join(root, 'receipts'));
    const boundary = boundaryModule.createDispatchBoundary({
      adapters: { [item.runtime]: adapter }, recorder, requireGsdRole: true,
    });

    try {
      const result = boundary.dispatch({
        runtime: item.runtime,
        role: item.role,
        gsd_role: item.gsd_role,
        signals: {},
        dispatch_id: `documented-${item.runtime}`,
        model: resolution.model,
        effort: resolution.effort,
      }, {});
      assert.equal(result.receipt.gsd_role, item.gsd_role);
      assert.equal(result.receipt.gsd_launch_mechanism, boundaryModule.GSD_LAUNCH_MECHANISM);
      assert.deepStrictEqual(calls, [item.gsd_role]);

      const missing = boundaryModule.createDispatchBoundary({
        adapters: { [item.runtime]: adapter },
        recorder: createDurableRecorder(path.join(root, 'missing-receipts')),
        requireGsdRole: true,
      });
      expectCode(() => missing.dispatch({
        runtime: item.runtime,
        role: item.role,
        signals: {},
        dispatch_id: `missing-${item.runtime}`,
        model: resolution.model,
        effort: resolution.effort,
      }, {}), 'INVALID_INPUT');
      assert.deepStrictEqual(calls, [item.gsd_role], 'missing gsd_role must not reach either host launch method');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('decompose selects runtime before tuning and establishes context before one callback set', () => {
  const source = readRepo('plugins/delivery-pipeline/commands/decompose.md');
  const boundarySection = source.slice(
    source.indexOf('## Step 0.5 — Mandatory GSD runtime dispatch'),
    source.indexOf('## Step 1 — Clarify the mode and the ticket size')
  );
  const runtimeAt = boundarySection.indexOf('1. Identify the active host runtime');
  const tuneAt = boundarySection.indexOf('gsd-tune.cjs --check');
  const configAt = boundarySection.indexOf('Before every researcher, planner, or checker callback');
  const boundaryAt = boundarySection.indexOf('5. Use the canonical boundary call for each role');
  assert.ok(
    runtimeAt >= 0 && tuneAt > runtimeAt && configAt > tuneAt && boundaryAt > configAt,
    'the active runtime, tuning, and routed configuration must precede every boundary callback'
  );
  assert.match(
    boundarySection,
    /gsd-tune\.cjs --check --runtime "\$runtime"/,
    'gsd-tune --check must receive the already-selected runtime explicitly'
  );
  assert.ok(
    normalized(boundarySection).includes(normalized('Tuning drift is harmless and MUST NOT block decomposition'))
      && normalized(boundarySection).includes(normalized('required delivery-contract or projection failures and every entry in the report\'s `blockers` array do block')),
    'tuning-only drift must not block while required contract/projection and blocker failures do'
  );

  const chain = source.slice(
    source.indexOf('## Step 2 — GSD chain'),
    source.indexOf('## Step 3 — Delivery frontmatter extension')
  );
  const phaseAt = chain.indexOf('Pick the phase number');
  const contextAt = chain.indexOf('/gsd-plan-phase <N> --ingest .planning/.adr-ingest/*.ingest.md');
  const researcherAt = chain.indexOf('`gsd-phase-researcher` →');
  const plannerAt = chain.indexOf('`gsd-planner` →');
  const checkerAt = chain.indexOf('`gsd-plan-checker` →');
  assert.ok(
    phaseAt >= 0 && phaseAt < contextAt && contextAt < researcherAt
      && researcherAt < plannerAt && plannerAt < checkerAt,
    'phase/ADR context must precede the researcher, planner, and checker callbacks'
  );
  assert.ok(normalized(chain).includes(normalized('exactly one set of three typed, boundary-owned callbacks')));
  assert.ok(normalized(chain).includes(normalized('same explicit context')));
  assert.ok(normalized(chain).includes(normalized('exactly three verified durable receipts')));
  assert.ok(normalized(chain).includes(normalized('same checker receipt')));
  assert.ok(normalized(chain).includes(normalized('must not dispatch or record a second `gsd-plan-checker`')));
  assert.equal(
    (chain.match(/`gsd-plan-checker` →/g) || []).length,
    1,
    'convergence must not add a second checker callback or receipt'
  );
});

test('delivery launch docs route every role through the boundary and the generated Codex names', () => {
  const deliver = readRepo('plugins/delivery-pipeline/commands/deliver.md');
  const sentinel = readRepo('plugins/delivery-pipeline/references/pr-sentinel.md');
  const source = `${deliver}\n${sentinel}`;
  const compact = normalized(source);

  for (const phrase of [
    'resolve → validate → launch → receipt',
    'createDispatchBoundary',
    'createCodexDispatchAdapter',
    'createClaudeDispatchAdapter',
    'createDurableRecorder',
    'boundary.dispatch',
    'priorApplied',
    'previous_dispatch_id',
    'literal model',
    'omitted effort',
    'inline',
    'inherited',
    'phantom',
    'receipt',
  ]) {
    assert.ok(compact.includes(normalized(phrase)), `delivery docs must state the boundary contract: ${phrase}`);
  }

  for (const role of [
    'executor', 'pr-sentinel', 'drift-check', 'ci-fix', 'review-fix',
    'arch-review', 'integrator',
  ]) {
    assert.ok(compact.includes(normalized(role)), `delivery docs must name routed role ${role}`);
  }

  for (const pair of [
    'Luna/max', 'Luna/medium', 'Sol/high', 'Sol/xhigh',
    'Sonnet/max', 'Sonnet/high', 'Opus/medium', 'Opus/high', 'Opus/max',
    'Fable/medium',
  ]) {
    assert.ok(source.includes(pair), `delivery docs must preserve the native ladder pair ${pair}`);
  }
  const investigate = readRepo('plugins/delivery-pipeline/commands/investigate.md');
  for (const [name, doc] of [['deliver', deliver], ['pr-sentinel', sentinel], ['investigate', investigate]]) {
    assert.ok(doc.includes('Workflow runtime'), `${name} must name the Workflow runtime by mechanism`);
    assert.ok(!/\bClaude\b/.test(doc), `${name} must not use converter-rewritten Claude prose`);
  }

  for (const variant of codexStaticVariants(2)) {
    assert.ok(source.includes(variant.file), `delivery docs must name generated Codex variant ${variant.file}`);
  }
  for (const retired of ['pr-sentinel-deep', 'arch-review-deep']) {
    assert.ok(!source.includes(retired), `delivery docs must not reintroduce retired variant ${retired}`);
  }
  assert.ok(!/--backend[^\n]*\|inline/.test(source), 'delivery docs must not authorize an inline backend');
    assert.ok(
      !/node[^\n]*pipeline-config\.cjs\s+model\s+/.test(source),
      'delivery docs must not execute the compatibility model command'
    );
});

test('delivery docs project selector, recorder, and workflow contracts without inventing fields', () => {
  const deliver = readRepo('plugins/delivery-pipeline/commands/deliver.md');
  const sentinel = readRepo('plugins/delivery-pipeline/references/pr-sentinel.md');
  const source = `${deliver}\n${sentinel}`;

  for (const phrase of [
    '--capabilities-file <current-host-capabilities.json>',
    'concrete `model`, `model_key`, `effort`/`requested_effort`',
    'compatibility recorder route',
    'recorder projection',
    'name without its `.toml` suffix',
    'Codex dynamic roles are `decomposition` and `executor`',
    '--effort-applied <receipt-applied-effort>',
    '`failure-signature.cjs verdict` supplies only verdict/history facts',
    '`repeat`/`repeat_exhausted` → `rethink`',
    'tickets: [{ id, planPath, baseRef, model, effort, signals }]',
    'priorReceipt, previous_dispatch_id, dispatch_id',
    '`false` disables the Workflow path',
    '**Cardinality is per work item.**',
    'round-scoped `pr-sentinel`',
    'pipeline.fable: auto',
    'Codex research has no alternatives rung',
    'shipyard-inv-research-critical.toml',
  ]) {
    assert.ok(source.includes(phrase), `delivery docs must state the actual contract: ${phrase}`);
  }

  for (const stale of ['model_tier', 'boundaryReceipt', 'shipyard-inv-research-alternatives.toml']) {
    assert.ok(!source.includes(stale), `delivery docs must not invent stale contract field/variant ${stale}`);
  }
  assert.ok(normalized(source).includes(normalized('obsolete instruction')),
    'delivery docs must identify the retired native Agent fallback rule');
  assert.ok(normalized(source).includes(normalized('never authorizes a native Agent fallback')),
    'delivery docs must reject the native Agent fallback explicitly');
  assert.ok(
    !source.includes('The resolver returns `strategy: fix|continue|rethink`'),
    'strategy must remain a failure-verdict input, not an invented boundary result'
  );
});

test('recorder task levels are projected separately from boundary rungs', () => {
  const deliver = readRepo('plugins/delivery-pipeline/commands/deliver.md');
  const sentinel = readRepo('plugins/delivery-pipeline/references/pr-sentinel.md');
  const source = `${deliver}\n${sentinel}`;
  assert.ok(source.includes('taskLevelRoute'), 'recorder marks must use the task-level projection');
  assert.ok(source.includes('mechanical|routine|complex|critical|recovery'), 'docs must name recorder task levels');
  assert.ok(!source.includes('--task-level <rung>'), 'canonical boundary rung must not be passed to the recorder');

  const adaptive = { ...pipelineConfig.DEFAULTS, model_ladder: 'adaptive' };
  for (const [role, signals, expected] of [
    ['pr-sentinel', {}, 'mechanical'],
    ['drift-check', {}, 'mechanical'],
    ['executor', { risk: 'low', files: 2 }, 'routine'],
    ['executor', { risk: 'high' }, 'critical'],
    ['ci-fix', { signatureState: 'repeat_exhausted' }, 'recovery'],
    ['arch-review', { contested: true }, 'recovery'],
  ]) {
    const level = pipelineConfig.resolveTaskLevel(role, signals, adaptive);
    assert.ok(pipelineConfig.TASK_LEVELS.includes(level), `${role} projection must be recorder-compatible`);
    assert.equal(level, expected, `${role} must project its evidence to the expected recorder task level`);
  }
});

test('every GSD callback requires routed configuration validation on both runtimes', () => {
  const roots = [];
  const writeConfig = (runtime, raw) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-config-contract-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
    return pipelineConfig.loadConfig(root, { runtime, env: {}, routed: true }).config;
  };

  try {
    for (const runtime of ['codex', 'claude']) {
      const consent = runtime === 'claude' ? { pipeline: { fable: 'auto' } } : {};
      const config = writeConfig(runtime, consent);
      for (const [index, item] of [
        { role: 'research', signals: {} },
        { role: 'decomposition', signals: { critical: true } },
        { role: 'decomposition', signals: { checkpoint: true } },
      ].entries()) {
        const resolution = pipelineConfig.resolveDispatch({
          config,
          runtime,
          role: item.role,
          signals: item.signals,
          dispatch_id: `config-contract-${runtime}-${index}`,
        });
        assert.equal(resolution.runtime, runtime);
        assert.ok(resolution.model, `${runtime} callback must receive a routed model`);
        assert.ok(resolution.effort, `${runtime} callback must receive a routed effort`);
      }

      const conflicting = runtime === 'codex'
        ? { pipeline: { models: { research: 'sonnet' } } }
        : { pipeline: { fable: 'auto', models: { research: 'sonnet' } } };
      const badConfig = writeConfig(runtime, conflicting);
      assert.throws(
        () => pipelineConfig.resolveDispatch({
          config: badConfig,
          runtime,
          role: 'research',
          signals: {},
          dispatch_id: `config-conflict-${runtime}`,
        }),
        (error) => error && error.code === 'CONFLICTING_OVERRIDE'
          && error.details && error.details.source === 'pipeline.models.research',
        `${runtime} must refuse a conflicting project model override before launch`
      );
    }
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research and decomposition use the canonical runtime ladders and only declared escalation signals', () => {
  const codexResearch = dispatchResolution('codex', 'research', {}, 'contract-codex-research');
  const claudeResearch = dispatchResolution('claude', 'research', {}, 'contract-claude-research');
  const codexDecomposition = dispatchResolution('codex', 'decomposition', {}, 'contract-codex-decomposition');
  const claudeDecomposition = dispatchResolution('claude', 'decomposition', {}, 'contract-claude-decomposition');

  assert.deepStrictEqual(
    [codexResearch.model, codexResearch.effort, codexResearch.rung],
    [policy.CODEX_MODEL_IDS.sol, 'high', 'base']
  );
  assert.deepStrictEqual(
    [claudeResearch.model, claudeResearch.effort, claudeResearch.rung],
    [CLAUDE_MODEL_ALIASES.opus, 'medium', 'base']
  );
  assert.deepStrictEqual(
    [codexDecomposition.model, codexDecomposition.effort, codexDecomposition.rung],
    [policy.CODEX_MODEL_IDS.sol, 'high', 'base']
  );
  assert.deepStrictEqual(
    [claudeDecomposition.model, claudeDecomposition.effort, claudeDecomposition.rung],
    [CLAUDE_MODEL_ALIASES.opus, 'medium', 'base']
  );

  assert.equal(
    dispatchResolution('codex', 'research', { type: 'alternatives' }, 'contract-research-alternatives').rung,
    'base',
    'Codex research has no alternatives rung; the undeclared signal must not promote it'
  );
  assert.equal(
    dispatchResolution('codex', 'research', { complexity: 'very-complex' }, 'contract-research-complex').rung,
    'very-complex'
  );
  assert.equal(
    dispatchResolution('claude', 'research', { type: 'alternatives' }, 'contract-claude-research-alternatives').rung,
    'base'
  );
  assert.equal(
    dispatchResolution('codex', 'decomposition', { critical: true }, 'contract-decomposition-critical').rung,
    'critical'
  );
  assert.equal(
    dispatchResolution('claude', 'decomposition', { checkpoint: true }, 'contract-claude-decomposition-checkpoint').rung,
    'critical'
  );

  // Decomposition's critical effort differs from the executor's critical effort.
  for (const [role, signals, model, effort, rung] of [
    ['research', { complexity: 'very-complex' }, policy.CODEX_MODEL_IDS.sol, 'xhigh', 'very-complex'],
    ['decomposition', { critical: true }, policy.CODEX_MODEL_IDS.sol, 'xhigh', 'critical'],
    ['executor', {}, policy.CODEX_MODEL_IDS.luna, 'max', 'base'],
    ['executor', { critical: true }, policy.CODEX_MODEL_IDS.sol, 'high', 'critical'],
    ['executor', { checkpoint: true }, policy.CODEX_MODEL_IDS.sol, 'high', 'critical'],
  ]) {
    const selection = dispatchResolution('codex', role, signals, `contract-${role}-${Object.keys(signals).join('-') || 'base'}`);
    assert.deepStrictEqual([selection.model, selection.effort, selection.rung], [model, effort, rung]);
  }

  assert.equal(
    dispatchResolution('codex', 'research', {
      risk: 'high', critical: true, checkpoint: true, contested: true, inputTokens: 1,
    }, 'contract-research-noise').rung,
    'base',
    'undeclared research signals must not promote the researcher'
  );
  assert.equal(
    dispatchResolution('claude', 'decomposition', {
      type: 'alternatives', complexity: 'very-complex', risk: 'high', contested: true, inputTokens: 1,
    }, 'contract-decomposition-noise').rung,
    'base',
    'undeclared decomposition signals must not promote the planner or checker'
  );
});

test('Claude decomposition escalation stays on Opus max regardless of Fable consent', () => {
  const roots = [];
  const loadRouted = (raw) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-fable-contract-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    if (raw !== undefined) {
      fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
    }
    return pipelineConfig.loadConfig(root, { runtime: 'claude', env: {}, routed: true }).config;
  };

  try {
    for (const raw of [{}, { pipeline: { fable: 'auto' } }]) {
      const config = loadRouted(raw);
      const resolution = pipelineConfig.resolveDispatch({
        config,
        role: 'decomposition',
        signals: { checkpoint: true },
      });
      assert.equal(resolution.model, CLAUDE_MODEL_ALIASES.opus);
      assert.equal(resolution.effort, 'max');
    }
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex GSD researcher, planner, and checker use runtime selections and durable receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-codex-contract-'));
  const agentsDir = path.join(root, 'agents');
  const recorder = boundaryModule.createDurableRecorder(path.join(root, 'receipts'));
  const calls = [];
  const cases = [
    { role: 'research', gsdRole: 'gsd-phase-researcher', signals: {}, id: 'codex-gsd-research' },
    { role: 'decomposition', gsdRole: 'gsd-planner', signals: { critical: true }, id: 'codex-gsd-planner' },
    { role: 'decomposition', gsdRole: 'gsd-plan-checker', signals: { checkpoint: true }, id: 'codex-gsd-checker' },
  ];
  const resolutions = cases.map(({ role, signals, id }) => dispatchResolution('codex', role, signals, id));
  writeGeneratedResearchAgent(agentsDir, resolutions[0]);
  const capabilities = capabilitiesFor(resolutions);
  const host = {
    capabilities,
    launch(selection, context) {
      calls.push({ kind: 'dynamic', selection, context });
      return applicationEvidence(selection, `codex-dynamic-${calls.length}`, selection.reasoning_effort);
    },
    launchStatic(selection, context) {
      calls.push({ kind: 'static', selection, context });
      return {
        ...codexApplicationEvidence(selection, `codex-static-${calls.length}`),
        agent_file_digest: selection.agent_file_digest,
      };
    },
    launchTypedGsd(selection, context) {
      calls.push({ kind: 'typed', selection, context });
      return codexApplicationEvidence(
        selection,
        `codex-typed-${calls.length}`,
        {
          gsd_role: context.gsd_role,
          gsd_launch_mechanism: context.gsd_launch_mechanism,
          ...(selection.agent_file ? { agent_file_digest: selection.agent_file_digest } : {}),
        },
      );
    },
  };
  const adapter = createCodexDispatchAdapter({ host, agentsDir, capabilities });
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: adapter },
    recorder,
  });

  try {
    for (const [index, item] of cases.entries()) {
      const result = boundary.dispatch({
        runtime: 'codex', role: item.role, signals: item.signals,
        gsd_role: item.gsdRole, dispatch_id: item.id,
      }, {});
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.receipt.dispatch_id, item.id);
      assert.equal(result.receipt.role, item.role);
      assert.equal(result.receipt.applied_model, resolutions[index].model);
      assert.equal(result.receipt.applied_effort, resolutions[index].effort);
      assert.equal(result.receipt.gsd_role, item.gsdRole);
      assert.equal(result.receipt.gsd_launch_mechanism, boundaryModule.GSD_LAUNCH_MECHANISM);
      assert.deepStrictEqual(recorder.getVerifiedRecord(item.id).receipt, result.receipt);
    }
    assert.equal(calls[0].kind, 'typed');
    assert.deepStrictEqual(
      [calls[0].selection.model, calls[0].selection.reasoning_effort, calls[0].selection.agent_file],
      [resolutions[0].model, resolutions[0].effort, resolutions[0].agent_file]
    );
    assert.equal(calls[1].kind, 'typed');
    assert.deepStrictEqual(calls[1].selection, resolutions[1].launch_arguments);
    assert.equal(calls[2].kind, 'typed');
    assert.deepStrictEqual(calls[2].selection, resolutions[2].launch_arguments);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude GSD researcher, planner, and checker use explicit native selections and durable receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-claude-contract-'));
  const recorder = boundaryModule.createDurableRecorder(path.join(root, 'receipts'));
  const calls = [];
  const cases = [
    { role: 'research', gsdRole: 'gsd-phase-researcher', signals: {}, id: 'claude-gsd-research' },
    { role: 'decomposition', gsdRole: 'gsd-planner', signals: {}, id: 'claude-gsd-planner' },
    { role: 'decomposition', gsdRole: 'gsd-plan-checker', signals: { checkpoint: true }, id: 'claude-gsd-checker' },
  ];
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-claude-config-'));
  fs.mkdirSync(path.join(configRoot, '.planning'), { recursive: true });
  const loadRoutedConfig = (raw) => {
    fs.writeFileSync(path.join(configRoot, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
    return pipelineConfig.loadConfig(configRoot, { runtime: 'claude', env: {}, routed: true }).config;
  };
  const withoutConsent = loadRoutedConfig({});
  const consented = loadRoutedConfig({ pipeline: { fable: 'auto' } });
  const offResolution = pipelineConfig.resolveDispatch({
    config: withoutConsent,
    role: 'decomposition',
    signals: { checkpoint: true },
  });
  assert.deepStrictEqual(
    [offResolution.model, offResolution.effort],
    [CLAUDE_MODEL_ALIASES.opus, 'max'],
    'decomposition must use the canonical Opus/max escalation even with Fable consent off'
  );
  const resolutions = cases.map(({ role, signals, id }) => pipelineConfig.resolveDispatch({
    config: consented,
    role,
    signals,
    dispatch_id: id,
  }));
  const capabilities = capabilitiesFor(resolutions);
  const host = {
    capabilities,
    launch(selection, context) {
      calls.push({ selection, context });
      return applicationEvidence(selection, `claude-gsd-${calls.length}`);
    },
    launchTypedGsd(selection, context) {
      calls.push({ selection, context, typed: true });
      return applicationEvidence(selection, `claude-gsd-typed-${calls.length}`, selection.effort, {
        gsd_role: context.gsd_role,
        gsd_launch_mechanism: context.gsd_launch_mechanism,
      });
    },
  };
  const adapter = createClaudeDispatchAdapter({ host, capabilities });
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { claude: adapter },
    recorder,
  });
  const dispatchRouted = (config, item) => {
    const resolution = pipelineConfig.resolveDispatch({
      config,
      role: item.role,
      signals: item.signals,
      dispatch_id: item.id,
    });
    return boundary.dispatch({
      runtime: 'claude',
      role: item.role,
      signals: item.signals,
      dispatch_id: item.id,
      model: resolution.model,
      effort: resolution.effort,
      gsd_role: item.gsdRole,
    }, {});
  };

  try {
    for (const [index, item] of cases.entries()) {
      const result = dispatchRouted(consented, item);
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.receipt.dispatch_id, item.id);
      assert.equal(result.receipt.role, item.role);
      assert.equal(result.receipt.gsd_role, item.gsdRole);
      assert.equal(result.receipt.gsd_launch_mechanism, boundaryModule.GSD_LAUNCH_MECHANISM);
      assert.deepStrictEqual(calls[index].selection, resolutions[index].launch_arguments);
      assert.deepStrictEqual(recorder.getVerifiedRecord(item.id).receipt, result.receipt);
    }
    assert.equal(calls[0].selection.model, CLAUDE_MODEL_ALIASES.opus);
    assert.equal(calls[1].selection.model, CLAUDE_MODEL_ALIASES.opus);
    assert.equal(calls[2].selection.model, CLAUDE_MODEL_ALIASES.opus);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
});

test('Claude workflow coordinator selects the typed callback and refuses its absence', async () => {
  const evidence = new WeakMap();
  let genericCalls = 0;
  let typedCalls = 0;
  const result = await createClaudeWorkflowDispatch({
    agent: () => {
      genericCalls++;
      throw new Error('generic callback must not run for a GSD dispatch');
    },
    typedGsdCallback: async (prompt, options, gsdRole) => {
      typedCalls++;
      const value = { prompt };
      evidence.set(value, {
        launch_id: 'claude-workflow-gsd-typed',
        applied_model: options.model,
        applied_effort: options.effort,
        observed_model: options.model,
        observed_effort: options.effort,
        gsd_role: gsdRole,
        gsd_launch_mechanism: options.gsd_launch_mechanism,
      });
      return value;
    },
    applicationEvidence: ({ result: value }) => evidence.get(value),
    capabilities: sourceDispatchCapabilities,
    recorder: sourceDispatchRecorder,
    prompt: 'typed GSD coordinator prompt',
    role: 'decomposition',
    model: 'opus',
    effort: 'medium',
    gsdRole: 'gsd-planner',
    dispatchId: 'claude-gsd-workflow-coordinator',
  });
  assert.equal(typedCalls, 1);
  assert.equal(genericCalls, 0);
  assert.equal(result.receipt.gsd_role, 'gsd-planner');
  assert.equal(result.receipt.gsd_launch_mechanism, boundaryModule.GSD_LAUNCH_MECHANISM);
  assert.throws(
    () => createClaudeWorkflowDispatch({
      agent: () => ({}),
      applicationEvidence: () => ({}),
      capabilities: sourceDispatchCapabilities,
      recorder: sourceDispatchRecorder,
      prompt: 'missing typed callback',
      role: 'decomposition',
      model: 'opus',
      effort: 'medium',
      gsdRole: 'gsd-planner',
      dispatchId: 'claude-gsd-workflow-missing-typed',
    }),
    (error) => error && error.code === 'MISSING_ADAPTER',
    'Claude coordinator must refuse before launch when typed GSD wiring is absent'
  );
});

test('Claude workflow coordinator accepts an explicit typed-only host and preflights its role', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-typed-host-'));
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  let typedCalls = 0;
  const host = {
    capabilities: sourceDispatchCapabilities,
    recorder,
    typedGsdCallback: async (_prompt, launchOptions, gsdRole) => {
      typedCalls++;
      const value = {};
      evidence.set(value, {
        launch_id: 'claude-host-typed-only',
        applied_model: launchOptions.model,
        applied_effort: launchOptions.effort,
        gsd_role: gsdRole,
        gsd_launch_mechanism: launchOptions.gsd_launch_mechanism,
      });
      return value;
    },
    applicationEvidence: ({ result }) => evidence.get(result),
  };

  try {
    const result = await createClaudeWorkflowDispatch({
      host,
      prompt: 'typed-only host prompt',
      role: 'decomposition',
      model: 'opus',
      effort: 'medium',
      gsdRole: 'gsd-planner',
      dispatchId: 'claude-host-typed-only',
    });
    assert.equal(result.receipt.gsd_role, 'gsd-planner');
    assert.equal(result.receipt.gsd_launch_mechanism, boundaryModule.GSD_LAUNCH_MECHANISM);
    assert.equal(typedCalls, 1);

    assert.throws(
      () => createClaudeWorkflowDispatch({
        host,
        prompt: 'typed-only host without role',
        role: 'decomposition',
        model: 'opus',
        effort: 'medium',
        dispatchId: 'claude-host-typed-only-missing-role',
      }),
      (error) => error && error.code === 'INVALID_INPUT',
      'a typed-only GSD host must reject a missing gsdRole before dispatch reservation'
    );
    assert.equal(typedCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GSD callback wiring refuses generic launches and mismatched host attestation on both runtimes', () => {
  const runRefusal = (runtime, host, id, expectedCode) => {
    const resolution = dispatchResolution(runtime, 'decomposition', {}, id);
    const capabilities = capabilitiesFor([resolution]);
    const adapter = runtime === 'codex'
      ? createCodexDispatchAdapter({ host, capabilities })
      : createClaudeDispatchAdapter({ host, capabilities });
    const boundary = boundaryModule.createDispatchBoundary({
      adapters: { [runtime]: adapter },
      recorder: () => true,
    });
    expectCode(() => boundary.dispatch({
      runtime,
      role: 'decomposition',
      gsd_role: 'gsd-planner',
      dispatch_id: id,
    }), expectedCode);
  };

  let genericLaunches = 0;
  const codexResolution = dispatchResolution('codex', 'decomposition', {}, 'codex-gsd-missing-typed');
  const codexCapabilities = capabilitiesFor([codexResolution]);
  runRefusal('codex', {
    capabilities: codexCapabilities,
    launch() { genericLaunches++; return codexApplicationEvidence({ model: codexResolution.model, reasoning_effort: codexResolution.effort }, 'codex-generic'); },
  }, 'codex-gsd-missing-typed', 'MISSING_ADAPTER');
  const claudeResolution = dispatchResolution('claude', 'decomposition', {}, 'claude-gsd-missing-typed');
  const claudeCapabilities = capabilitiesFor([claudeResolution]);
  runRefusal('claude', {
    capabilities: claudeCapabilities,
    launch() { genericLaunches++; return applicationEvidence({ model: claudeResolution.model, effort: claudeResolution.effort }, 'claude-generic'); },
  }, 'claude-gsd-missing-typed', 'MISSING_ADAPTER');
  assert.equal(genericLaunches, 0, 'a generic callback must not run when typed GSD wiring is absent');

  for (const [runtime, resolution, capabilities, makeEvidence] of [
    ['codex', codexResolution, codexCapabilities, (selection) => codexApplicationEvidence(selection, 'codex-gsd-wrong-attestation', {
      gsd_role: 'gsd-plan-checker', gsd_launch_mechanism: boundaryModule.GSD_LAUNCH_MECHANISM,
    })],
    ['claude', claudeResolution, claudeCapabilities, (selection) => applicationEvidence(selection, 'claude-gsd-wrong-attestation', selection.effort, {
      gsd_role: 'gsd-plan-checker', gsd_launch_mechanism: boundaryModule.GSD_LAUNCH_MECHANISM,
    })],
  ]) {
    let typedLaunches = 0;
    const host = {
      capabilities,
      launch() { throw new Error('generic callback must not be selected'); },
      launchTypedGsd(selection) { typedLaunches++; return makeEvidence(selection); },
    };
    runRefusal(runtime, host, `${runtime}-gsd-wrong-attestation`, 'NONCOMPLIANT_RECEIPT');
    assert.equal(typedLaunches, 1, `${runtime} must invoke the typed callback before checking its host evidence`);
  }
});

test('boundary refuses missing or ambiguous runtime before any GSD launch', () => {
  let launches = 0;
  const adapter = { launch: () => { launches++; } };
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { undefined: adapter, both: adapter },
    recorder: () => true,
  });
  for (const input of [
    { role: 'research' },
    { runtime: 'both', role: 'research' },
  ]) {
    expectCode(() => boundary.dispatch(input), 'UNKNOWN_RUNTIME');
  }
  assert.equal(launches, 0);
});

test('boundary refuses a missing recorder, unsupported selection, and missing application receipt', () => {
  const resolution = dispatchResolution('claude', 'research', {}, 'contract-refusal');
  const capabilities = capabilitiesFor([resolution]);
  let launches = 0;
  const host = {
    capabilities,
    launch() {
      launches++;
      return undefined;
    },
  };
  const adapter = createClaudeDispatchAdapter({ host, capabilities });
  const withoutRecorder = boundaryModule.createDispatchBoundary({ adapters: { claude: adapter } });
  expectCode(() => withoutRecorder.dispatch({
    runtime: 'claude', role: 'research', dispatch_id: 'contract-no-recorder',
  }), 'RECORD_UNAVAILABLE');
  assert.equal(launches, 0, 'no recorder must refuse before launch');

  const unsupportedHost = {
    capabilities: { supportedModels: [], supportedEfforts: [], supportedSelections: [] },
    launch() { launches++; },
  };
  const unsupportedAdapter = createClaudeDispatchAdapter({
    host: unsupportedHost,
    capabilities: unsupportedHost.capabilities,
  });
  const unsupportedBoundary = boundaryModule.createDispatchBoundary({
    adapters: { claude: unsupportedAdapter },
    recorder: () => true,
  });
  expectCode(() => unsupportedBoundary.dispatch({
    runtime: 'claude', role: 'research', dispatch_id: 'contract-unsupported',
  }), 'UNSUPPORTED_SELECTION');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-receipt-contract-'));
  try {
    const recorder = boundaryModule.createDurableRecorder(root);
    const missingReceiptBoundary = boundaryModule.createDispatchBoundary({
      adapters: { claude: adapter },
      recorder,
    });
    expectCode(() => missingReceiptBoundary.dispatch({
      runtime: 'claude', role: 'research', dispatch_id: 'contract-missing-receipt',
    }), 'MISSING_RECEIPT');
    assert.equal(recorder.getVerifiedRecord('contract-missing-receipt'), null);
    assert.equal(launches, 1, 'the host was called, but its unsubstantiated result was refused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime adapters refuse inline and inherited-session launch contexts', () => {
  const resolution = dispatchResolution('claude', 'decomposition', {}, 'contract-context');
  const capabilities = capabilitiesFor([resolution]);
  let launches = 0;
  const host = {
    capabilities,
    launch() {
      launches++;
      return applicationEvidence({ model: resolution.model, effort: resolution.effort }, 'never');
    },
  };
  const adapter = createClaudeDispatchAdapter({ host, capabilities });
  for (const [index, context] of [
    { inline: true },
    { inherit: true },
    { session_inherited: true },
  ].entries()) {
    const boundary = boundaryModule.createDispatchBoundary({
      adapters: { claude: adapter },
      recorder: () => true,
    });
    expectCode(() => boundary.dispatch({
      runtime: 'claude', role: 'decomposition', dispatch_id: `contract-context-${index}`,
    }, context), 'UNSUPPORTED_SELECTION');
  }
  assert.equal(launches, 0, 'inline and inherited-session contexts must never reach the host');
});

// ── No routed launch may grow beside the boundary (REQ-110) ────────────────
//
// The Workflow files deliberately receive the native `agent` callback, so a
// simple `agent` token sweep would reject the injection point itself. The
// executable-call shape below catches a new direct invocation such as
// `if (ready) agent(prompt)`, `agent?.(prompt)`, or `(agent)(prompt)` while
// ignoring explanatory prose. The scan tokenizes executable source instead of
// relying on one spelling of `agent(`. The
// manifest comes from every tracked Workflow, command, and delivery reference:
// a new routed surface therefore joins the sweep without an accompanying edit
// to this test. Boundary-bearing sources are checked separately below; the
// wider sweep is what catches a newly added source that bypasses the boundary
// altogether.
const ROUTED_LAUNCH_ROOTS = [
  'plugins/delivery-pipeline/workflows',
  'plugins/delivery-pipeline/commands',
  'plugins/delivery-pipeline/references',
];
const routedLaunchSources = () => tracked(...ROUTED_LAUNCH_ROOTS)
  .filter((rel) => /\.(?:mjs|md)$/.test(rel));
const ROUTED_LAUNCH_SOURCES = routedLaunchSources();
const BOUNDARY_LAUNCH_SOURCES = ROUTED_LAUNCH_SOURCES.filter((rel) => {
  const source = readRepo(rel);
  return source.includes('createClaudeWorkflowDispatch')
    || source.includes('createDispatchBoundary')
    || source.includes('boundary.dispatch');
});
const NATIVE_LAUNCHERS = new Set(['agent', 'spawn_agent', 'spawnAgent']);
const launchableSource = (rel, source) => {
  if (!rel.endsWith('.md')) return source;
  let fenced = false;
  return source.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? line : '';
  }).join('\n');
};
const executableTokens = (source) => {
  const tokens = [];
  let index = 0;
  let line = 1;
  const advance = () => {
    if (source[index++] === '\n') line++;
  };
  const skipLineComment = () => {
    while (index < source.length && source[index] !== '\n') advance();
  };
  const skipBlockComment = () => {
    advance(); advance();
    while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) advance();
    if (index < source.length) { advance(); advance(); }
  };
  const skipQuoted = (quote) => {
    advance();
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') advance();
      advance();
    }
    if (index < source.length) advance();
  };
  const skipTemplateLiteral = () => {
    advance();
    while (index < source.length) {
      if (source[index] === '\\') { advance(); advance(); }
      else if (source[index] === '`') { advance(); return; }
      else if (source[index] === '$' && source[index + 1] === '{') {
        advance(); advance();
        skipTemplateExpression();
      } else advance();
    }
  };
  const skipTemplateExpression = () => {
    let depth = 1;
    while (index < source.length && depth > 0) {
      const ch = source[index];
      if (ch === '/' && source[index + 1] === '/') skipLineComment();
      else if (ch === '/' && source[index + 1] === '*') skipBlockComment();
      else if (ch === '\'' || ch === '"') skipQuoted(ch);
      else if (ch === '`') skipTemplateLiteral();
      else if (ch === '{') { depth++; advance(); }
      else if (ch === '}') { depth--; advance(); }
      else advance();
    }
  };
  const tokenizeTemplate = () => {
    advance();
    while (index < source.length) {
      if (source[index] === '\\') { advance(); advance(); }
      else if (source[index] === '`') { advance(); return; }
      else if (source[index] === '$' && source[index + 1] === '{') {
        advance(); advance();
        const expressionStart = index;
        const expressionLine = line;
        skipTemplateExpression();
        const expression = source.slice(expressionStart, index - 1);
        tokens.push(...executableTokens(expression).map((token) => ({
          ...token,
          line: token.line + expressionLine - 1,
        })));
      } else advance();
    }
  };
  while (index < source.length) {
    const ch = source[index];
    if (/\s/.test(ch)) {
      advance();
    } else if (ch === '/' && source[index + 1] === '/') {
      skipLineComment();
    } else if (ch === '/' && source[index + 1] === '*') {
      skipBlockComment();
    } else if (ch === '\'' || ch === '"') {
      skipQuoted(ch);
    } else if (ch === '`') {
      tokenizeTemplate();
    } else if (/[A-Za-z_$]/.test(ch)) {
      const start = index;
      const tokenLine = line;
      advance();
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) advance();
      tokens.push({ value: source.slice(start, index), line: tokenLine });
    } else {
      tokens.push({ value: ch, line });
      advance();
    }
  }
  return tokens;
};
const callOpensAt = (tokens, index) => tokens[index]?.value === '('
  || (tokens[index]?.value === '?' && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === '(');
const NATIVE_MEMBER_METHODS = new Set(['call', 'apply', 'bind']);
const memberInvocationOpensAt = (tokens, index) => callOpensAt(tokens, index)
  || (tokens[index]?.value === ')' && callOpensAt(tokens, index + 1));
const memberCallOpensAt = (tokens, index) => {
  const memberStart = tokens[index]?.value === '.' ? index + 1
    : tokens[index]?.value === '?' && tokens[index + 1]?.value === '.' ? index + 2 : null;
  if (memberStart !== null
      && NATIVE_MEMBER_METHODS.has(tokens[memberStart]?.value)
      && memberInvocationOpensAt(tokens, memberStart + 1)) return true;
  const computedStart = tokens[index]?.value === '[' ? index
    : tokens[index]?.value === '?' && tokens[index + 1]?.value === '.'
      && tokens[index + 2]?.value === '[' ? index + 2 : null;
  // Quoted computed property names are skipped by the lexer, so a native
  // callback's `['call'](...)`, `['apply'](...)`, or `['bind'](...)` has the
  // compact `[ ] (` shape.
  // Treating any computed member call as a violation is deliberately
  // conservative: a routed native callback must not be invoked indirectly.
  return computedStart !== null
    && tokens[computedStart + 1]?.value === ']'
    && memberInvocationOpensAt(tokens, computedStart + 2);
};
const indirectApplyAt = (tokens, index, launchers) => {
  if (tokens[index]?.value !== 'Reflect'
      || tokens[index + 1]?.value !== '.'
      || tokens[index + 2]?.value !== 'apply'
      || tokens[index + 3]?.value !== '(') return false;
  const callback = launcherReferenceAt(tokens, index + 4, launchers);
  return callback !== null;
};
const launcherReferenceAt = (tokens, index, launchers) => {
  if (launchers.has(tokens[index]?.value)) return index;
  if (tokens[index]?.value === '('
      && launchers.has(tokens[index + 1]?.value)
      && tokens[index + 2]?.value === ')') return index + 1;
  return null;
};
const boundMemberCallOpensAt = (tokens, index) => {
  const memberStart = tokens[index]?.value === '.' ? index + 1
    : tokens[index]?.value === '?' && tokens[index + 1]?.value === '.' ? index + 2 : null;
  if (memberStart !== null) {
    return tokens[memberStart]?.value === 'bind'
      && callOpensAt(tokens, memberStart + 1);
  }
  const computedStart = tokens[index]?.value === '[' ? index
    : tokens[index]?.value === '?' && tokens[index + 1]?.value === '.'
      && tokens[index + 2]?.value === '[' ? index + 2 : null;
  // Quoted computed property names are skipped by the lexer, so a bound
  // callback's `['bind'](...)` has the compact `[ ] (` shape.
  return computedStart !== null
    && tokens[computedStart + 1]?.value === ']'
    && callOpensAt(tokens, computedStart + 2);
};
const launcherAliases = (tokens) => {
  const launchers = new Set(NATIVE_LAUNCHERS);
  for (let index = 0; index + 3 < tokens.length; index++) {
    if (!['const', 'let', 'var'].includes(tokens[index]?.value)
        || tokens[index + 1]?.value === undefined
        || tokens[index + 2]?.value !== '=') continue;
    const source = launcherReferenceAt(tokens, index + 3, launchers);
    if (source === null) continue;
    const sourceEnd = source + 1;
    const isDirect = tokens[sourceEnd]?.value === ';' || tokens[sourceEnd]?.value === ','
      || tokens[sourceEnd]?.value === ')';
    const isBound = boundMemberCallOpensAt(tokens, sourceEnd);
    if (isDirect || isBound) launchers.add(tokens[index + 1].value);
  }
  return launchers;
};
const directLaunchCalls = (source) => {
  const tokens = executableTokens(source);
  const launchers = launcherAliases(tokens);
  const direct = tokens.filter((token, index) => {
    if (!launchers.has(token.value) || tokens[index - 1]?.value === '.') return false;
    if (callOpensAt(tokens, index + 1) || memberCallOpensAt(tokens, index + 1)) return true;
    return tokens[index - 1]?.value === '('
      && tokens[index + 1]?.value === ')'
      && (callOpensAt(tokens, index + 2) || memberCallOpensAt(tokens, index + 2));
  });
  return direct.concat(tokens.filter((token, index) => indirectApplyAt(tokens, index, launchers)));
};
const directLaunchOffenders = (root, rels) => rels.flatMap((rel) => {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  return directLaunchCalls(launchableSource(rel, source)).map(({ line }) =>
    `${rel}:${line}: ${source.split('\n')[line - 1].trim()}`);
});

test('every routed launch surface names the boundary and has no direct launch call outside it', () => {
  assert.ok(ROUTED_LAUNCH_SOURCES.includes('plugins/delivery-pipeline/workflows/executors.mjs'), 'the tracked routed-source manifest must include Workflow launchers');
  assert.ok(ROUTED_LAUNCH_SOURCES.includes('plugins/delivery-pipeline/commands/deliver.md'), 'the tracked routed-source manifest must include delivery commands');
  assert.ok(ROUTED_LAUNCH_SOURCES.includes('plugins/delivery-pipeline/references/pr-sentinel.md'), 'the tracked routed-source manifest must include delivery references');
  assert.ok(BOUNDARY_LAUNCH_SOURCES.length >= 6, 'the tracked routed-source manifest must discover the current boundary-bearing surfaces');
  for (const rel of BOUNDARY_LAUNCH_SOURCES) {
    const source = readRepo(rel);
    assert.ok(source.includes('createClaudeWorkflowDispatch') || source.includes('createDispatchBoundary'), `${rel} must name its boundary entry point`);
    assert.ok(source.includes('boundary.dispatch') || source.includes('createClaudeWorkflowDispatch'), `${rel} must use the boundary launch shape`);
  }
  const offenders = directLaunchOffenders(REPO, ROUTED_LAUNCH_SOURCES);
  assert.deepStrictEqual(
    offenders,
    [],
    `a routed launch must cross resolve → validate → launch → receipt through the boundary; direct launch calls found:\n  ${offenders.join('\n  ')}`,
  );
});

test('the routed-launch source sweep rejects direct, optional, and parenthesized native launches', () => {
  const dir = fixture('outside.mjs', [
    'const direct = (prompt) => agent(prompt);',
    'const optional = (prompt) => agent?.(prompt);',
    'const grouped = (prompt) => (agent)(prompt);',
    'const spawned = (prompt) => spawn_agent?.(prompt);',
    'const groupedSpawn = (prompt) => (spawnAgent)(prompt);',
    'const reflected = (prompt) => Reflect.apply(agent, null, [prompt]);',
    '// agent(prompt) is forbidden outside the boundary.',
    'const prose = "agent(prompt)";',
    'const allowed = (prompt) => createClaudeWorkflowDispatch({ prompt });',
    '',
  ].join('\n'));
  const offenders = directLaunchOffenders(dir, ['outside.mjs']);
  assert.equal(offenders.length, 6, `the fixture must exercise every native-launch call form: ${offenders.join('\n')}`);
  assert.match(offenders[0], /outside\.mjs:1/);
  assert.match(offenders[0], /agent\(prompt\)/);
  assert.match(offenders[1], /agent\?\.\(prompt\)/);
  assert.match(offenders[2], /\(agent\)\(prompt\)/);
  assert.match(offenders[3], /spawn_agent\?\.\(prompt\)/);
  assert.match(offenders[4], /\(spawnAgent\)\(prompt\)/);
  assert.match(offenders[5], /Reflect\.apply\(agent/);
});

test('the routed-launch source sweep recursively scans template interpolations', () => {
  const dir = fixture('template-outside.mjs', [
    'const interpolated = `launch: ${agent(prompt)}`;',
    'const nested = `outer ${`inner ${spawn_agent?.(prompt)}`}`;',
    'const prose = `agent(prompt)`;',
    '',
  ].join('\n'));
  const offenders = directLaunchOffenders(dir, ['template-outside.mjs']);
  assert.equal(offenders.length, 2, `template interpolations must be scanned recursively: ${offenders.join('\n')}`);
  assert.match(offenders[0], /template-outside\.mjs:1/);
  assert.match(offenders[0], /\$\{agent\(prompt\)\}/);
  assert.match(offenders[1], /template-outside\.mjs:2/);
  assert.match(offenders[1], /spawn_agent\?\.\(prompt\)/);
});

test('the routed-launch source sweep rejects native call and apply member forms', () => {
  const dir = fixture('member-outside.mjs', [
    'const called = agent.call(null, prompt);',
    'const applied = agent.apply(null, [prompt]);',
    'const grouped = (spawnAgent).call(null, prompt);',
    'const property = worker.agent.call(null, prompt);',
    'const computedCalled = agent[\'call\'](null, prompt);',
    'const optionalComputedApplied = agent?.[\'apply\'](null, [prompt]);',
    'const parenthesizedCalled = (agent.call)(prompt);',
    'const parenthesizedComputedApplied = (agent[\'apply\'])(null, [prompt]);',
    '',
  ].join('\n'));
  const offenders = directLaunchOffenders(dir, ['member-outside.mjs']);
  assert.equal(offenders.length, 7, `native call/apply member forms must be rejected: ${offenders.join('\n')}`);
  assert.match(offenders[0], /member-outside\.mjs:1/);
  assert.match(offenders[0], /agent\.call/);
  assert.match(offenders[1], /member-outside\.mjs:2/);
  assert.match(offenders[1], /agent\.apply/);
  assert.match(offenders[2], /member-outside\.mjs:3/);
  assert.match(offenders[2], /\(spawnAgent\)\.call/);
  assert.match(offenders[3], /member-outside\.mjs:5/);
  assert.match(offenders[3], /agent\['call'\]/);
  assert.match(offenders[4], /member-outside\.mjs:6/);
  assert.match(offenders[4], /agent\?\.\['apply'\]/);
  assert.match(offenders[5], /member-outside\.mjs:7/);
  assert.match(offenders[5], /\(agent\.call\)/);
  assert.match(offenders[6], /member-outside\.mjs:8/);
  assert.match(offenders[6], /\(agent\['apply'\]\)/);
});

test('the routed-launch source sweep rejects direct and bound native launcher aliases', () => {
  const dir = fixture('alias-outside.mjs', [
    'const launch = agent;',
    'const directAlias = (prompt) => launch(prompt);',
    'const bound = agent.bind(null);',
    'const boundAlias = (prompt) => bound(prompt);',
    'const computedBound = agent[\'bind\'](null);',
    'const computedBoundAlias = (prompt) => computedBound(prompt);',
    '',
  ].join('\n'));
  const offenders = directLaunchOffenders(dir, ['alias-outside.mjs']);
  assert.equal(offenders.length, 5, `native launcher aliases must be rejected: ${offenders.join('\n')}`);
  assert.match(offenders[0], /alias-outside\.mjs:2/);
  assert.match(offenders[0], /launch\(prompt\)/);
  assert.match(offenders[1], /alias-outside\.mjs:3/);
  assert.match(offenders[1], /agent\.bind/);
  assert.match(offenders[2], /alias-outside\.mjs:4/);
  assert.match(offenders[2], /bound\(prompt\)/);
  assert.match(offenders[3], /alias-outside\.mjs:5/);
  assert.match(offenders[3], /agent\['bind'\]/);
  assert.match(offenders[4], /alias-outside\.mjs:6/);
  assert.match(offenders[4], /computedBound\(prompt\)/);
});

test('the routed-launch source sweep rejects native launches in shipped Markdown fenced blocks', () => {
  const dir = fixture('outside.md', [
    '# Workflow prompt',
    '',
    'This prose may describe `agent(prompt)` without constituting launch text.',
    '',
    '```javascript',
    'agent(prompt);',
    '```',
    '',
  ].join('\n'));
  const offenders = directLaunchOffenders(dir, ['outside.md']);
  assert.equal(offenders.length, 1, `the fenced prompt text must be scanned: ${offenders.join('\n')}`);
  assert.match(offenders[0], /outside\.md:6/);
  assert.match(offenders[0], /agent\(prompt\)/);
});

const RUNTIME_OWNED_FILE_DIGESTS = Object.freeze({
  'plugins/delivery-pipeline/scripts/runtime-adapters.cjs': '11126e9bbf4dac883b495f48e55504990ec358f739c8f314a4d147789c3ad346',
  'plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs': 'b783ebc1cbf2f4af33cf697a98cf980a0696f3afefd8aad4f0056b52d17c276d',
});

test('Claude palette and provider adapter sources match their checked-in baselines and remain native', () => {
  for (const [rel, expectedDigest] of Object.entries(RUNTIME_OWNED_FILE_DIGESTS)) {
    const actualDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
    assert.equal(actualDigest, expectedDigest, `${rel} is a runtime-owned palette/provider file and must match its checked-in baseline`);
  }
  assert.deepStrictEqual(CLAUDE_MODEL_ALIASES, { sonnet: 'sonnet', opus: 'opus', fable: 'fable' });
  assert.equal(readRepo('plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs').includes('runtime: \'claude\''), true);
  assert.equal(readRepo('plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs').includes('gpt-5.6-luna'), false);
  assert.equal(readRepo('plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs').includes('gpt-6-astra'), false);
});

test('decompose normalizes ADRs before calling GSD ingest', () => {
  const decompose = readRepo('plugins/delivery-pipeline/commands/decompose.md');
  const normalizeAt = decompose.indexOf('adr-ingest.cjs');
  const ingestAt = decompose.indexOf('/gsd-plan-phase', normalizeAt);
  assert.ok(normalizeAt >= 0, 'decompose must invoke the ADR compatibility layer');
  assert.ok(ingestAt > normalizeAt, 'GSD ingest must follow ADR normalization');
  assert.ok(decompose.includes('.planning/.adr-ingest/*.ingest.md'), 'GSD must ingest normalized files inside the project');
});

test('investigate emits flat machine-readable decision lists', () => {
  const investigate = readRepo('plugins/delivery-pipeline/commands/investigate.md');
  assert.ok(investigate.includes('each locked decision is one bullet under `## Decision`'));
  assert.ok(investigate.includes('scope fences use\n     `## Out of scope`'));
});

test('autonomous rollout source keeps the gate versioned, provider-pure, and fail-closed', () => {
  const source = readRepo('plugins/delivery-pipeline/scripts/run-rollout.cjs');
  assert.ok(source.includes("SCHEMA = 'shipyard.autonomous-rollout.v1'"));
  assert.ok(source.includes("ROLLOUT_VERSION = 'v1'"));
  assert.ok(source.includes("source !== 'live'"));
  assert.ok(source.includes("status === 'enabled'"));
  assert.ok(source.includes("providerFor(runtime)"));
  assert.ok(source.includes("--capability-only"));
  for (const file of ['run-contract.cjs', 'run-store.cjs', 'run-controller.cjs', 'run-waker.cjs', 'run-telemetry.cjs', 'usage-attribution.cjs', 'pipeline-stats.cjs']) {
    assert.ok(source.includes(file), `rollout gate must name ${file}`);
  }
  assert.deepStrictEqual(rollout.RUNTIMES, ['claude', 'codex']);
  assert.deepStrictEqual(rollout.PROVIDERS, { claude: 'anthropic', codex: 'openai' });
});

test('delivery documents rollout status, technical waits, rollback, and human-only gates', () => {
  const deliver = readRepo('plugins/delivery-pipeline/commands/deliver.md');
  const docs = readRepo('docs/gsd_multilevel_delivery_pipeline.md');
  for (const source of [deliver, docs]) {
    assert.ok(source.includes('run-rollout.cjs'));
    assert.ok(source.includes('unavailable'));
    assert.ok(source.includes('refused'));
    assert.ok(source.includes('technical waits') && ['ci', 'review', 'quota', 'lease', 'host'].every((kind) => source.includes(kind)));
    assert.ok(source.includes('historical records'));
    assert.ok(source.includes('inherited model') || source.includes('inherited models'));
  }
  assert.ok(deliver.includes('Workflow runtime uses Anthropic and Codex uses\nOpenAI'));
  assert.ok(deliver.includes('protected default-branch merge'));
});

test('GSD sync projects controller state without volatile owner or store fields', () => {
  const source = readRepo('plugins/delivery-pipeline/scripts/gsd-sync.cjs');
  const start = source.indexOf('function controllerStateProjection');
  const end = source.indexOf('function objectOrNull', start);
  assert.ok(start >= 0 && end > start, 'gsd-sync must expose a controller projection function');
  const projection = source.slice(start, end);
  assert.doesNotMatch(projection, /heartbeat_at|expires_at|acquired_at|updated_at|generation/);
  assert.ok(source.includes("const RUN_STORE = path.join(GRAPH_DIR, 'runs', 'runs.json')"));
  assert.ok(source.includes('wait_kind'));
  assert.ok(source.includes('receipt_status'));
  assert.ok(source.includes('usage_status'));
});

test('runtime smoke uses live capability-only probing and has no synthetic enable path', () => {
  const smoke = readRepo('tests/smoke/runtime-control-plane-smoke.sh');
  assert.ok(smoke.includes('--capability-only'));
  assert.ok(smoke.includes('run-rollout.cjs'));
  assert.ok(smoke.includes('status'));
  assert.ok(smoke.includes('unavailable'));
  assert.ok(smoke.includes('refused'));
  assert.doesNotMatch(smoke, /synthetic|fixture|fake|mock/i);
});

done();
