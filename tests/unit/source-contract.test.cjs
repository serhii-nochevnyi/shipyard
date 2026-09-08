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

suite('source contract');

test('state-sync passes its epic records into computeFront', () => {
  const src = readRepo('plugins/delivery-pipeline/scripts/state-sync.cjs');
  assert.ok(
    /epics:\s*epicInfo/.test(src),
    'state-sync.cjs must pass epicInfo into computeFront as `epics` — without it leftBehind() sees no epic records and every left_behind count reads 0'
  );
});

test('no script in the deterministic layer contains a NUL byte', () => {
  const files = tracked(
    'plugins/delivery-pipeline/scripts',
    'capabilities/delivery-pipeline/checks',
    'scripts'
  );
  assert.ok(files.length > 20, `expected the deterministic layer to hold scripts, git listed ${files.length}`);
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
