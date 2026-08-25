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

function record(suiteName, name, error) {
  if (!error) {
    passed++;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push({ suite: suiteName, name, error });
  console.log(`  ✗ ${name}`);
  console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
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
    record(from, name, e);
    return;
  }
  if (!result || typeof result.then !== 'function') {
    record(from, name, null);
    return;
  }
  // Asynchronous body: its ✓/✗ is printed when the promise settles, which is
  // necessarily AFTER every synchronous test in the file. A result that appears
  // out of source order is that, not a shuffled suite.
  pending.push(Promise.resolve(result).then(
    () => record(from, name, null),
    (e) => record(from, name, e instanceof Error ? e : new Error(String(e)))
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
