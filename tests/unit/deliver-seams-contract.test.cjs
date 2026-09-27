'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts');
const DELIVER = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'deliver.md');

const text = fs.readFileSync(DELIVER, 'utf8');
const lines = text.split('\n');

function namedScripts(source) {
  const names = new Set();
  for (const match of source.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([A-Za-z0-9_-]+\.cjs)/g)) names.add(match[1]);
  for (const match of source.matchAll(/`([A-Za-z0-9_-]+\.cjs)`/g)) names.add(match[1]);
  return names;
}

function fencedBlocks(source) {
  const blocks = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(source))) blocks.push(m[1]);
  return blocks;
}

suite('deliver.md: the dispatch entry point replaces hand-assembly');

test('names deliver-dispatch.cjs launch, wait and status', () => {
  assert.match(text, /deliver-dispatch\.cjs launch/, 'must dispatch through the entry point\'s launch verb');
  assert.match(text, /deliver-dispatch\.cjs wait/, 'must document the wait verb');
  assert.match(text, /deliver-dispatch\.cjs status/, 'must document the status verb');
});

test('names PR hygiene, the PR ledger, the sentinel preflight and the merge-gate status', () => {
  assert.match(text, /pr-hygiene\.cjs format/, 'must name pr-hygiene.cjs format');
  assert.match(text, /pr-hygiene\.cjs check/, 'must name pr-hygiene.cjs check');
  assert.match(text, /pr-ledger\.cjs record/, 'must name pr-ledger.cjs record');
  assert.match(text, /sentinel-preflight/, 'must name the sentinel preflight run via the entry point');
  assert.match(text, /merge-gate/, 'gate verdicts must be read as the merge-gate status');
});

suite('deliver.md: no hand-assembled request carries a ticket type into signals');

test('no `signals: { … }` object literal lists a bare `type` key', () => {
  const offenders = [];
  const re = /signals:\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(text))) {
    // A bare `type` shorthand property — the ticket's own D-27 type, forwarded
    // verbatim — is the INV-004 defect this test exists to keep fixed. A
    // `type: <value>` assignment (the research `facts`/`alternatives` signal)
    // is a different, legitimate shape: the negative lookahead excludes it.
    if (/\btype\b(?!\s*:)/.test(m[1])) offenders.push(m[0]);
  }
  assert.deepStrictEqual(offenders, [], `a signals object still lists a bare ticket type:\n${offenders.join('\n---\n')}`);
});

test('every remaining `signals.type` mention is the prohibition, never an instruction', () => {
  const idx = [...text.matchAll(/signals\.type/g)].map((m) => m.index);
  for (const at of idx) {
    const window = text.slice(Math.max(0, at - 80), at + 20);
    assert.match(window, /never/i, `signals.type is mentioned without a "never" nearby (an instruction, not a prohibition): …${window}…`);
  }
});

suite('deliver.md: no manual polling loop');

test('no fenced command block sleeps in a hand-written polling loop', () => {
  const offenders = fencedBlocks(text).filter((block) => /\bsleep\b/i.test(block));
  assert.deepStrictEqual(offenders, [], `a fenced command block still sleeps to poll:\n${offenders.join('\n---\n')}`);
});

suite('deliver.md: every pr-hygiene.cjs invocation for a ticket PR passes --repo');

test('every scripts/pr-hygiene.cjs format/check invocation names --repo', () => {
  const calls = [];
  lines.forEach((line, i) => {
    if (!/scripts\/pr-hygiene\.cjs (format|check)\b/.test(line)) return;
    const window = [line];
    let j = i;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) {
      j += 1;
      window.push(lines[j]);
    }
    calls.push({ start: i + 1, text: window.join('\n') });
  });
  assert.ok(calls.length >= 2, `expected a pr-hygiene.cjs format and a check invocation, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call.text, /--repo\b/, `pr-hygiene.cjs invocation at line ${call.start} names no --repo:\n${call.text}`);
  }
});

suite('deliver.md: no instruction writes a request file or JSON by hand for the executor');

test('the executor path is the entry point, not a hand-assembled args/request literal', () => {
  assert.doesNotMatch(text, /executors\.mjs args:/, 'the hand-assembled executors.mjs args literal must be gone');
  assert.doesNotMatch(
    text,
    /trusted delivery loop builds one\s+\n?\s*serializable packet/,
    'the executor context packet must be built by the entry point, not narrated as the orchestrator\'s own step'
  );
});

suite('deliver.md: every scripts/<name>.cjs path it names exists');

test('every named script exists under plugins/delivery-pipeline/scripts', () => {
  const names = namedScripts(text);
  assert.ok(names.size >= 10, `expected many named scripts, found ${names.size}`);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, name)), `named script does not exist: ${name}`);
  }
});

done();
