'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ensurePath = path.resolve(__dirname, '../../scripts/ensure-gsd-plugin.cjs');
const fake = `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.TEST_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const command = args.join(' ');
const codex = process.argv[1].endsWith('codex');
state.calls.push(args);
fs.writeFileSync(file, JSON.stringify(state));
if (state.fail === command) { console.error('fixture command failure'); process.exit(7); }
if (state.malformed === command) { console.log('{invalid'); process.exit(0); }
if (args[1] === 'marketplace') {
  if (args[2] === 'list') console.log(JSON.stringify(codex ? {marketplaces: state.marketplaces} : state.marketplaces));
  else state.marketplaces.push({name: 'gsd-core'});
} else if (args[1] === 'list') {
  state.lists = (state.lists || 0) + 1;
  if (state.lists === 2 && state.failVerification) process.exit(8);
  if (state.lists === 2 && state.malformedVerification) { console.log('{invalid'); process.exit(0); }
  console.log(JSON.stringify(codex ? {installed: state.plugins} : state.plugins));
} else state.plugins = state.postPlugins || [{pluginId: 'gsd-core@gsd-core', id: 'gsd-core@gsd-core', scope: 'user', version: '1.14.0', enabled: true}];
fs.writeFileSync(file, JSON.stringify(state));
`;

function plugin(runtime, extra = {}) {
  return { [runtime === 'codex' ? 'pluginId' : 'id']: 'gsd-core@gsd-core',
    ...(runtime === 'claude' ? { scope: 'user' } : {}),
    version: '1.14.0', enabled: true, ...extra };
}
function fixture(t, runtime, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-bootstrap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, runtime), fake, { mode: 0o755 });
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ marketplaces: [{ name: 'gsd-core' }],
    plugins: [plugin(runtime)], calls: [], ...overrides }));
  return {
    read: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    invoke: (twice = false) => spawnSync(process.execPath, ['-e', `
      const {ensure} = require(${JSON.stringify(ensurePath)});
      const first = ensure(${JSON.stringify(runtime)});
      console.log('RESULT:' + JSON.stringify(first));
      ${twice ? `console.log('RESULT:' + JSON.stringify(ensure(${JSON.stringify(runtime)})));` : ''}
    `], { encoding: 'utf8', env: { ...process.env, TEST_STATE: stateFile,
      PATH: dir + path.delimiter + process.env.PATH } })
  };
}
const listCount = state => state.calls.filter(a => a.join(' ') === 'plugin list --json').length;
const results = output => output.split('\n').filter(s => s.startsWith('RESULT:')).map(s => JSON.parse(s.slice(7)));

for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: enabled listing is returned unchanged with one list`, t => {
    const expected = plugin(runtime, { version: '9.8.7', evidence: 'original listing' });
    const f = fixture(t, runtime, { plugins: [expected] });
    const run = f.invoke();
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(results(run.stdout), [expected]);
    assert.deepEqual(f.read().calls, [['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']]);
  });
  test(`${runtime}: marketplace add still checks actual enabled plugin`, t => {
    const f = fixture(t, runtime, { marketplaces: [] });
    const run = f.invoke();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(listCount(f.read()), 1);
    assert.deepEqual(f.read().calls[1], ['plugin', 'marketplace', 'add', 'open-gsd/gsd-core']);
  });
  for (const missing of [true, false]) {
    const mutation = runtime === 'codex' ? 'add' : missing ? 'install' : 'enable';
    test(`${runtime}: ${missing ? 'missing' : 'disabled'} plugin mutates and verifies`, t => {
      const f = fixture(t, runtime, { marketplaces: [], plugins: missing ? [] : [plugin(runtime, { enabled: false })] });
      const run = f.invoke();
      assert.equal(run.status, 0, run.stderr);
      assert.equal(listCount(f.read()), 2);
      assert.deepEqual(f.read().calls.slice(-2), [['plugin', mutation, 'gsd-core@gsd-core'], ['plugin', 'list', '--json']]);
      assert.equal(results(run.stdout)[0].enabled, true);
    });
    test(`${runtime}: ${mutation} failure blocks success (${missing})`, t => {
      const f = fixture(t, runtime, { plugins: missing ? [] : [plugin(runtime, { enabled: false })],
        fail: `plugin ${mutation} gsd-core@gsd-core` });
      const run = f.invoke();
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /failed/);
      assert.deepEqual(results(run.stdout), []);
      assert.equal(listCount(f.read()), 1);
    });
  }
  for (const initiallyMissing of [true, false]) {
    for (const postPlugins of [[], [plugin(runtime, { enabled: false })],
      ...(runtime === 'claude' ? [[plugin(runtime, { scope: 'project' })]] : [])]) {
      test(`${runtime}: rejects unenabled or wrong-scope post-state (${initiallyMissing}) ${JSON.stringify(postPlugins)}`, t => {
        const f = fixture(t, runtime, { plugins: initiallyMissing ? [] : [plugin(runtime, { enabled: false })], postPlugins });
        const run = f.invoke();
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /is not enabled/);
        assert.equal(listCount(f.read()), 2);
        assert.deepEqual(results(run.stdout), []);
      });
    }
  }
  for (const overrides of [
    { fail: 'plugin marketplace list --json' },
    { marketplaces: [], fail: 'plugin marketplace add open-gsd/gsd-core' },
    { fail: 'plugin list --json' },
    { malformed: 'plugin marketplace list --json' },
    { malformed: 'plugin list --json' },
    { plugins: [], failVerification: true },
    { plugins: [], malformedVerification: true }
  ]) {
    test(`${runtime}: fails closed for ${JSON.stringify(overrides)}`, t => {
      const f = fixture(t, runtime, overrides);
      const run = f.invoke();
      assert.notEqual(run.status, 0);
      assert.ok(run.stderr.length > 0);
      assert.deepEqual(results(run.stdout), []);
      assert.doesNotMatch(run.stdout, /✓ GSD/);
    });
  }
  test(`${runtime}: another ensure in the same process obtains a fresh listing`, t => {
    const f = fixture(t, runtime);
    const run = f.invoke(true);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(listCount(f.read()), 2);
    assert.deepEqual(results(run.stdout), [plugin(runtime), plugin(runtime)]);
  });
}
test('claude: project scope does not substitute for user installation', t => {
  const f = fixture(t, 'claude', { plugins: [plugin('claude', { scope: 'project' })] });
  const run = f.invoke();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(listCount(f.read()), 2);
  assert.deepEqual(f.read().calls[2], ['plugin', 'install', 'gsd-core@gsd-core']);
  assert.equal(results(run.stdout)[0].scope, 'user');
});
