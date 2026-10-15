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

test('run.sh snapshots every unit file and configures each private Git environment before direct launch', () => {
  const content = fs.readFileSync(RUN_SH, 'utf8');
  const inventory = content.indexOf('unit_files=(tests/unit/*.test.cjs)');
  const queue = content.indexOf('while ((unit_next < ${#unit_files[@]} || unit_active_count > 0))');
  const worker = content.indexOf('unit_worker="$unit_git_home/$unit_next"', queue);
  const launch = content.indexOf('node "${unit_files[$unit_next]}"', worker);
  assert.ok(inventory > 0 && queue > inventory && worker > queue && launch > worker,
    'complete inventory must be snapshotted before the queue and each direct worker launch');
  assert.ok(content.lastIndexOf('unit_files=(') < queue,
    'the snapshotted inventory must not be replaced while scheduling');
  assert.ok(content.slice(queue, worker).includes('unit_active_count < unit_workers'),
    'the queue must bound direct workers to the configured count');
  assert.ok(content.includes('unit_workers="${UNIT_WORKERS:-4}"'),
    'the worker count must default to four, the CI runner core count');
  const beforeLaunch = content.slice(worker, launch);
  assert.ok(beforeLaunch.includes('cp /dev/null "$unit_worker/gitconfig"'),
    'each worker must start with a fresh private Git config');
  for (const [key, value] of [
    ['user.name', "'Shipyard Unit Tests'"],
    ['user.email', "'unit-tests@shipyard.invalid'"],
    ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['init.defaultBranch', 'main'],
  ]) {
    assert.ok(beforeLaunch.includes(`git config --file "$unit_worker/gitconfig" ${key} ${value}`),
      `${key} must be configured privately before the worker starts`);
  }
  assert.ok(beforeLaunch.includes('GIT_CONFIG_GLOBAL="$unit_worker/gitconfig"'),
    'the direct Node command must receive its worker config');
  assert.ok(/GIT_CONFIG_NOSYSTEM=1\s*$/.test(beforeLaunch),
    'the direct Node command must disable system Git configuration');
  assert.ok(content.slice(launch).includes('unit_next=$((unit_next + 1))'),
    'the queue must advance through the snapshotted inventory');
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
