'use strict';

const fs = require('fs');
const path = require('path');
const { test, done, assert } = require('./assert-harness.cjs');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline');
const COMMANDS = path.join(PLUGIN, 'commands');
const SCRIPTS = path.join(PLUGIN, 'scripts');

function namedScripts(text) {
  const names = new Set();
  for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([A-Za-z0-9_-]+\.cjs)/g)) names.add(match[1]);
  for (const match of text.matchAll(/plugins\/delivery-pipeline\/scripts\/([A-Za-z0-9_-]+\.cjs)/g)) names.add(match[1]);
  for (const match of text.matchAll(/`([A-Za-z0-9_-]+\.cjs)`/g)) names.add(match[1]);
  return names;
}

test('every script named in a command file exists under plugins/delivery-pipeline/scripts', () => {
  const files = fs.readdirSync(COMMANDS).filter((name) => name.endsWith('.md'));
  assert.ok(files.length >= 3, `expected the command files, found ${files.length}`);
  const allNames = new Set();
  for (const file of files) {
    const names = namedScripts(fs.readFileSync(path.join(COMMANDS, file), 'utf8'));
    for (const name of names) {
      allNames.add(name);
      assert.ok(fs.existsSync(path.join(SCRIPTS, name)), `${file} names a script that does not exist: ${name}`);
    }
  }
  assert.ok(allNames.size >= 10, `expected many named scripts, found ${allNames.size}`);
});

test('every pr-hygiene.cjs format/check invocation in deliver.md passes --repo', () => {
  const lines = fs.readFileSync(path.join(COMMANDS, 'deliver.md'), 'utf8').split('\n');
  const calls = [];
  lines.forEach((line, i) => {
    if (!/scripts\/pr-hygiene\.cjs (format|check)\b/.test(line)) return;
    let end = i;
    while (/\\\s*$/.test(lines[end]) && end + 1 < lines.length) end += 1;
    calls.push({ at: i + 1, text: lines.slice(i, end + 1).join('\n') });
  });
  assert.ok(calls.length >= 2, `expected a format and a check invocation, found ${calls.length}`);
  for (const call of calls) assert.match(call.text, /--repo\b/, `pr-hygiene.cjs call at line ${call.at} names no --repo`);
});

done();
