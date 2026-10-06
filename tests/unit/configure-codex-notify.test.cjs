'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'configure-codex-notify.cjs');
const WRAPPER = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'codex-notify.cjs');
const { findNotify } = require('../../scripts/configure-codex-notify.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-notify-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function run(args) {
  const result = invoke(args);
  assert.strictEqual(result.status, 0, result.stderr);
  return result;
}

function invoke(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 5000 });
}

function configureArgs(f) {
  return ['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate];
}

function notifyEnv(f, extra = {}) {
  return { ...process.env, SHIPYARD_NOTIFY_ACTIVE: '', SHIPYARD_CODEX_NOTIFY_ACTIVE: '',
    SHIPYARD_CODEX_NOTIFY_DELEGATE: f.delegate,
    SHIPYARD_CODEX_LOG_DB: path.join(f.dir, 'absent.sqlite'),
    SHIPYARD_GRAPH_DIR: path.join(f.dir, 'graph'), ...extra };
}

function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.fail('notification fixture exceeded its bounded wait');
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

test('installed wrapper delivers legitimate Computer Use argv and payload once with inherited guards', () => {
  const f = fixture('model = "gpt-5.6-luna"\n\n[agents]\nmax_depth = 1\n');
  f.wrapper = WRAPPER;
  const handler = path.join(f.dir, 'computer-use.cjs');
  const output = path.join(f.dir, 'delivery.json');
  fs.writeFileSync(handler, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(output + '.count')}, '1');
fs.writeFileSync(${JSON.stringify(output + '.tmp')}, JSON.stringify({
  argv: process.argv.slice(2), codexGuard: process.env.SHIPYARD_CODEX_NOTIFY_ACTIVE,
  legacyGuard: process.env.SHIPYARD_NOTIFY_ACTIVE, inherited: process.env.NOTIFY_FIXTURE_VALUE
}));
fs.renameSync(${JSON.stringify(output + '.tmp')}, ${JSON.stringify(output)});
`);
  const original = [process.execPath, handler, 'turn-ended', '--previous-notify', '["/original-notify","arg"]', 'argument with spaces'];
  const payload = JSON.stringify({ type: 'agent-turn-complete', cwd: f.dir, turn_id: 'fixture-turn' });
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(original)}\n` + fs.readFileSync(f.configFile, 'utf8'));
  fs.chmodSync(f.configFile, 0o640);
  run(configureArgs(f));
  assert.strictEqual(fs.statSync(f.delegate).mode & 0o777, 0o600);
  const installed = findNotify(fs.readFileSync(f.configFile, 'utf8')).argv;
  const result = spawnSync(installed[0], installed.slice(1).concat(payload), {
    env: notifyEnv(f, { NOTIFY_FIXTURE_VALUE: 'preserved' }), encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(result.status, 0, 'installed hook must exit safely');
  waitFor(() => fs.existsSync(output));
  const delivered = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(JSON.stringify(delivered.argv) === JSON.stringify(original.slice(2).concat(payload)), 'legitimate argv/payload must be preserved');
  assert.strictEqual(delivered.codexGuard, '1');
  assert.strictEqual(delivered.legacyGuard, '1');
  assert.strictEqual(delivered.inherited, 'preserved');
  assert.strictEqual(fs.readFileSync(output + '.count', 'utf8'), '1');
  run([...configureArgs(f), '--remove']);
  assert.deepStrictEqual(findNotify(fs.readFileSync(f.configFile, 'utf8')).argv, original);
  assert.strictEqual(fs.statSync(f.configFile).mode & 0o777, 0o640);
});

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
  const before = fs.readFileSync(f.configFile);
  for (const remove of [false, true]) {
    const result = invoke([...configureArgs(f), ...(remove ? ['--remove'] : [])]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, remove ? /without a valid delegate record/ : /delegate record is missing/);
    assert.ok(fs.readFileSync(f.configFile).equals(before));
    assert.strictEqual(fs.existsSync(f.delegate), false);
  }
});

test('repairs a stored computer-use delegate that calls the wrapper back', () => {
  const f = fixture('');
  const callback = ['/node', f.wrapper];
  const computerUse = ['/computer-use-client', 'turn-ended', '--previous-notify', JSON.stringify(callback)];
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(['/node', f.wrapper])}\n`);
  fs.writeFileSync(f.delegate, JSON.stringify({ version: 1, wrapper: f.wrapper, had_notify: true, delegate: computerUse }));
  const args = ['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate];
  run(args);
  const expected = ['/computer-use-client', 'turn-ended', '--previous-notify', '[]'];
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, expected);
  run(args);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, expected);
  run([...args, '--remove']);
  assert.deepStrictEqual(require('../../scripts/configure-codex-notify.cjs').findNotify(fs.readFileSync(f.configFile, 'utf8')).argv, expected);
});

test('preserves a legitimate previous notification handler', () => {
  const f = fixture('');
  const computerUse = ['/computer-use-client', 'turn-ended', '--previous-notify', JSON.stringify(['/original-notify', 'arg'])];
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(computerUse)}\n`);
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, computerUse);
});

test('remove cannot restore a recursive previous notification handler', () => {
  const f = fixture('');
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(['/node', f.wrapper])}\n`);
  fs.writeFileSync(f.delegate, JSON.stringify({ version: 1, wrapper: f.wrapper, had_notify: true,
    delegate: ['/computer-use-client', 'turn-ended', '--previous-notify', JSON.stringify(['/node', f.wrapper])] }));
  run(['--config', f.configFile, '--wrapper', f.wrapper, '--delegate-file', f.delegate, '--remove']);
  const restored = require('../../scripts/configure-codex-notify.cjs').findNotify(fs.readFileSync(f.configFile, 'utf8')).argv;
  assert.deepStrictEqual(restored, ['/computer-use-client', 'turn-ended', '--previous-notify', '[]']);
});


function sidecar(f, delegate) {
  fs.writeFileSync(f.delegate, JSON.stringify({ version: 1, wrapper: f.wrapper, had_notify: true, delegate }));
}

function configuredNotify(f) {
  return findNotify(fs.readFileSync(f.configFile, 'utf8')).argv;
}

function previousChain(depth, leaf) {
  let argv = leaf;
  for (let i = 0; i < depth; i++) argv = ['/computer-use-client', 'turn-ended', '--previous-notify', JSON.stringify(argv)];
  return argv;
}

test('direct stored self-delegation is dropped during reinstall and removal', () => {
  for (const remove of [false, true]) {
    const f = fixture('');
    fs.writeFileSync(f.configFile, `notify = ${JSON.stringify([process.execPath, f.wrapper])}\n`);
    sidecar(f, [process.execPath, f.wrapper]);
    if (!remove) {
      run(configureArgs(f));
      assert.strictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, null);
      run(configureArgs(f));
    }
    run([...configureArgs(f), '--remove']);
    assert.strictEqual(configuredNotify(f), null);
    assert.strictEqual(fs.existsSync(f.delegate), false);
  }
});

test('realpath and lexical aliases are recognized at the root and inside previous-notify', () => {
  for (const kind of ['symlink', 'lexical']) {
    const f = fixture('');
    let alias;
    if (kind === 'symlink') {
      fs.writeFileSync(f.wrapper, '// fixture wrapper\n');
      alias = path.join(f.dir, 'notify-alias.cjs');
      fs.symlinkSync(f.wrapper, alias);
    } else {
      alias = f.dir + '/unused/../codex-notify.cjs';
    }
    fs.writeFileSync(f.configFile, `notify = ${JSON.stringify([process.execPath, alias])}\n`);
    const callback = [process.execPath, alias];
    const nested = previousChain(2, callback);
    const expected = previousChain(2, []);
    sidecar(f, nested);
    run(configureArgs(f));
    assert.deepStrictEqual(configuredNotify(f), [process.execPath, f.wrapper]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, expected);
    run([...configureArgs(f), '--remove']);
    assert.deepStrictEqual(configuredNotify(f), expected);
    assert.strictEqual(fs.existsSync(f.delegate), false);
  }
});

test('fresh install sanitizes nested aliases while preserving unrelated argv and previous handlers', () => {
  const f = fixture('');
  fs.writeFileSync(f.wrapper, '// fixture wrapper\n');
  const alias = path.join(f.dir, 'alias.cjs');
  fs.symlinkSync(f.wrapper, alias);
  const original = ['/computer-use-client', 'turn-ended', 'argument with spaces',
    '--previous-notify', JSON.stringify(previousChain(1, [process.execPath, alias])),
    '--previous-notify', ' [ "/legitimate", "argument with spaces" ] '];
  const expected = [...original];
  expected[4] = JSON.stringify(previousChain(1, []));
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(original)} # retained comment\n`);
  run(configureArgs(f));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, expected);
  run([...configureArgs(f), '--remove']);
  assert.deepStrictEqual(configuredNotify(f), expected);
  assert.match(fs.readFileSync(f.configFile, 'utf8'), /# retained comment/);
});

test('supported upgrade at the same bundle path repairs the sidecar and preserves config symlink and mode', () => {
  const f = fixture('');
  const target = path.join(f.dir, 'actual-config.toml');
  fs.renameSync(f.configFile, target);
  fs.symlinkSync(target, f.configFile);
  fs.writeFileSync(f.wrapper, '// previous bundle version\n');
  const original = ['/computer-use-client', 'turn-ended', '--previous-notify', '["/legitimate","arg"]'];
  fs.writeFileSync(target, `notify = ${JSON.stringify(original)}\n\n[agents]\nmax_depth = 1\n`);
  fs.chmodSync(target, 0o640);
  run(configureArgs(f));
  fs.writeFileSync(f.wrapper, fs.readFileSync(WRAPPER));
  sidecar(f, previousChain(1, [process.execPath, f.wrapper]));
  run(configureArgs(f));
  const expected = previousChain(1, []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, expected);
  run(configureArgs(f));
  run([...configureArgs(f), '--remove']);
  assert.deepStrictEqual(configuredNotify(f), expected);
  assert.strictEqual(fs.lstatSync(f.configFile).isSymbolicLink(), true);
  assert.strictEqual(fs.statSync(target).mode & 0o777, 0o640);
  assert.ok(fs.readFileSync(target, 'utf8').includes('[agents]\nmax_depth = 1'));
});

test('nonrecursive previous handlers survive reinstall, upgrade and removal byte-for-byte in argv', () => {
  const f = fixture('');
  const original = ['/computer-use-client', 'turn-ended', '--previous-notify',
    ' [ "/legitimate", "arg" ] ', '--another-option', 'value with spaces'];
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(original)}\n`);
  run(configureArgs(f));
  run(configureArgs(f));
  fs.writeFileSync(f.wrapper, fs.readFileSync(WRAPPER));
  run(configureArgs(f));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, original);
  run([...configureArgs(f), '--remove']);
  assert.deepStrictEqual(configuredNotify(f), original);
  run([...configureArgs(f), '--remove']);
  assert.deepStrictEqual(configuredNotify(f), original);
});

test('depth 16 is accepted and deeper chains refuse without mutating config or sidecar', () => {
  const bounded = fixture('');
  const accepted = previousChain(16, []);
  fs.writeFileSync(bounded.configFile, `notify = ${JSON.stringify(accepted)}\n`);
  run(configureArgs(bounded));
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(bounded.delegate, 'utf8')).delegate) === JSON.stringify(accepted));
  run([...configureArgs(bounded), '--remove']);
  assert.ok(JSON.stringify(configuredNotify(bounded)) === JSON.stringify(accepted));

  const rejected = previousChain(17, []);
  for (const operation of ['install', 'reinstall', 'remove']) {
    const f = fixture('');
    fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(operation === 'install' ? rejected : [process.execPath, f.wrapper])}\n`);
    if (operation !== 'install') sidecar(f, rejected);
    const beforeConfig = fs.readFileSync(f.configFile);
    const beforeSidecar = fs.existsSync(f.delegate) ? fs.readFileSync(f.delegate) : null;
    const result = invoke([...configureArgs(f), ...(operation === 'remove' ? ['--remove'] : [])]);
    assert.strictEqual(result.status, 1, 'deep chain must refuse normally');
    assert.match(result.stderr, /chain is too deep/);
    assert.ok(fs.readFileSync(f.configFile).equals(beforeConfig));
    if (beforeSidecar) assert.ok(fs.readFileSync(f.delegate).equals(beforeSidecar));
    else assert.strictEqual(fs.existsSync(f.delegate), false);
  }
});

test('malformed previous-notify values refuse install, reinstall and removal without writes', () => {
  const malformed = ['{', '{}', '42', '[1]', '"handler"', undefined];
  for (const value of malformed) {
    const delegate = ['/computer-use-client', 'turn-ended', '--previous-notify'];
    if (value !== undefined) delegate.push(value);
    for (const operation of ['install', 'reinstall', 'remove']) {
      const f = fixture('');
      fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(operation === 'install' ? delegate : [process.execPath, f.wrapper])}\n`);
      if (operation !== 'install') sidecar(f, delegate);
      const beforeConfig = fs.readFileSync(f.configFile);
      const beforeSidecar = fs.existsSync(f.delegate) ? fs.readFileSync(f.delegate) : null;
      const result = invoke([...configureArgs(f), ...(operation === 'remove' ? ['--remove'] : [])]);
      assert.strictEqual(result.status, 1, 'malformed chain must refuse normally');
      assert.match(result.stderr, /invalid (previous notification|notification) delegate/);
      assert.ok(fs.readFileSync(f.configFile).equals(beforeConfig));
      if (beforeSidecar) assert.ok(fs.readFileSync(f.delegate).equals(beforeSidecar));
      else assert.strictEqual(fs.existsSync(f.delegate), false);
    }
  }
});

test('invalid stored delegates and malformed root notify refuse before mutation', () => {
  for (const delegate of [[1], {}]) {
    for (const remove of [false, true]) {
      const f = fixture('');
      fs.writeFileSync(f.configFile, `notify = ${JSON.stringify([process.execPath, f.wrapper])}\n`);
      sidecar(f, delegate);
      const beforeConfig = fs.readFileSync(f.configFile);
      const beforeSidecar = fs.readFileSync(f.delegate);
      const result = invoke([...configureArgs(f), ...(remove ? ['--remove'] : [])]);
      assert.strictEqual(result.status, 1);
      assert.ok(fs.readFileSync(f.configFile).equals(beforeConfig));
      assert.ok(fs.readFileSync(f.delegate).equals(beforeSidecar));
    }
  }
  for (const config of ['notify = "bad"\n', 'notify = [42]\n', 'notify = ["unterminated]\n']) {
    const f = fixture(config);
    const result = invoke(configureArgs(f));
    assert.strictEqual(result.status, 1);
    assert.strictEqual(fs.readFileSync(f.configFile, 'utf8'), config);
    assert.strictEqual(fs.existsSync(f.delegate), false);
  }
});

function hookProbe(f, source, extra = {}) {
  const result = spawnSync(process.execPath, ['-e', `
const fs = require('node:fs');
const cp = require('node:child_process');
const observer = require(${JSON.stringify(path.join(path.dirname(WRAPPER), 'session-observer.cjs'))});
${source}
`], { env: notifyEnv(f, extra), encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(result.status, 0, 'hook probe must exit safely');
  return JSON.parse(result.stdout);
}

test('both reentry guard names stop before observation, sidecar read or delegation', () => {
  const f = fixture('');
  for (const guard of ['SHIPYARD_CODEX_NOTIFY_ACTIVE', 'SHIPYARD_NOTIFY_ACTIVE']) {
    const result = hookProbe(f, `
let observations = 0, reads = 0, launches = 0;
observer.observeCodexDatabase = () => observations++;
cp.spawn = () => { launches++; throw new Error('unexpected launch'); };
const hook = require(${JSON.stringify(WRAPPER)});
const read = fs.readFileSync;
fs.readFileSync = (...args) => { if (args[0] === process.env.SHIPYARD_CODEX_NOTIFY_DELEGATE) reads++; return read(...args); };
const status = hook.main(['{}']);
console.log(JSON.stringify({ status, observations, reads, launches }));
`, { [guard]: '1' });
    assert.deepStrictEqual(result, { status: 0, observations: 0, reads: 0, launches: 0 });
  }
});

test('observation failure and synchronous delegation failure do not crash the hook', () => {
  const f = fixture('');
  sidecar(f, ['/fixture-handler', 'turn-ended']);
  const result = hookProbe(f, `
let observations = 0, launches = 0;
observer.observeCodexDatabase = () => { observations++; throw new Error('fixture observer failure'); };
cp.spawn = () => { launches++; throw new Error('fixture launch failure'); };
const status = require(${JSON.stringify(WRAPPER)}).main(['{}']);
console.log(JSON.stringify({ status, observations, launches }));
`);
  assert.deepStrictEqual(result, { status: 0, observations: 1, launches: 1 });
});

test('missing, malformed and empty sidecars still observe once and do not delegate', () => {
  const f = fixture('');
  for (const contents of [null, '{', '{"version":2,"delegate":["/handler"]}', '{"version":1,"delegate":null}', '{"version":1,"delegate":[]}']) {
    if (contents === null) fs.rmSync(f.delegate, { force: true });
    else fs.writeFileSync(f.delegate, contents);
    const result = hookProbe(f, `
let observations = 0, launches = 0;
observer.observeCodexDatabase = () => observations++;
cp.spawn = () => { launches++; throw new Error('unexpected launch'); };
const status = require(${JSON.stringify(WRAPPER)}).main(['{}']);
console.log(JSON.stringify({ status, observations, launches }));
`);
    assert.deepStrictEqual(result, { status: 0, observations: 1, launches: 0 });
  }
});

test('detached spawn uses inherited env, exact argv and payload, unref and an async error listener', () => {
  const f = fixture('');
  const delegate = ['/fixture-handler', 'turn-ended', 'argument with spaces'];
  sidecar(f, delegate);
  const result = hookProbe(f, `
const { EventEmitter } = require('node:events');
let observed = 0, launched = 0, unrefed = 0, correct = false;
observer.observeCodexDatabase = () => observed++;
cp.spawn = (command, argv, options) => {
  launched++;
  correct = command === '/fixture-handler' && JSON.stringify(argv) === JSON.stringify(['turn-ended', 'argument with spaces', '{}'])
    && options.detached === true && options.stdio === 'ignore'
    && options.env.NOTIFY_FIXTURE_VALUE === 'preserved'
    && options.env.SHIPYARD_CODEX_NOTIFY_ACTIVE === '1' && options.env.SHIPYARD_NOTIFY_ACTIVE === '1';
  const child = new EventEmitter();
  child.unref = () => unrefed++;
  process.nextTick(() => child.emit('error', new Error('fixture asynchronous launch failure')));
  return child;
};
const status = require(${JSON.stringify(WRAPPER)}).main(['{}']);
process.nextTick(() => console.log(JSON.stringify({ status, observed, launched, unrefed, correct })));
`, { NOTIFY_FIXTURE_VALUE: 'preserved' });
  assert.deepStrictEqual(result, { status: 0, observed: 1, launched: 1, unrefed: 1, correct: true });
});

test('real missing executable emits a handled async launch error and exits zero', () => {
  const f = fixture('');
  sidecar(f, [path.join(f.dir, 'missing-executable'), 'turn-ended']);
  const result = spawnSync(process.execPath, [WRAPPER, '{}'], {
    env: notifyEnv(f), encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(result.status, 0, 'asynchronous ENOENT must be handled');
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stderr, '');
});

function ownedProcesses(f) {
  return fs.readdirSync(f.dir).filter(name => /^pid-\d+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(f.dir, name), 'utf8')));
}

function activeProcesses(f) {
  return ownedProcesses(f).filter(record => {
    if (fs.existsSync(path.join(f.dir, `pid-${record.pid}.done`))) return false;
    try { process.kill(record.pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  });
}

function disposeCallback(f) {
  fs.writeFileSync(path.join(f.dir, 'stop'), '');
  const end = Date.now() + 2000;
  do {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  } while (activeProcesses(f).length && Date.now() < end);
  for (const record of activeProcesses(f)) {
    try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const termEnd = Date.now() + 500;
  while (activeProcesses(f).length && Date.now() < termEnd) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  for (const record of activeProcesses(f)) {
    try { process.kill(record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  waitFor(() => activeProcesses(f).length === 0, 1000);
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test('real A→B→A callback inherits the guard and stops within an independent four-invocation cap', () => {
  const f = fixture('');
  f.wrapper = WRAPPER;
  const handler = path.join(f.dir, 'callback.cjs');
  const deadline = Date.now() + 5000;
  fs.writeFileSync(handler, `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = ${JSON.stringify(f.dir)};
const deadline = ${deadline};
const stopped = () => Date.now() >= deadline || !fs.existsSync(dir) || fs.existsSync(path.join(dir, 'stop'));
if (stopped()) process.exit(0);
let slot = 0;
for (let i = 1; i <= 4; i++) {
  try { fs.mkdirSync(path.join(dir, 'invocation-' + i)); slot = i; break; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
if (!slot) process.exit(0);
const record = (pid, ppid, type) => {
  const file = path.join(dir, 'pid-' + pid + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ pid, ppid, type }));
  fs.renameSync(file + '.tmp', file);
};
const done = pid => { if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'pid-' + pid + '.done'), ''); };
record(process.pid, process.ppid, 'delegate');
process.on('exit', () => done(process.pid));
fs.writeFileSync(path.join(dir, 'invocation-' + slot, 'guards.json'), JSON.stringify({
  codex: process.env.SHIPYARD_CODEX_NOTIFY_ACTIVE, legacy: process.env.SHIPYARD_NOTIFY_ACTIVE
}));
if (slot < 4 && !stopped()) {
  // The legitimate handler calls the real wrapper with its supported inherited
  // environment, just as a previous-notify callback does. Never clear the guard.
  const child = spawn(process.execPath, [${JSON.stringify(WRAPPER)}, process.argv.at(-1)], {
    env: process.env, stdio: 'ignore'
  });
  if (child.pid) record(child.pid, process.pid, 'wrapper');
  const timer = setTimeout(() => { if (child.pid) child.kill('SIGKILL'); }, 1500);
  child.on('error', () => { clearTimeout(timer); });
  child.on('close', () => { clearTimeout(timer); if (child.pid) done(child.pid); });
}
`);
  const original = [process.execPath, handler, 'turn-ended'];
  fs.writeFileSync(f.configFile, `notify = ${JSON.stringify(original)}\n`);
  try {
    run(configureArgs(f));
    const installed = configuredNotify(f);
    const result = spawnSync(installed[0], installed.slice(1).concat('{}'), {
      env: notifyEnv(f), encoding: 'utf8', timeout: 2000,
    });
    assert.strictEqual(result.status, 0, 'initial fixture wrapper must exit safely');
    assert.ok(Number.isInteger(result.pid));
    fs.writeFileSync(path.join(f.dir, `pid-${result.pid}.json`), JSON.stringify({ pid: result.pid, ppid: process.pid, type: 'wrapper' }));
    fs.writeFileSync(path.join(f.dir, `pid-${result.pid}.done`), '');
    waitFor(() => fs.existsSync(path.join(f.dir, 'invocation-1', 'guards.json')) && activeProcesses(f).length === 0);
    const settled = Date.now() + 1000;
    while (Date.now() < settled) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    waitFor(() => activeProcesses(f).length === 0);
    const invocations = fs.readdirSync(f.dir).filter(name => /^invocation-\d+$/.test(name)).length;
    assert.strictEqual(invocations, 1, 'indirect callback must delegate only once');
    assert.ok(ownedProcesses(f).length <= 8, 'independent process cap must hold');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'invocation-1', 'guards.json'), 'utf8')), { codex: '1', legacy: '1' });
    assert.strictEqual(ownedProcesses(f).filter(record => record.type === 'wrapper').length, 2);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.delegate, 'utf8')).delegate, original);
  } finally {
    disposeCallback(f);
  }
});

done();
