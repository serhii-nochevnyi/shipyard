'use strict';

// Dependency-free test harness. The repo ships no node_modules and the container
// build must not depend on a test framework, so this is deliberately ~30 lines.

const assert = require('assert');

let passed = 0;
const failures = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n${name}`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ suite: currentSuite, name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(e.message).split('\n').join('\n      ')}`);
  }
}

function done() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f.suite} › ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

module.exports = { suite, test, done, assert };
