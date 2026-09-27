'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const UNIT_DIR = __dirname;
const RUN_SH = path.join(UNIT_DIR, 'run.sh');
const HARNESS = path.join(UNIT_DIR, 'assert-harness.cjs');

function unitCjsFiles() {
  return fs.readdirSync(UNIT_DIR).filter((f) => f.endsWith('.cjs')).map((f) => path.join(UNIT_DIR, f));
}

suite('test-hermeticity — no unit fixture creates its temp directory under a fixed /tmp path');

test('no file under tests/unit/ calls mkdtempSync with a literal /tmp argument', () => {
  const offenders = [];
  const pattern = new RegExp(String.raw`mkdtempSync\((['"` + '`' + String.raw`])/tmp`, 'g');
  for (const file of unitCjsFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = pattern.exec(content))) {
      const line = content.slice(0, match.index).split('\n').length;
      offenders.push(`${path.basename(file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

suite('test-hermeticity — run.sh is hermetic against a signing global git config');

test('run.sh exports GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM before the test loop, with commit.gpgsign off', () => {
  const content = fs.readFileSync(RUN_SH, 'utf8');
  const loopIndex = content.indexOf('for t in tests/unit/*.test.cjs');
  assert.ok(loopIndex > 0, 'run.sh must still contain the unit test loop');
  const before = content.slice(0, loopIndex);
  assert.ok(/export\s+GIT_CONFIG_GLOBAL=/.test(before),
    'GIT_CONFIG_GLOBAL must be exported before the test loop');
  assert.ok(/export\s+GIT_CONFIG_NOSYSTEM=1/.test(before),
    'GIT_CONFIG_NOSYSTEM must be exported before the test loop');
  assert.ok(/commit\.gpgsign\s+false/.test(before),
    'the config run.sh writes must set commit.gpgsign to false');
});

suite('test-hermeticity — assert-harness.cjs is hermetic when a test file is run directly');

test('assert-harness.cjs sets GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM when they are absent at require time', () => {
  const content = fs.readFileSync(HARNESS, 'utf8');
  assert.ok(/!process\.env\.GIT_CONFIG_GLOBAL/.test(content),
    'the harness must guard its fallback on GIT_CONFIG_GLOBAL being absent');
  assert.ok(/process\.env\.GIT_CONFIG_GLOBAL\s*=[^=]/.test(content),
    'the harness must set GIT_CONFIG_GLOBAL on process.env');
  assert.ok(/process\.env\.GIT_CONFIG_NOSYSTEM\s*=[^=]/.test(content),
    'the harness must set GIT_CONFIG_NOSYSTEM on process.env');
});

test('a fresh require of the harness makes git commit succeed in an os.tmpdir() repo despite a hostile global git config', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-hermeticity-'));
  try {
    const fakeHome = path.join(scratch, 'home');
    fs.mkdirSync(fakeHome);
    fs.writeFileSync(path.join(fakeHome, '.gitconfig'), [
      '[commit]', '\tgpgsign = true',
      '[user]', '\tsigningkey = 0000000000000000000000000000000000BEEF', '',
    ].join('\n'));
    const probe = path.join(scratch, 'probe.cjs');
    fs.writeFileSync(probe, [
      `const { done } = require(${JSON.stringify(HARNESS)});`,
      `const fs = require('fs');`,
      `const os = require('os');`,
      `const path = require('path');`,
      `const { execFileSync } = require('child_process');`,
      `const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-hermeticity-repo-'));`,
      `execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);`,
      `execFileSync('git', ['-C', repo, 'config', 'user.name', 'Hermeticity Probe']);`,
      `execFileSync('git', ['-C', repo, 'config', 'user.email', 'hermeticity@example.test']);`,
      `fs.writeFileSync(path.join(repo, 'f.txt'), 'x\\n');`,
      `execFileSync('git', ['-C', repo, 'add', 'f.txt']);`,
      `execFileSync('git', ['-C', repo, 'commit', '-qm', 'probe']);`,
      `process.stdout.write('OK ' + execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }));`,
      `done();`,
    ].join('\n'));
    const env = { ...process.env, HOME: fakeHome };
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', env, timeout: 20000 });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.status, 0, `probe must exit 0, got ${result.status}:\n${out}`);
    assert.ok(/^OK [0-9a-f]{40}/.test(result.stdout || ''), `probe must print a commit sha:\n${out}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

done();
