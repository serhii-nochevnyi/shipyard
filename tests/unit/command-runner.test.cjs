'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  diagnostic,
  redact,
  runBounded,
  runChecked,
} = require('../../plugins/delivery-pipeline/scripts/command-runner.cjs');

test('bounded runner returns normal output and status', () => {
  const result = runBounded(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 1000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.timedOut, false);
});

test('bounded runner turns a hung child into a safe timeout diagnostic', () => {
  const result = runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 25 });
  assert.equal(result.timedOut, true);
  assert.match(diagnostic(result), /timed out after 25ms/);
});

test('diagnostics redact credentials from output and command arguments', () => {
  const result = runBounded(process.execPath, [
    '-e', 'process.stderr.write("token=hunter2 Bearer abc123")',
    '--token=hunter2',
  ], { timeoutMs: 1000 });
  const message = diagnostic(result);
  assert.doesNotMatch(message, /hunter2|abc123/);
  assert.match(message, /REDACTED/);
  assert.doesNotMatch(result.command, /hunter2/);
  assert.equal(redact('password: hunter2'), 'password: [REDACTED]');
});

test('runChecked exposes a stable failure code', () => {
  assert.throws(
    () => runChecked(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 1000 }),
    (error) => error.code === 'COMMAND_FAILED' && /exited 7/.test(error.message),
  );
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createVerificationRunner,
  selectSandboxBackend,
} = require('../../plugins/delivery-pipeline/scripts/command-runner.cjs');

function usableRunner(options) {
  try {
    return createVerificationRunner(options);
  } catch (error) {
    if (error.code !== 'SANDBOX_UNAVAILABLE') throw error;
    if (process.env.SHIPYARD_REQUIRE_OS_SANDBOX === '1') throw error;
    return { unavailable: error.message };
  }
}

test('no supported backend refuses instead of falling back to a bare process', () => {
  assert.throws(() => selectSandboxBackend({ platform: 'win32' }), (error) => error.code === 'SANDBOX_UNAVAILABLE');
  assert.throws(() => selectSandboxBackend({ platform: 'linux', candidates: ['/nonexistent/bwrap'] }),
    (error) => error.code === 'SANDBOX_UNAVAILABLE');
  assert.throws(() => createVerificationRunner({ backend: { kind: 'bare', path: process.execPath } }),
    (error) => error.code === 'SANDBOX_UNAVAILABLE');
  const fakeBackend = { kind: 'bwrap', path: '/nonexistent/bwrap', digest: 'x' };
  assert.throws(() => createVerificationRunner({ backend: fakeBackend, readOnlyPaths: [os.tmpdir()] }),
    (error) => error.code === 'SANDBOX_UNAVAILABLE');
});

test('unsupported verification specs refuse before any process starts', () => {
  const runner = createVerificationRunner({
    backend: { kind: 'bwrap', path: '/nonexistent/bwrap', digest: 'x' }, probe: false, readOnlyPaths: [os.tmpdir()],
  });
  for (const spec of [
    { id: 'x', executable: 'node', argv: [], cwd: os.tmpdir(), timeoutMs: 10, maxOutputBytes: 10 },
    { id: 'x', executable: process.execPath, argv: [1], cwd: os.tmpdir(), timeoutMs: 10, maxOutputBytes: 10 },
    { id: 'x', executable: process.execPath, argv: [], cwd: os.tmpdir(), maxOutputBytes: 10 },
    { id: 'x', executable: process.execPath, argv: [], cwd: '/', timeoutMs: 10, maxOutputBytes: 10 },
  ]) {
    assert.throws(() => runner.run(spec), (error) => error.code === 'VERIFICATION_SPEC_UNSUPPORTED');
  }
});

test('real OS sandbox denies the hostile fixture protected read, outside-temp write and network', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-hostile-')));
  try {
    const repo = path.join(root, 'repo');
    const state = path.join(root, 'state');
    fs.mkdirSync(repo);
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'hmac.key'), 'protected-sentinel');
    fs.writeFileSync(path.join(repo, 'hostile.cjs'), [
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      'const out = {};',
      "try { out.read = fs.readFileSync(process.argv[2], 'utf8'); } catch (e) { out.read = 'denied:' + e.code; }",
      "try { fs.writeFileSync(process.argv[3], 'x'); out.write = 'written'; } catch (e) { out.write = 'denied:' + e.code; }",
      "try { fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'ok'), 'x'); out.temp = 'written'; } catch (e) { out.temp = 'denied:' + e.code; }",
      "const socket = net.connect({ host: '1.1.1.1', port: 80 });",
      "const finish = (value) => { out.net = value; process.stdout.write(JSON.stringify(out)); process.exit(0); };",
      "socket.on('connect', () => finish('connected'));",
      "socket.on('error', (e) => finish('denied:' + e.code));",
      "setTimeout(() => finish('denied:timeout'), 3000);",
    ].join('\n'));
    const runner = usableRunner({
      readOnlyPaths: [repo, path.dirname(process.execPath)], deniedPaths: [state], tempRoot: root,
    });
    if (runner.unavailable) {
      t.skip(`no usable OS sandbox on this host (${runner.unavailable}); CI must set SHIPYARD_REQUIRE_OS_SANDBOX=1`);
      return;
    }
    const result = runner.run({
      id: 'hostile', executable: process.execPath,
      argv: [path.join(repo, 'hostile.cjs'), path.join(state, 'hmac.key'), path.join(repo, 'escaped.txt')],
      cwd: repo, timeoutMs: 20_000, maxOutputBytes: 4096,
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.match(out.read, /^denied:/);
    assert.match(out.write, /^denied:/);
    assert.match(out.net, /^denied:/);
    assert.equal(out.temp, 'written');
    assert.equal(fs.existsSync(path.join(repo, 'escaped.txt')), false);
    assert.match(result.backend.digest, /^[0-9a-f]{64}$/);
    assert.match(result.profile_sha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real OS sandbox reports actual nonzero status and timeout', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-status-')));
  try {
    const runner = usableRunner({ readOnlyPaths: [root, path.dirname(process.execPath)], tempRoot: root });
    if (runner.unavailable) { t.skip(runner.unavailable); return; }
    const failed = runner.run({ id: 'fail', executable: process.execPath, argv: ['-e', 'process.exit(3)'],
      cwd: root, timeoutMs: 10_000, maxOutputBytes: 64 });
    assert.equal(failed.status, 3);
    const hung = runner.run({ id: 'hang', executable: process.execPath, argv: ['-e', 'setTimeout(()=>{},9000)'],
      cwd: root, timeoutMs: 100, maxOutputBytes: 64 });
    assert.equal(hung.timed_out, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
