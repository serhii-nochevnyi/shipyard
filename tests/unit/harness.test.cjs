'use strict';

// The harness under test is the harness running this file, so every check here
// runs a scratch suite in a CHILD process and reads its stdout and exit status.
// That is also what makes the revert demo honest: drop the old assert-harness
// beside a copy of this file and these same synchronous checks report the
// failures truthfully.
//
// What went wrong: `test()` judged a body from the value `fn()` returned. An
// `async` body returns a Promise immediately, so the try block always completed
// and the test was counted green before a single assertion had run — then
// `done()` called `process.exit()` and the assertions never ran at all. A
// three-test repro (one sync, two async, all asserting `1 === 2`) printed
// `2 passed, 1 failed`: two ticks for two falsehoods.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

// Injected rather than hardcoded, so a copy of this file placed next to a
// different assert-harness.cjs exercises THAT one.
const HARNESS = path.join(__dirname, 'assert-harness.cjs');

// Runs `body` as a standalone suite file and returns what the process printed
// and exited with.
function runSuite(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-harness-'));
  try {
    const file = path.join(dir, 'scratch-suite.cjs');
    fs.writeFileSync(file, [
      `const { suite, test, done, assert } = require(${JSON.stringify(HARNESS)});`,
      body,
    ].join('\n'));
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 20000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    // `spawnSync` has already reaped the child, so nothing is still reading this
    // directory. `finally` rather than a line after the spawn because a failed
    // write or a spawn that never starts must not leak the directory either —
    // one scratch dir per call, ~13 per run of this file, more on CI.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

suite('assert harness — an async body is judged by its assertions, not by its return');

const MIXED = `
suite('mixed');
test('sync body that passes', () => { assert.equal(1, 1); });
test('sync body that throws', () => { assert.equal(1, 2); });
test('async body that passes', async () => { await null; assert.equal(1, 1); });
test('async body that throws', async () => { await null; assert.equal(1, 2); });
done();
`;

test('an async body that throws is reported ✗ and never ✓', () => {
  const { out } = runSuite(MIXED);
  assert.ok(out.includes('✗ async body that throws'), `must fail, got:\n${out}`);
  // The removed behaviour, pinned as ABSENT: the old harness printed a tick here.
  assert.equal(occurrences(out, '✓ async body that throws'), 0, `no tick for a thrown assertion:\n${out}`);
});

test('an async body that throws exits the process 1 on its own', () => {
  // Deliberately the ONLY test in its suite: in MIXED the sync failure would
  // account for the exit status all by itself, so this fixture is what makes
  // the status attributable to the async body.
  const { status, out } = runSuite(`
suite('async failure alone');
test('async body that throws', async () => { await null; assert.equal(1, 2); });
done();
`);
  assert.equal(status, 1, `exit status must be 1, got ${status}:\n${out}`);
  assert.ok(out.includes('0 passed, 1 failed'), `and the tally must say so:\n${out}`);
});

test('an async body that passes is reported ✓ exactly once', () => {
  const { out } = runSuite(MIXED);
  assert.equal(occurrences(out, '✓ async body that passes'), 1, `exactly one tick:\n${out}`);
});

test('the tally counts every test exactly once, sync and async alike', () => {
  const { out } = runSuite(MIXED);
  assert.ok(out.includes('2 passed, 2 failed'), `tally must be 2/2, got:\n${out}`);
});

test('the tally is printed after the async results, not before them', () => {
  const { out } = runSuite(MIXED);
  // The proof that done() waited: an exit that raced the assertions would print
  // the tally first, or print no async result at all.
  assert.ok(out.indexOf('✓ async body that passes') < out.indexOf('2 passed, 2 failed'),
    `async results must precede the tally:\n${out}`);
});

test('an async failure is filed under the suite it was declared in', () => {
  // Declaration-time capture: the result settles after a later suite header has
  // already been printed, and must not be attributed to it.
  const { out } = runSuite(`
suite('first');
test('async body that throws', async () => { await null; assert.equal(1, 2); });
suite('second');
test('sync body that passes', () => { assert.equal(1, 1); });
done();
`);
  assert.ok(out.includes('- first › async body that throws'), `attributed to 'first', got:\n${out}`);
});

test('a rejection that is not an Error still fails, and prints something', () => {
  const { status, out } = runSuite(`
suite('rejects');
test('async body rejecting a string', () => Promise.reject('plain string'));
done();
`);
  assert.equal(status, 1, `must fail, got ${status}:\n${out}`);
  assert.ok(out.includes('✗ async body rejecting a string'), out);
  assert.ok(out.includes('plain string'), `the reason must survive:\n${out}`);
});

test('an all-passing suite with async bodies exits 0', () => {
  const { status, out } = runSuite(`
suite('all green');
test('sync body that passes', () => { assert.equal(1, 1); });
test('async body that passes', async () => { await null; assert.equal(1, 1); });
done();
`);
  assert.equal(status, 0, `exit status must be 0, got ${status}:\n${out}`);
  assert.ok(out.includes('2 passed, 0 failed'), out);
});

suite('assert harness — the synchronous path is unchanged');

test('a sync-only suite still fails on a thrown assertion', () => {
  const { status, out } = runSuite(`
suite('sync only');
test('sync body that passes', () => { assert.equal(1, 1); });
test('sync body that throws', () => { assert.equal(1, 2); });
done();
`);
  assert.equal(status, 1, `exit status must be 1, got ${status}:\n${out}`);
  assert.ok(out.includes('1 passed, 1 failed'), out);
});

test('a sync-only suite that passes exits 0 with its tally', () => {
  const { status, out } = runSuite(`
suite('sync only');
test('sync body that passes', () => { assert.equal(1, 1); });
done();
`);
  assert.equal(status, 0, `exit status must be 0, got ${status}:\n${out}`);
  assert.ok(out.includes('1 passed, 0 failed'), out);
});

suite('assert harness — a thrown value is not a signal');

// Regression on this PR, found by Copilot. `record()` inferred the outcome from
// the truthiness of what it was handed (`if (!error)`), and the two call sites
// disagreed: the async path normalized its rejection to an Error while the
// synchronous `catch` passed the raw value straight through. A sync body that
// threw anything FALSY was therefore recorded as a pass — `throw 0` printed ✓
// where before this ticket it printed ✗, a loud failure turned silent inside
// the file whose whole purpose is closing that class. These pin the entire
// falsy set as failing, which is also what makes the claim in the suite above
// — that the synchronous path is unchanged — true.

// Spelled as source literals so the generated name reads `sync body that
// throws 0`, and so the empty string is spelled `""`: safe inside the
// single-quoted test name it is interpolated into.
const FALSY_LITERALS = ['0', '""', 'undefined', 'null', 'false', 'NaN'];

test('a sync body that throws a FALSY value fails — the whole set, not just 0', () => {
  const { status, out } = runSuite([
    "suite('falsy throws');",
    ...FALSY_LITERALS.map((lit) => `test('sync body that throws ${lit}', () => { throw ${lit}; });`),
    'done();',
  ].join('\n'));
  for (const lit of FALSY_LITERALS) {
    assert.ok(out.includes(`✗ sync body that throws ${lit}`), `throw ${lit} must fail:\n${out}`);
    // The regression, pinned as ABSENT: every one of these printed a tick.
    assert.equal(occurrences(out, `✓ sync body that throws ${lit}`), 0,
      `no tick for throw ${lit}:\n${out}`);
  }
  // The tally separates "the harness failed them" from "the harness crashed" —
  // a normalizer that throws inside the catch handler prints neither ✗ nor this.
  assert.ok(out.includes(`0 passed, ${FALSY_LITERALS.length} failed`),
    `tally must count every falsy throw as a failure:\n${out}`);
  assert.equal(status, 1, `exit status must be 1, got ${status}:\n${out}`);
});

test('an async body rejecting a falsy value fails too — both paths agree', () => {
  // The path that was already correct, pinned so the two can no longer diverge.
  const { status, out } = runSuite(`
suite('async falsy');
test('async body rejecting 0', () => Promise.reject(0));
done();
`);
  assert.ok(out.includes('✗ async body rejecting 0'), `must fail:\n${out}`);
  assert.equal(occurrences(out, '✓ async body rejecting 0'), 0, `and never tick:\n${out}`);
  assert.ok(out.includes('0 passed, 1 failed'), out);
  assert.equal(status, 1, `exit status must be 1, got ${status}:\n${out}`);
});

test('a non-Error thrown synchronously reports its reason, not `undefined`', () => {
  // The second half of the same thread: `record()` read `.message` off whatever
  // it was handed, so a raw string throw printed `undefined` as the reason.
  // Deliberately the ONLY test in its suite — the count below looks for
  // `undefined` across the whole child output.
  const { status, out } = runSuite(`
suite('non-Error throw');
test('sync body that throws a string', () => { throw 'boom'; });
done();
`);
  assert.ok(out.includes('✗ sync body that throws a string'), `must fail:\n${out}`);
  assert.ok(out.includes('boom'), `the reason must survive:\n${out}`);
  assert.equal(occurrences(out, 'undefined'), 0, `and must not be reported as undefined:\n${out}`);
  assert.equal(status, 1, `exit status must be 1, got ${status}:\n${out}`);
});

test('a thrown Symbol is reported rather than crashing the harness', () => {
  // `String(Symbol())` throws a TypeError — inside the very handler that exists
  // to report a failure. The tally assertion is what pins the difference: a
  // harness that died here would print no tally at all.
  const { status, out } = runSuite(`
suite('symbol throw');
test('sync body that throws a Symbol', () => { throw Symbol('sym'); });
done();
`);
  assert.ok(out.includes('✗ sync body that throws a Symbol'), `must fail:\n${out}`);
  assert.ok(out.includes('Symbol(sym)'), `the reason must survive:\n${out}`);
  assert.ok(out.includes('0 passed, 1 failed'), `the tally proves it did not crash:\n${out}`);
  assert.equal(status, 1, `exit status must be 1, got ${status}:\n${out}`);
});

suite('assert harness — a run that never reaches its tally is not a pass');

test('a body that never settles exits non-zero instead of silently green', () => {
  // The same silent-green class from the other side: waiting on a promise that
  // never settles drains the event loop, and an unguarded process would exit 0
  // having printed no tally at all.
  const { status, out } = runSuite(`
suite('never settles');
test('async body that hangs', () => new Promise(() => {}));
done();
`);
  assert.notEqual(status, 0, `a run with no tally must not exit 0, got ${status}:\n${out}`);
  assert.ok(out.includes('no tally was printed'), `it must say why:\n${out}`);
  assert.equal(occurrences(out, 'passed,'), 0, `and it must not print a tally:\n${out}`);
});

done();
