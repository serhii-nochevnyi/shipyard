'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'configure-codex-notify.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-notify-'));

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return result;
}

function fixture(config, notify) {
  const dir = path.join(root, String(fs.readdirSync(root).length));
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.toml');
  const wrapper = path.join(dir, 'codex-notify.cjs');
  const delegate = path.join(dir, 'delegate.json');
  fs.writeFileSync(configFile, config);
  return { dir, configFile, wrapper, delegate, notify };
}

suite('configure Codex notify — preserve the existing delegate');

test('wraps and restores an existing notify array', () => {
  const f = fixture('model = "gpt-5.6-luna"\nnotify = ["/old/client", "turn-ended"]\n\n[projects."/tmp"]\ntrust_level = "trusted"\n');
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate]);
  const installed = fs.readFileSync(f.configFile, 'utf8');
  assert.match(installed, /notify = \[.*codex-notify\.cjs/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, ['/old/client', 'turn-ended']);
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate, '--remove']);
  assert.match(fs.readFileSync(f.configFile, 'utf8'), /notify = \["\/old\/client", "turn-ended"\]/);
  assert.strictEqual(fs.existsSync(f.delegate), false);
});

test('adds and removes notify when the host had none', () => {
  const f = fixture('model = "gpt-5.6-luna"\n');
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate]);
  assert.match(fs.readFileSync(f.configFile, 'utf8'), /notify = \[/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, null);
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate, '--remove']);
  assert.strictEqual(fs.readFileSync(f.configFile, 'utf8'), 'model = "gpt-5.6-luna"\n');
});

test('keeps a new root notify before Codex tables', () => {
  const f = fixture('model = "gpt-5.6-luna"\n\n[agents]\nmax_depth = 1\n');
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate]);
  const installed = fs.readFileSync(f.configFile, 'utf8');
  assert.ok(installed.indexOf('notify = ') < installed.indexOf('[agents]'));
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate, '--remove']);
  assert.strictEqual(fs.readFileSync(f.configFile, 'utf8'), 'model = "gpt-5.6-luna"\n\n[agents]\nmax_depth = 1\n');
});

test('refuses to replace a wrapped notify without its delegate record', () => {
  const f = fixture('');
  fs.writeFileSync(f.configFile, `notify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(f.wrapper)}]\n`);
  const result = spawnSync(process.execPath, [SCRIPT, '--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /delegate record is missing/);
});

done();
