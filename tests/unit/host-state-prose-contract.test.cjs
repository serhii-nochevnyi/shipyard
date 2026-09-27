'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts');
const INVESTIGATE = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'investigate.md');
const DECOMPOSE = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'decompose.md');

const read = (file) => fs.readFileSync(file, 'utf8');
const normalized = (text) => text.replace(/\s+/g, ' ').toLowerCase();
const has = (text, phrase) => normalized(text).includes(normalized(phrase));

function namedScripts(text) {
  const names = new Set();
  for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([A-Za-z0-9_-]+\.cjs)/g)) names.add(match[1]);
  for (const match of text.matchAll(/`([A-Za-z0-9_-]+\.cjs)`/g)) names.add(match[1]);
  return names;
}

suite('host-state prose contract');

test('both command files explain the out-of-repo host state directory', () => {
  for (const [name, file] of [['investigate.md', INVESTIGATE], ['decompose.md', DECOMPOSE]]) {
    const text = read(file);
    assert.ok(has(text, '~/.local/state/shipyard'), `${name} must name ~/.local/state/shipyard`);
    assert.ok(has(text, 'outside the model worktree'), `${name} must describe the host state root as outside the model worktree`);
    assert.ok(has(text, 'not a leak'), `${name} must say the host state directory is not a leak`);
    assert.ok(has(text, 'not something to clean'), `${name} must say the host state directory is not something to clean`);
  }
});

test('investigate.md names the single-line re-dispatch and keeps the fan-out failed until all four lines seal', () => {
  const source = read(INVESTIGATE);
  assert.ok(has(source, 'Recovering one failed research line'));
  assert.ok(has(source, 'stays failed until all four'));
  assert.ok(has(source, 'claude-investigation-host.cjs'));
  assert.ok(has(source, '--request-file'));
  assert.ok(has(source, 'codex-delivery-host.cjs'));
  assert.ok(has(source, '--args-file'));
  assert.ok(has(source, 'sealedLines'));
});

test('both command files name both sealed research/decomposition envelope schemas', () => {
  for (const [name, file] of [['investigate.md', INVESTIGATE], ['decompose.md', DECOMPOSE]]) {
    const text = read(file);
    assert.ok(has(text, 'shipyard.research-result.v1'), `${name} must name shipyard.research-result.v1`);
    assert.ok(has(text, 'shipyard.decomposition-result.v1'), `${name} must name shipyard.decomposition-result.v1`);
  }
});

test('decompose.md names the planning-untrack.cjs migration with --confirm and the inverted target-project warning', () => {
  const source = read(DECOMPOSE);
  assert.ok(has(source, 'Planning files in target projects'));
  assert.ok(has(source, 'planning-untrack.cjs'));
  assert.ok(has(source, '--apply --confirm untrack-planning'));
  assert.ok(has(source, 'the warning fires when `.planning/` is tracked in a target project'));
});

test('every script named in either command file exists under plugins/delivery-pipeline/scripts', () => {
  const names = new Set([...namedScripts(read(INVESTIGATE)), ...namedScripts(read(DECOMPOSE))]);
  assert.ok(names.size >= 10, `expected many named scripts, found ${names.size}`);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, name)), `named script does not exist: ${name}`);
  }
});

done();
