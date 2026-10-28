'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawn, spawnSync } = require('node:child_process');

const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const ownerName = path.basename(owner);
const checkName = path.basename(__filename);
const source = fs.readFileSync(owner, 'utf8');
const shards = require('./shard-files.cjs');
const counts = [1, 1, 19, 19, 24, 21];
const taskKeys = [1, 2, 3, 4, 5, 6].map(number => ownerName + '#integration-partition=' + number);
const suffixAnchor = "const assert = require('node:assert/strict');";
const suffixDigest = 'cb5dfeae2cefef24904aec36b41eaa544524d40fe062fe180d9bc59de21aae55';
assert.equal(crypto.createHash('sha256').update(source.slice(source.indexOf(suffixAnchor))).digest('hex'), suffixDigest);
function discover(args = []) {
  const result = spawnSync(process.execPath, [owner, '--list-integration-tests', ...args], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function capture(args = [], main = true, bytes = source) {
  const registered = [];
  const loaded = { exports: {} };
  const nativeRequire = Module.createRequire(owner);
  const fixtureRequire = name => name === 'node:test'
    ? { test(name, callback) { registered.push({ name, callback }); } } : nativeRequire(name);
  fixtureRequire.main = main ? loaded : module;
  const originalArgv = process.argv;
  try {
    process.argv = [process.execPath, owner, ...args];
    vm.runInThisContext(Module.wrap(bytes), { filename: owner })(
      loaded.exports, fixtureRequire, loaded, owner, __dirname);
  } finally { process.argv = originalArgv; }
  return registered;
}

test('actual default registrations are exactly the disjoint nonempty six-partition union', () => {
  const actual = capture();
  const names = actual.map(item => item.name);
  assert.equal(names.length, 85);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(discover(), names);
  const partitions = counts.map((count, index) => {
    const args = ['--integration-partition=' + (index + 1)];
    const selected = capture(args);
    assert.equal(selected.length, count);
    assert.deepEqual(discover(args), selected.map(item => item.name));
    for (const item of selected) {
      assert.equal(typeof item.callback, 'function');
      assert.equal(item.callback.toString(), actual.find(original => original.name === item.name).callback.toString());
    }
    return selected.map(item => item.name);
  });
  assert.deepEqual(partitions.flat().sort(), [...names].sort());
  assert.equal(new Set(partitions.flat()).size, names.length);
  for (const [index, runtime] of ['codex', 'claude'].entries()) {
    assert.deepEqual(partitions[index], names.filter(name => name.startsWith('D36 ' + runtime + ' aggregate ')));
  }
  assert.ok(partitions[2].includes('D36 codex ingress actual ASCII unit and fresh final retain original producer across cold readers'));
  assert.ok(partitions[3].includes('D36 codex geometry phase-shaped complete governing floor fits with at most three primary segments'));
});

test('missing, duplicate and unknown map entries are refused before any callback registration', () => {
  const start = source.indexOf('const integrationPartitionEntries = Object.freeze(');
  const end = source.indexOf('\nconst integrationPartitions = ', start);
  assert.ok(start >= 0 && end > start);
  const entries = JSON.parse(source.slice(start + 'const integrationPartitionEntries = Object.freeze('.length, end - 2));
  const replacements = [entries.slice(1), [...entries, entries[0]],
    entries.map((entry, index) => index === 0 ? ['unknown original case', entry[1]] : entry)];
  for (const changed of replacements) {
    const registered = [];
    const pending = [];
    const loaded = { exports: {} };
    const nativeRequire = Module.createRequire(owner);
    const fixtureRequire = name => name === 'node:test'
      ? { test(name) { registered.push(name); } } : nativeRequire(name);
    fixtureRequire.main = loaded;
    const originalArgv = process.argv;
    try {
      process.argv = [process.execPath, owner];
      const preamble = source.slice(0, start) + 'const integrationPartitionEntries = Object.freeze('
        + JSON.stringify(changed) + ');' + source.slice(end, source.indexOf(suffixAnchor));
      assert.throws(() => vm.runInNewContext(Module.wrap(preamble + '\ntest('
        + JSON.stringify(entries[0][0]) + ", () => { throw new Error('callback must not run'); });"),
        { process, queueMicrotask(callback) { pending.push(callback); } }, { filename: owner })(
        loaded.exports, fixtureRequire, loaded, owner, __dirname), /Invalid integration partition map|Unknown integration test/);
      assert.deepEqual(registered, []);
      for (const callback of pending) assert.throws(callback, /Incomplete integration partition registrations/);
    } finally { process.argv = originalArgv; }
  }
});

test('unknown, duplicate, malformed and out-of-range application selectors fail without callbacks', () => {
  for (const args of [
    ['--integration-partition=0'], ['--integration-partition=7'], ['--integration-partition=-1'],
    ['--integration-partition=01'], ['--integration-partition=1.0'], ['--integration-partition=all'],
    ['--integration-partition'], ['--integration-partition='], ['--unknown'], ['1'],
    ['--integration-partition=1', '--integration-partition=1'],
    ['--integration-partition=1', '--integration-partition=2'],
    ['--list-integration-tests', '--list-integration-tests'],
  ]) {
    const result = spawnSync(process.execPath, [owner, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Invalid or duplicate integration test argument/);
    assert.equal(result.stdout, '');
  }
});

test('imported fixture-source extraction ignores the importing process application arguments', () => {
  const loaded = new Module(owner, module);
  loaded.filename = owner;
  loaded.paths = Module._nodeModulePaths(__dirname);
  const originalLoad = Module._load;
  const originalArgv = process.argv;
  const registered = [];
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test(name, callback) { registered.push({ name, callback }); } }
      : originalLoad.call(this, name, ...args);
  };
  try {
    process.argv = [process.execPath, 'importing-owner.cjs', '--unknown', '--integration-partition=99'];
    loaded._compile(source + '\nmodule.exports = { fixture, publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, currentPartitionConsumer, originalPartitionSessions };\n', owner);
  } finally { Module._load = originalLoad; process.argv = originalArgv; }
  assert.deepEqual(registered.map(item => item.name), discover());
  assert.equal(Object.keys(loaded.exports).length, 6);
  for (const helper of Object.values(loaded.exports)) assert.equal(typeof helper, 'function');
  const original = capture();
  for (const item of registered)
    assert.equal(item.callback.toString(), original.find(test => test.name === item.name).callback.toString());
});

test('imported owners retain the existing appended original-stream regression fixture seam', () => {
  const name = 'owned integration original stream regression';
  const callback = "() => { throw new Error('fixture callback must not run during capture'); }";
  const selected = capture(['--unknown', '--integration-partition=99'], false,
    source + '\ntest(' + JSON.stringify(name) + ', ' + callback + ');\n');
  const original = capture();
  assert.deepEqual(selected.slice(0, -1).map(item => item.name), original.map(item => item.name));
  for (const [index, item] of original.entries())
    assert.equal(selected[index].callback.toString(), item.callback.toString());
  assert.equal(selected.at(-1).name, name);
  assert.equal(selected.at(-1).callback.toString(), callback);
});

test('node --test name patterns select actual registered names through default and partition entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-patterns-'));
  const probe = path.join(root, 'probe.cjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    for (const [partition, pattern] of [
      [null, '^D36 codex aggregate '], [1, '^D36 codex aggregate '],
      [2, '^D36 claude aggregate '], [3, '^D36 codex ingress actual ASCII unit '],
      [4, '^D36 codex geometry phase-shaped '],
      [5, '^D36 claude geometry phase-shaped '],
      [6, '^D36 codex positive observed caller '],
      [null, '^supported .* final preserves planted cross-unit mismatch:'],
    ]) {
      fs.writeFileSync(probe, `
const fs = require('node:fs'), vm = require('node:vm'), Module = require('node:module');
const nativeTest = require('node:test').test;
const file = ${JSON.stringify(owner)}, loaded = { exports: {} };
const originalRequire = Module.createRequire(file);
const fixtureRequire = name => name === 'node:test' ? { test(name) {
  return nativeTest(name, () => console.log('PARTITION_SELECTED ' + JSON.stringify(name)));
} } : originalRequire(name);
fixtureRequire.main = loaded;
process.argv = [process.execPath, file, ...${JSON.stringify(partition === null ? [] : ['--integration-partition=' + partition])}];
vm.runInThisContext(Module.wrap(fs.readFileSync(file, 'utf8')), { filename: file })(
  loaded.exports, fixtureRequire, loaded, file, ${JSON.stringify(__dirname)});
`);
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=' + pattern, probe], {
        env, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const selected = result.stdout.split('\n').filter(line => line.startsWith('# PARTITION_SELECTED '))
        .map(line => JSON.parse(line.slice('# PARTITION_SELECTED '.length)));
      const expected = capture(partition === null ? [] : ['--integration-partition=' + partition])
        .map(item => item.name).filter(name => new RegExp(pattern).test(name));
      assert.ok(expected.length > 0);
      assert.deepEqual(selected, expected);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function runnerFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'integration-queue-')));
  for (const dir of ['tests/unit', 'tests/smoke', 'scripts', 'plugins/delivery-pipeline/scripts',
    'capabilities/delivery-pipeline/checks']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'syntax.cjs'), '');
    fs.writeFileSync(path.join(root, dir, 'syntax.sh'), ':\n');
  }
  for (const file of ['run.sh', 'shard-files.cjs']) fs.copyFileSync(path.join(__dirname, file), path.join(root, 'tests/unit', file));
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.mkdirSync(path.join(root, 'tools'));
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    fs.symlinkSync(result.stdout.trim(), path.join(root, 'tools/git'));
  }
  const files = ['a.test.cjs', 'b.test.cjs', ownerName, 'z.test.cjs', checkName].sort();
  const body = `
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.cwd(), id = path.basename(__filename), args = process.argv.slice(2);
const envKeys = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'];
const dirs = envKeys.map(key => process.env[key]);
for (const dir of dirs) { assert.ok(dir.startsWith(root + '/scratch/')); assert.ok(fs.statSync(dir).isDirectory()); }
assert.equal(process.env.SHIPYARD_REQUIRE_OS_SANDBOX, '1');
assert.equal(process.env.COMMENT_POLICY_BASE, 'partition-fixture-base');
assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
const config = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8');
assert.match(config, /gpgsign = false/); assert.match(config, /defaultBranch = main/);
const event = { id, args, pid: process.pid, ppid: process.ppid, dirs, config: process.env.GIT_CONFIG_GLOBAL };
fs.appendFileSync(path.join(root, 'activity'), JSON.stringify({ pid: process.pid, active: true }) + '\\n');
fs.appendFileSync(path.join(root, 'events'), JSON.stringify(event) + '\\n');
console.log('buffered ' + id + ' ' + args.join(' '));
if (process.env.QUEUE_BLOCK === '1') {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],String(fs.existsSync(process.env.TMPDIR)));process.exit(0)});setInterval(()=>{},100);", path.join(root, String(process.pid) + '.child'), path.join(root, String(process.pid) + '.ended')], { stdio: 'ignore' });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); child.once('exit', () => process.exit(0)); });
  setInterval(() => {}, 100);
} else setTimeout(() => {
  fs.appendFileSync(path.join(root, 'activity'), JSON.stringify({ pid: process.pid, active: false }) + '\\n');
  process.exitCode = args[0] === '--integration-partition=' + process.env.QUEUE_FAIL ? 7 : 0;
}, 30);
`;
  for (const file of files) fs.writeFileSync(path.join(root, 'tests/unit', file), body);
  const weights = { 'a.test.cjs': 7, 'b.test.cjs': 6, 'z.test.cjs': 5 };
  for (const [index, seconds] of [1597.8, 1318.2, 1369.2, 1368, 1368, 1368.6].entries())
    weights[taskKeys[index]] = seconds;
  fs.writeFileSync(path.join(root, 'tests/unit/shard-weights.json'), JSON.stringify(weights));
  return { root, files, weights };
}
function runnerEnv(f, extra = {}) {
  return { ...process.env, PATH: path.join(f.root, 'tools') + path.delimiter + process.env.PATH,
    TMPDIR: path.join(f.root, 'scratch'), UNIT_SHARD: '', UNIT_WORKERS: '2',
    SHIPYARD_REQUIRE_OS_SANDBOX: '1', COMMENT_POLICY_BASE: 'partition-fixture-base',
    QUEUE_FAIL: '', QUEUE_BLOCK: '', ...extra };
}
function events(f) {
  const file = path.join(f.root, 'events');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

function eventTask(item) {
  if (item.id === ownerName) {
    assert.equal(item.args.length, 1);
    assert.match(item.args[0], /^--integration-partition=[1-6]$/);
    return item.id + '#' + item.args[0].slice(2);
  }
  assert.deepEqual(item.args, []);
  return item.id;
}
function fixtureTasks(f) {
  return [...f.files.filter(file => file !== ownerName), ...taskKeys].sort();
}

test('real queue assigns expanded tasks across six jobs exactly once and preserves default completeness and worker isolation', () => {
  const union = [];
  const thirds = [];
  let complete;
  for (const spec of ['', '1/6', '2/6', '3/6', '4/6', '5/6', '6/6', '1/3', '2/3', '3/3']) {
    const f = runnerFixture();
    try {
      const inventory = fixtureTasks(f);
      assert.equal(inventory.length, 10);
      const result = spawnSync('/bin/bash', [path.join(f.root, 'tests/unit/run.sh')], {
        cwd: '/', env: runnerEnv(f, { UNIT_SHARD: spec }), encoding: 'utf8', timeout: 20000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const selected = events(f);
      const actual = selected.map(eventTask).sort();
      const [index, count] = spec.split('/').map(Number);
      const expected = spec ? shards.assign(inventory, f.weights, count)[index - 1].files : inventory;
      assert.deepEqual(actual, expected);
      if (count === 6) union.push(...actual);
      else if (count === 3) thirds.push(...actual);
      else { complete = inventory; assert.deepEqual(actual, complete); }
      assert.equal(new Set(selected.map(item => item.pid)).size, selected.length);
      assert.equal(new Set(selected.map(item => item.ppid)).size, 1);
      for (let index = 0; index < selected[0].dirs.length; index++)
        assert.equal(new Set(selected.map(item => item.dirs[index])).size, selected.length);
      assert.equal(new Set(selected.map(item => item.config)).size, selected.length);
      const active = new Set();
      const activity = fs.readFileSync(path.join(f.root, 'activity'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(activity.length, selected.length * 2);
      for (const item of activity) {
        if (item.active) { assert.ok(!active.has(item.pid)); active.add(item.pid); }
        else { assert.ok(active.delete(item.pid)); }
        assert.ok(active.size <= 2, 'UNIT_WORKERS bounds the actual queue');
      }
      assert.equal(active.size, 0);
      if (selected.some(item => item.id === ownerName)) {
        assert.equal((result.stdout.match(/unit worker start:/g) || []).length, selected.length);
        assert.equal((result.stdout.match(/unit worker complete:/g) || []).length, selected.length);
      }
      for (const item of selected) assert.ok(result.stdout.includes('buffered ' + item.id + ' ' + item.args.join(' ')));
      assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
  for (const selected of [union, thirds]) {
    assert.deepEqual(selected.sort(), complete);
    assert.equal(new Set(selected).size, complete.length);
    assert.equal(selected.filter(task => task === checkName).length, 1);
    assert.ok(!selected.includes(ownerName));
  }
});

test('ordinary-only copied runners preserve their physical snapshot without a shard helper', () => {
  const f = runnerFixture();
  try {
    fs.unlinkSync(path.join(f.root, 'tests/unit/shard-files.cjs'));
    fs.unlinkSync(path.join(f.root, 'tests/unit', ownerName));
    const result = spawnSync('/bin/bash', [path.join(f.root, 'tests/unit/run.sh')], {
      cwd: '/', env: runnerEnv(f), encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(events(f).map(eventTask).sort(), f.files.filter(file => file !== ownerName));
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('task selector errors stop the real runner before workers launch', () => {
  for (const spec of ['0/6', '7/6', '1/0', '1/6/6', 'unknown']) {
    const f = runnerFixture();
    try {
      const result = spawnSync('/bin/bash', [path.join(f.root, 'tests/unit/run.sh')], {
        cwd: '/', env: runnerEnv(f, { UNIT_SHARD: spec }), encoding: 'utf8', timeout: 20000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2, result.stderr + result.stdout);
      assert.match(result.stderr, /shard/);
      assert.deepEqual(events(f), []);
      assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('a failed partition propagates status after all queued workers and preserves logs before cleanup', () => {
  const f = runnerFixture();
  try {
    const result = spawnSync('/bin/bash', [path.join(f.root, 'tests/unit/run.sh')], {
      cwd: '/', env: runnerEnv(f, { QUEUE_FAIL: '2' }), encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(events(f).length, 10);
    assert.deepEqual(events(f).map(eventTask).sort(), fixtureTasks(f));
    assert.match(result.stdout, /phase49-incremental-integration\.test\.cjs --integration-partition=2 status=7/);
    assert.match(result.stdout, /unit tests FAILED/);
    for (const number of [1, 2, 3, 4, 5, 6])
      assert.ok(result.stdout.includes('═══ tests/unit/' + ownerName + ' --integration-partition=' + number));
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'queue fixture timed out'); await pause(25); }
}
for (const signal of ['SIGINT', 'SIGTERM']) test(signal + ' cleans active partition process groups and descendants', async () => {
  const f = runnerFixture();
  const workerCount = signal === 'SIGINT' ? 2 : 4;
  const child = spawn('/bin/bash', [path.join(f.root, 'tests/unit/run.sh')], {
    cwd: '/', env: runnerEnv(f, { QUEUE_BLOCK: '1', UNIT_WORKERS: String(workerCount) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => output.push(bytes));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code));
  });
  try {
    await until(() => events(f).length === workerCount && events(f).every(item => fs.existsSync(path.join(f.root, item.pid + '.child'))));
    await pause(100);
    assert.equal(events(f).length, workerCount, 'UNIT_WORKERS bounds the active queue');
    assert.ok(fixtureTasks(f).length > workerCount, 'cancellation leaves queued tasks');
    assert.ok(events(f).every(item => fixtureTasks(f).includes(eventTask(item))));
    assert.equal((Buffer.concat(output).toString().match(/unit worker start:/g) || []).length, workerCount);
    child.kill(signal);
    assert.equal(await done, signal === 'SIGINT' ? 130 : 143);
    assert.equal(events(f).length, workerCount, 'the remaining queue must not launch after a signal');
    for (const item of events(f)) {
      const pid = Number(fs.readFileSync(path.join(f.root, item.pid + '.child')));
      await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
      assert.equal(fs.readFileSync(path.join(f.root, item.pid + '.ended'), 'utf8'), 'true');
      assert.ok(Buffer.concat(output).toString().includes('═══ tests/unit/' + item.id + (item.args.length ? ' ' + item.args[0] : '')));
    }
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
  } finally { child.kill('SIGTERM'); await done; fs.rmSync(f.root, { recursive: true, force: true }); }
});
