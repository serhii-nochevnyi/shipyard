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
  for (const match of text.matchAll(/`([A-Za-z0-9_-]+\.cjs)`/g)) names.add(match[1]);
  return names;
}

test('every script named in a command file exists under plugins/delivery-pipeline/scripts', () => {
  const files = fs.readdirSync(COMMANDS).filter((name) => name.endsWith('.md'));
  assert.ok(files.length >= 3, `expected the command files, found ${files.length}`);
  for (const file of files) {
    const names = namedScripts(fs.readFileSync(path.join(COMMANDS, file), 'utf8'));
    for (const name of names) {
      assert.ok(fs.existsSync(path.join(SCRIPTS, name)), `${file} names a script that does not exist: ${name}`);
    }
  }
});

done();
