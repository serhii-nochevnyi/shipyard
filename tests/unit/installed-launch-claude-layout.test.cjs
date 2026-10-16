'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, describe, it } = require('node:test');
const lib = require('../smoke/installed-launch/lib.cjs');
const { probeClaudeRuntime } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');

const roots = [];

function descriptor() {
  const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-layout-')));
  roots.push(workRoot);
  const home = path.join(workRoot, 'home');
  const bin = path.join(workRoot, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  return { workRoot, home, bin };
}

const hostEnv = (fixture) => ({ PATH: [fixture.bin, process.env.PATH].join(path.delimiter), HOME: fixture.home });

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('requiring the fixture library', () => {
  it('has no side effect on TMPDIR', () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-layout-empty-')));
    roots.push(empty);
    const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', path.join(__dirname, '../smoke/installed-launch/lib.cjs')],
      { env: { ...process.env, TMPDIR: empty }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(empty), []);
  });
});

describe('stageClaudeLayout', () => {
  it('copies the plugin to the installed Claude path, makes the work-root TMPDIR and is idempotent', () => {
    const fixture = descriptor();
    const layout = lib.stageClaudeLayout(fixture);
    const host = path.join(fixture.home, '.claude/plugins/shipyard/scripts/claude-role-host.cjs');
    assert.equal(layout.scriptsDir, path.dirname(host));
    assert.ok(fs.readFileSync(host).equals(fs.readFileSync(path.join(lib.SOURCE, 'scripts/claude-role-host.cjs'))));
    assert.equal(layout.tmpDir, path.join(fixture.workRoot, 'tmp'));
    assert.ok(fs.statSync(layout.tmpDir).isDirectory());
    assert.deepEqual(layout.env, { TMPDIR: layout.tmpDir });
    assert.deepEqual(fs.readdirSync(fixture.workRoot).sort(), ['bin', 'home', 'tmp']);
    const again = lib.stageClaudeLayout(fixture);
    assert.deepEqual(again, layout);
  });

  it('refuses a descriptor outside the work root and creates nothing', () => {
    const fixture = descriptor();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-outside-')));
    roots.push(outside);
    for (const bad of [{ ...fixture, home: outside }, { ...fixture, bin: outside }]) {
      assert.throws(() => lib.stageClaudeLayout(bad), /inside the fixture work root/);
      assert.throws(() => lib.installFakeClaude(bad), /inside the fixture work root/);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(fixture.workRoot).sort(), ['bin', 'home']);
  });
});

describe('installFakeClaude', () => {
  it('satisfies probeClaudeRuntime', () => {
    const fixture = descriptor();
    const fake = lib.installFakeClaude(fixture);
    const probe = probeClaudeRuntime({ executable: fake.executable, env: hostEnv(fixture) });
    assert.equal(probe.status, 'available', JSON.stringify(probe));
    assert.deepEqual(fake.readLog(), [], 'a probe is not a native invocation');
  });

  it('logs argv and environment names, never values, for any other call', () => {
    const fixture = descriptor();
    const fake = lib.installFakeClaude(fixture);
    const result = spawnSync(fake.executable, ['--print', '--model', 'x'], {
      input: 'prompt', encoding: 'utf8', env: { ...hostEnv(fixture), SECRET_VALUE_CANARY: 'canary-value' },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = fake.readLog();
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].argv, ['--print', '--model', 'x']);
    assert.ok(lines[0].envNames.includes('PATH') && lines[0].envNames.includes('HOME'));
    assert.ok(lines[0].envNames.includes('SECRET_VALUE_CANARY'));
    assert.ok(!JSON.stringify(lines[0]).includes('canary-value'), 'values must never be logged');
    assert.ok(!lines[0].envNames.some((name) => /LOG/i.test(name)), 'the log path is not carried by an environment variable');
  });
});
