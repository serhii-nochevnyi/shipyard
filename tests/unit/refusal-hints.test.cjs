'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { HINTS, hintFor, formatHint } = require('../../plugins/delivery-pipeline/scripts/refusal-hints.cjs');

const REQUIRED_CODES = [
  'REFERENCE_UNAVAILABLE', 'INVALID_INPUT', 'UNSUPPORTED_ROLE', 'SCOPE_MISMATCH',
  'INVALID_SIGNAL', 'CONFLICTING_OVERRIDE', 'NONCOMPLIANT_RECEIPT', 'MISSING_RECEIPT',
  'INVALID_HOST', 'INVALID_ARTIFACT', 'INVALID_RESULT', 'RUNTIME_UNAVAILABLE',
  'STALE_GENERATED_AGENT', 'UNSUPPORTED_SELECTION',
];

const HOST_FILES = [
  'claude-decompose-host.cjs',
  'claude-investigation-host.cjs',
  'codex-decompose-host.cjs',
  'codex-delivery-host.cjs',
];

const SCRIPTS_DIR = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const BYPASS_TOKENS = /\b(bypass|skip|directly|other runtime|switch runtime)\b|SHIPYARD_STOP_GATE/i;

test('maps at least every required refusal code to a non-empty hint and remedy', () => {
  for (const code of REQUIRED_CODES) {
    assert.ok(Object.hasOwn(HINTS, code), `HINTS is missing ${code}`);
    const entry = HINTS[code];
    assert.equal(typeof entry.hint, 'string');
    assert.ok(entry.hint.trim().length > 0, `${code} hint must be non-empty`);
    assert.equal(typeof entry.remedy, 'string');
    assert.ok(entry.remedy.trim().length > 0, `${code} remedy must be non-empty`);
  }
});

test('HINTS and its entries are frozen', () => {
  assert.ok(Object.isFrozen(HINTS));
  for (const code of Object.keys(HINTS)) assert.ok(Object.isFrozen(HINTS[code]));
});

test('hintFor returns the same non-empty default entry for undefined, empty, and unknown codes', () => {
  const mappedEntries = new Set(Object.values(HINTS));
  for (const code of [undefined, '', 'NO_SUCH_CODE', null, 42]) {
    const entry = hintFor(code);
    assert.ok(entry, `hintFor(${JSON.stringify(code)}) must never be undefined`);
    assert.ok(entry.hint.trim().length > 0);
    assert.ok(entry.remedy.trim().length > 0);
    assert.equal(mappedEntries.has(entry), false, `hintFor(${JSON.stringify(code)}) must not reuse a mapped entry`);
  }
  assert.equal(hintFor(undefined), hintFor(''));
  assert.equal(hintFor(''), hintFor('NO_SUCH_CODE'));
});

test('hintFor returns the exact mapped entry for a known code', () => {
  assert.equal(hintFor('UNSUPPORTED_ROLE'), HINTS.UNSUPPORTED_ROLE);
});

test('formatHint renders hint[<CODE>]: <hint> — remedy: <remedy>', () => {
  const entry = HINTS.UNSUPPORTED_ROLE;
  assert.equal(
    formatHint('UNSUPPORTED_ROLE'),
    `hint[UNSUPPORTED_ROLE]: ${entry.hint} — remedy: ${entry.remedy}`
  );
  assert.match(formatHint('UNSUPPORTED_ROLE'), /^hint\[UNSUPPORTED_ROLE\]: .+ — remedy: .+$/);
});

test('formatHint uses UNKNOWN only when no code is present, and the real code otherwise', () => {
  assert.match(formatHint(undefined), /^hint\[UNKNOWN\]: /);
  assert.match(formatHint(''), /^hint\[UNKNOWN\]: /);
  assert.match(formatHint(null), /^hint\[UNKNOWN\]: /);
  assert.match(formatHint('NO_SUCH_CODE'), /^hint\[NO_SUCH_CODE\]: /);
});

test('no hint or remedy text ever proposes a bypass, a skip, a direct run, a runtime switch, or the stop-gate kill switch', () => {
  const entries = [...Object.values(HINTS), hintFor(undefined)];
  for (const entry of entries) {
    assert.doesNotMatch(entry.hint, BYPASS_TOKENS);
    assert.doesNotMatch(entry.remedy, BYPASS_TOKENS);
  }
});

test('all four hosts share this one map by requiring it directly', () => {
  for (const file of HOST_FILES) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    assert.ok(
      source.includes("require('./refusal-hints.cjs')"),
      `${file} must require('./refusal-hints.cjs') instead of keeping its own hint text`
    );
  }
});

test('the Codex config-fix and generated-agent-fix causes are registered and formatted', () => {
  for (const code of ['CODEX_CONFIG_FIX', 'CODEX_GENERATED_AGENT_FIX']) {
    assert.ok(Object.hasOwn(HINTS, code), `HINTS is missing ${code}`);
    assert.ok(Object.isFrozen(HINTS[code]));
    assert.equal(typeof HINTS[code].hint, 'string');
    assert.ok(HINTS[code].hint.trim().length > 0);
    assert.equal(typeof HINTS[code].remedy, 'string');
    assert.ok(HINTS[code].remedy.trim().length > 0);
    assert.match(formatHint(code), new RegExp(`^hint\\[${code}\\]: .+ — remedy: .+$`));
  }
  assert.match(HINTS.CODEX_CONFIG_FIX.remedy, /\.planning\/config\.json/);
  assert.match(HINTS.CODEX_CONFIG_FIX.remedy, /gsd-tune\.cjs --runtime codex/);
  assert.doesNotMatch(HINTS.CODEX_CONFIG_FIX.remedy, /install-shipyard-codex/);
  assert.match(HINTS.CODEX_GENERATED_AGENT_FIX.remedy, /install-shipyard-codex/);
  assert.doesNotMatch(HINTS.CODEX_GENERATED_AGENT_FIX.remedy, /gsd-tune\.cjs/);
});
