'use strict';

// Dependency-free test harness. The repo ships no node_modules and the container
// build must not depend on a test framework, so this is deliberately small.

const assert = require('assert');

let passed = 0;
const failures = [];
let currentSuite = '';

// Outcomes still in flight. A test body declared `async` returns a Promise the
// instant it is called, long before its assertions run, so its synchronous
// return says nothing about whether it passed. Judging one from that return
// marked every async test green — including ones asserting a falsehood — and
// then `done()` exited the process before the assertions ever executed. Each
// async body parks its settle-promise here instead, and `done()` waits for the
// lot before it counts anything.
const pending = [];
let tallied = false;

function suite(name) {
  currentSuite = name;
  console.log(`\n${name}`);
}

// A thrown value can be anything at all, including something falsy or something
// that is not an Error. Normalizing in ONE place — here, rather than at each
// call site — is the whole point: the previous shape normalized on the async
// path and not on the synchronous one, and that divergence was the defect.
function asError(thrown) {
  if (thrown instanceof Error) return thrown;
  // `String(Symbol())` throws, which would blow up inside the very handler that
  // exists to report a failure.
  return new Error(typeof thrown === 'symbol' ? thrown.toString() : String(thrown));
}

// The outcome is STATED by the caller and never inferred from the payload. It
// used to be read off `!error`, so a body that threw a FALSY value — `throw 0`,
// `throw ''`, `throw undefined`, `null`, `false`, `NaN` — was counted green:
// six loud failures each printing a tick. That is the same silent-green class
// this file exists to close, so the signal is now passed explicitly and no
// thrown value can ever be mistaken for one.
function record(suiteName, name, ok, thrown) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
    return;
  }
  const error = asError(thrown);
  failures.push({ suite: suiteName, name, error });
  console.log(`  ✗ ${name}`);
  console.log(`      ${error.message.split('\n').join('\n      ')}`);
}

function test(name, fn) {
  // Captured at declaration time: an async body settles after later suites have
  // already been declared, so reading `currentSuite` when it settles would file
  // the result under the wrong heading.
  const from = currentSuite;
  let result;
  try {
    result = fn();
  } catch (e) {
    record(from, name, false, e);
    return;
  }
  if (!result || typeof result.then !== 'function') {
    record(from, name, true);
    return;
  }
  // Asynchronous body: its ✓/✗ is printed when the promise settles, which is
  // necessarily AFTER every synchronous test in the file. A result that appears
  // out of source order is that, not a shuffled suite.
  pending.push(Promise.resolve(result).then(
    () => record(from, name, true),
    (e) => record(from, name, false, e)
  ));
}

function finish() {
  tallied = true;
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f.suite} › ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

function done() {
  // Every suite file ends with a bare `done()` and no caller awaits it, so with
  // nothing in flight this stays exactly as synchronous as it always was. With
  // pending bodies it returns immediately and the tally is printed from the
  // settle handler; the rejection branch below keeps an unawaited call from
  // trading one silent failure for another.
  if (!pending.length) {
    finish();
    return;
  }
  Promise.all(pending).then(finish, (e) => {
    console.log(`\nharness error while awaiting async tests: ${e && e.message}`);
    process.exit(1);
  });
}

// A body that never settles drains the event loop and exits 0 with no tally —
// the same silent green this harness exists to prevent. Say so instead of
// letting an unreported run look like a passing one.
process.on('exit', (code) => {
  if (tallied || code !== 0) return;
  console.log('\nharness: exited before every test settled — no tally was printed');
  process.exitCode = 1;
});

module.exports = { suite, test, done, assert };
