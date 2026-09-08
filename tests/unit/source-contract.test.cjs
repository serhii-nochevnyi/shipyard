'use strict';

// Assertions about the SHAPE of our own source — the facts a behavioural test
// cannot reach because they are properties of the file rather than of a run.
//
// Both of the ones here were measured as unasserted. The first is a single
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

const fs = require('fs');
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
  assert.ok(
    /epics:\s*\w+/.test(call),
    'state-sync.cjs must pass an `epics:` field into computeFront — without it leftBehind() sees no epic records and every left_behind count reads 0'
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

done();
