'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, describe, it } = require('node:test');

const DRIVER = path.resolve(__dirname, '../smoke/installed-launch-smoke.sh');
const roots = [];

function sandbox(scenarios) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-launch-driver-')));
  roots.push(root);
  const driver = path.join(root, 'installed-launch-smoke.sh');
  fs.copyFileSync(DRIVER, driver);
  fs.mkdirSync(path.join(root, 'installed-launch'));
  for (const [name, code] of Object.entries(scenarios)) {
    fs.writeFileSync(path.join(root, 'installed-launch', name + '.cjs'),
      `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'ran.log'))}, ${JSON.stringify(name + '\n')});\nprocess.exit(${code});\n`);
  }
  const run = (...args) => {
    const result = spawnSync('bash', [driver, ...args], { encoding: 'utf8' });
    const ran = fs.existsSync(path.join(root, 'ran.log')) ? fs.readFileSync(path.join(root, 'ran.log'), 'utf8').split('\n').filter(Boolean) : [];
    fs.rmSync(path.join(root, 'ran.log'), { force: true });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ran };
  };
  return { root, run };
}

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('installed-launch driver', () => {
  it('runs every scenario in sorted order, reports each and fails when one fails', () => {
    const { run } = sandbox({ 'scenario-b-fails': 3, 'scenario-a-passes': 0, 'scenario-c-passes': 0 });
    const result = run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.ran, ['scenario-a-passes', 'scenario-b-fails', 'scenario-c-passes']);
    assert.deepEqual(result.stdout.split('\n').filter(Boolean),
      ['PASS scenario-a-passes', 'FAIL scenario-b-fails (exit 3)', 'PASS scenario-c-passes']);
  });

  it('exits 0 when every scenario passes', () => {
    const { run } = sandbox({ 'scenario-one': 0, 'scenario-two': 0 });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.ran, ['scenario-one', 'scenario-two']);
  });

  it('runs only the scenario named exactly', () => {
    const { run } = sandbox({ 'scenario-one': 0, 'scenario-one-more': 3 });
    const result = run('scenario-one');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.ran, ['scenario-one']);
    assert.equal(result.stdout.trim(), 'PASS scenario-one');
  });

  it('exits 2 without running anything for an unknown, slashed, dotted or spaced name', () => {
    const { run } = sandbox({ 'scenario-one': 0 });
    for (const name of ['scenario-missing', '../scenario-one', 'scenario-one.cjs', 'scenario one', 'installed-launch/scenario-one', '']) {
      const result = run(name);
      assert.equal(result.status, 2, `${JSON.stringify(name)}: ${result.stdout}${result.stderr}`);
      assert.deepEqual(result.ran, [], `${JSON.stringify(name)} must not run a scenario`);
      assert.ok(result.stderr.includes('scenario-one'), 'the available names are listed');
    }
  });

  it('fails when no scenario exists', () => {
    const { run } = sandbox({});
    const result = run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.ran, []);
  });
});
