'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { main, installClaudeMarketplace, installCodexMarketplace } =
  require('../../scripts/install-shipyard-marketplace.cjs');

function fixture({ pinned = true, failInstall = false } = {}) {
  let marketplace = { name: 'shipyard', source: 'github', repo: 'serhii-nochevnyi/shipyard',
    ...(pinned ? { ref: 'v0.64.0' } : {}) };
  let plugin = { id: 'shipyard@shipyard', version: '0.64.0', enabled: true };
  const calls = [];
  const read = (_command, args) => args[1] === 'marketplace'
    ? marketplace ? [marketplace] : [] : plugin ? [plugin] : [];
  const execute = (_command, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'marketplace') {
      if (args[2] === 'remove') { marketplace = undefined; plugin = undefined; }
      if (args[2] === 'add') {
        const source = args[3];
        const [repo, ref] = source.split('@');
        marketplace = { name: 'shipyard', source: 'github', repo, ...(ref ? { ref } : {}) };
      }
    } else if (args[1] === 'install') {
      if (failInstall && !marketplace.ref) throw new Error('new plugin unavailable');
      plugin = { id: 'shipyard@shipyard', version: marketplace.ref || '0.65.1', enabled: true };
    }
  };
  return { read, execute, calls, state: () => ({ marketplace, plugin }) };
}

test('upgrades a pinned Claude marketplace to the current unpinned source', () => {
  const host = fixture();
  installClaudeMarketplace('serhii-nochevnyi/shipyard', host.execute, host.read);
  assert.equal(host.state().marketplace.ref, undefined);
  assert.equal(host.state().plugin.version, '0.65.1');
  assert.deepEqual(host.calls, ['plugin marketplace remove shipyard',
    'plugin marketplace add serhii-nochevnyi/shipyard', 'plugin install shipyard@shipyard']);
});

test('restores pinned marketplace and plugin if replacement install fails', () => {
  const host = fixture({ failInstall: true });
  assert.throws(() => installClaudeMarketplace('serhii-nochevnyi/shipyard', host.execute, host.read),
    /new plugin unavailable/);
  assert.equal(host.state().marketplace.ref, 'v0.64.0');
  assert.equal(host.state().plugin.version, 'v0.64.0');
});

test('refreshes an existing unpinned marketplace in place', () => {
  const host = fixture({ pinned: false });
  installClaudeMarketplace('serhii-nochevnyi/shipyard', host.execute, host.read);
  assert.deepEqual(host.calls, ['plugin marketplace update shipyard',
    'plugin update shipyard@shipyard']);
});

test('refreshes the Codex Git snapshot before reinstalling from the same source', () => {
  const calls = [];
  const read = (_command, args) => args[1] === 'marketplace'
    ? { marketplaces: [{ name: 'shipyard', marketplaceSource: { sourceType: 'git',
      source: 'https://github.com/serhii-nochevnyi/shipyard.git' } }] }
    : { installed: [] };
  const execute = (_command, args) => calls.push(args.join(' '));
  installCodexMarketplace('serhii-nochevnyi/shipyard', execute, read);
  assert.deepEqual(calls, ['plugin marketplace upgrade shipyard',
    'plugin add shipyard@shipyard']);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupCodexHost, installKindEnv, dogfoodHome } = require('../../scripts/install-shipyard-marketplace.cjs');

function localSource() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-source-'));
}

test('refuses a dirty local Claude source before any claude plugin call', () => {
  const host = fixture();
  const reads = [];
  const read = (...args) => { reads.push(args); return host.read(...args); };
  const inspect = () => ({ version: '0.66.0', sha: 'aaa', tagSha: 'aaa', dirty: true });
  assert.throws(() => installClaudeMarketplace(localSource(), host.execute, read, inspect),
    /uncommitted changes.*--dogfood-root/s);
  assert.deepEqual(host.calls, []);
  assert.deepEqual(reads, []);
});

test('refuses an untagged local Claude source before any claude plugin call', () => {
  const host = fixture();
  const inspect = () => ({ version: '0.66.0', sha: 'bbb', tagSha: 'aaa', dirty: false });
  assert.throws(() => installClaudeMarketplace(localSource(), host.execute, host.read, inspect),
    /not the commit tagged v0\.66\.0.*install-shipyard-claude-hook\.sh --dogfood-root/s);
  assert.deepEqual(host.calls, []);
});

test('installs a tagged clean local Claude source as before', () => {
  const host = fixture();
  const inspect = () => ({ version: '0.66.0', sha: 'aaa', tagSha: 'aaa', dirty: false });
  const source = localSource();
  installClaudeMarketplace(source, host.execute, host.read, inspect);
  assert.deepEqual(host.calls, ['plugin marketplace remove shipyard',
    `plugin marketplace add ${source}`, 'plugin install shipyard@shipyard']);
});

function codexHome(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-codex-'));
  const dir = path.join(home, 'plugins/cache/shipyard/shipyard', version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-build.json'), '{}');
  return home;
}

// @contract: Isolates env vars the dedicated-home formula reads, so tests never touch the real ~/.codex.
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function codexSetup(source, inspect, { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-sandbox-')),
  codexHomeEnv } = {}) {
  const version = '0.66.0+codex.0123456789abcdef';
  const home = codexHome(version);
  const runs = [];
  const read = () => ({ installed: [{ pluginId: 'shipyard@shipyard', enabled: true, version }] });
  return withEnv({ HOME: sandbox, XDG_STATE_HOME: path.join(sandbox, 'xdg-state'), CODEX_HOME: codexHomeEnv }, () => {
    setupCodexHost(source, (command, args, env) => runs.push({ command, args, env }), read, inspect, home);
    assert.equal(runs.length, 1);
    assert.match(runs[0].args[0], /host\/scripts\/bootstrap-shipyard-plugin\.cjs$/);
    return runs[0].env;
  });
}

test('a local Codex source passes dogfood with its sha to the host setup', () => {
  const env = codexSetup(localSource(), () => ({ version: '0.66.0', sha: 'ccc', tagSha: 'aaa', dirty: true }));
  assert.equal(env.SHIPYARD_INSTALL_KIND, 'dogfood');
  assert.equal(env.SHIPYARD_SOURCE_SHA, 'ccc');
  assert.equal(env.SHIPYARD_SOURCE_DIRTY, '1');
});

test('a git Codex source passes release to the host setup', () => {
  const env = codexSetup('serhii-nochevnyi/shipyard', () => { throw new Error('must not inspect'); });
  assert.equal(env.SHIPYARD_INSTALL_KIND, 'release');
});

test('installKindEnv returns SHIPYARD_SOURCE_ROOT for a dogfood checkout', () => {
  const source = localSource();
  const env = installKindEnv(source, () => ({ version: '0.66.0', sha: 'aaa', tagSha: 'bbb', dirty: false }));
  assert.equal(env.SHIPYARD_INSTALL_KIND, 'dogfood');
  assert.equal(env.SHIPYARD_SOURCE_ROOT, fs.realpathSync(source));
});

test('installKindEnv omits SHIPYARD_SOURCE_ROOT for a tagged release checkout', () => {
  const source = localSource();
  const env = installKindEnv(source, () => ({ version: '0.66.0', sha: 'aaa', tagSha: 'aaa', dirty: false }));
  assert.equal(env.SHIPYARD_INSTALL_KIND, 'release');
  assert.equal('SHIPYARD_SOURCE_ROOT' in env, false);
});

// @contract: Mirrors codexSetup's own env shape, so the expected path is computed under the same sandbox.
function expectedDedicatedHome(sandbox, source) {
  return withEnv({ HOME: sandbox, XDG_STATE_HOME: path.join(sandbox, 'xdg-state') },
    () => dogfoodHome('codex', fs.realpathSync(source)));
}

test('a dogfood Codex install with CODEX_HOME unset targets the dedicated per-checkout home', () => {
  const source = localSource();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-sandbox-'));
  const inspect = () => ({ version: '0.66.0', sha: 'ddd', tagSha: 'aaa', dirty: true });
  const env = codexSetup(source, inspect, { sandbox });
  const expected = expectedDedicatedHome(sandbox, source);
  assert.equal(env.CODEX_HOME, expected);
  assert.ok(fs.existsSync(env.CODEX_HOME));
  assert.equal(fs.statSync(env.CODEX_HOME).mode & 0o777, 0o700);
});

test('two different dogfood checkouts get two different dedicated Codex homes', () => {
  const inspect = () => ({ version: '0.66.0', sha: 'eee', tagSha: 'aaa', dirty: true });
  const envA = codexSetup(localSource(), inspect);
  const envB = codexSetup(localSource(), inspect);
  assert.notEqual(envA.CODEX_HOME, envB.CODEX_HOME);
});

test('refuses a dogfood Codex install aimed at the shared default Codex home', () => {
  const source = localSource();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-sandbox-'));
  const defaultHome = path.join(sandbox, '.codex');
  const expected = expectedDedicatedHome(sandbox, source);
  const inspect = () => ({ version: '0.66.0', sha: 'fff', tagSha: 'aaa', dirty: true });
  let thrown = null;
  try { codexSetup(source, inspect, { sandbox, codexHomeEnv: defaultHome }); }
  catch (error) { thrown = error; }
  assert.ok(thrown, 'expected setupCodexHost to refuse a dogfood source aimed at the shared default home');
  assert.ok(thrown.message.includes(defaultHome), 'refusal must name the shared default home');
  assert.ok(thrown.message.includes(expected), 'refusal must name the dedicated path');
});

test('an explicit non-default CODEX_HOME still wins for a dogfood Codex install', () => {
  const source = localSource();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-sandbox-'));
  const custom = path.join(sandbox, 'custom-codex-home');
  const inspect = () => ({ version: '0.66.0', sha: 'ggg', tagSha: 'aaa', dirty: true });
  const env = codexSetup(source, inspect, { sandbox, codexHomeEnv: custom });
  assert.equal(env.CODEX_HOME, custom);
});

test('a release Codex install is not redirected, even with CODEX_HOME unset', () => {
  const env = codexSetup('serhii-nochevnyi/shipyard', () => { throw new Error('must not inspect'); });
  assert.equal(env.SHIPYARD_INSTALL_KIND, 'release');
  assert.equal('CODEX_HOME' in env, false);
});

function mainCodexHarness(source, { sandbox, codexHomeEnv, inspect: inspectSource,
  marketplaceList = [] } = {}) {
  const home = sandbox || fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-main-home-'));
  const version = '0.66.0+codex.0123456789abcdef';
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'xdg-state'),
    CODEX_HOME: codexHomeEnv };
  const events = [];
  const inspect = inspectSource || (() => ({ version: '0.66.0', sha: 'dirty', tagSha: 'release', dirty: true }));
  const copyEnv = (value) => ({ ...value });
  const read = (command, args, selectedEnv) => {
    events.push({ type: 'read', command, args: [...args], env: copyEnv(selectedEnv) });
    if (args[1] === 'marketplace') return { marketplaces: marketplaceList };
    return { installed: [{ pluginId: 'shipyard@shipyard', enabled: true, version }] };
  };
  const execute = (command, args, selectedEnv) => {
    events.push({ type: 'execute', command, args: [...args], env: copyEnv(selectedEnv) });
    if (args[1] === 'add' && args[0] === 'plugin') {
      const cache = path.join(selectedEnv.CODEX_HOME, 'plugins/cache/shipyard/shipyard', version);
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, 'package-build.json'), '{}\n');
    }
  };
  const runCommand = (command, args, selectedEnv) => {
    events.push({ type: 'ensure', command, args: [...args], env: copyEnv(selectedEnv) });
  };
  let error = null;
  const args = source === undefined ? ['codex'] : ['codex', '--source', source];
  try { main(args, { env, inspect, run: runCommand, execute, read }); }
  catch (caught) { error = caught; }
  return { home, env, events, error };
}

test('main selects each checkout home before ensure and carries it through marketplace and bootstrap', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-main-roots-'));
  const sources = [localSource(), localSource()];
  const results = sources.map((source, index) => mainCodexHarness(source, {
    sandbox: home,
    ...(index === 1 ? { marketplaceList: [{ name: 'shipyard', marketplaceSource: {
      sourceType: 'git', source: 'https://previous.example/shipyard.git',
    } }] } : {}),
  }));
  const selectedHomes = results.map((result, index) => dogfoodHome('codex',
    fs.realpathSync(sources[index]), results[index].env));

  assert.notEqual(selectedHomes[0], selectedHomes[1]);
  for (const [index, result] of results.entries()) {
    assert.equal(result.error, null, result.error?.message);
    const codexEvents = result.events.filter(event => event.type === 'ensure'
      || event.type === 'read' || event.type === 'execute');
    assert.ok(codexEvents.length >= 5, 'ensure, marketplace, plugin inspection and bootstrap all ran');
    assert.equal(codexEvents[0].type, 'ensure', 'target selection precedes the first Codex operation');
    assert.equal(codexEvents[0].command, process.execPath);
    assert.match(codexEvents[0].args[0], /ensure-gsd-plugin\.cjs$/);
    assert.equal(codexEvents[0].args[1], 'codex');
    assert.ok(codexEvents.every(event => event.env.CODEX_HOME === selectedHomes[index]),
      `every Codex operation should use ${selectedHomes[index]}`);
    assert.ok(codexEvents.some(event => event.type === 'execute'
      && event.command === process.execPath && /bootstrap-shipyard-plugin\.cjs$/.test(event.args[0])),
    'bootstrap receives the selected environment');
    assert.ok(codexEvents.some(event => event.type === 'execute'
      && event.args[0] === 'plugin' && event.args[1] === 'marketplace' && event.args[2] === 'add'),
    'marketplace add receives the selected environment');
    assert.ok(fs.existsSync(selectedHomes[index]));
  }
  assert.ok(results[1].events.some(event => event.type === 'execute'
    && event.args.join(' ') === 'plugin marketplace remove shipyard'),
  'replacement removes the prior marketplace under the selected environment');
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'the shared default remains untouched');
});

test('main keeps tagged releases on the default home and honors a safe explicit dogfood home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-main-release-custom-'));
  const release = mainCodexHarness('serhii-nochevnyi/shipyard', {
    sandbox: home,
    marketplaceList: [{ name: 'shipyard', marketplaceSource: {
      sourceType: 'git', source: 'https://github.com/serhii-nochevnyi/shipyard.git',
    } }],
  });
  const defaultHome = path.join(home, '.codex');
  assert.equal(release.error, null, release.error?.message);
  assert.ok(release.events.every(event => event.env.CODEX_HOME === defaultHome));
  assert.ok(release.events.some(event => event.type === 'execute'
    && event.args.join(' ') === 'plugin marketplace upgrade shipyard'),
  'tagged release upgrade keeps its established default target');

  const customHome = path.join(home, 'custom-codex-home');
  const custom = mainCodexHarness(localSource(), { sandbox: home, codexHomeEnv: customHome });
  assert.equal(custom.error, null, custom.error?.message);
  assert.ok(custom.events.every(event => event.env.CODEX_HOME === customHome),
    'an explicit safe custom home is used by ensure, marketplace operations and bootstrap');
});

test('main refuses an explicit shared default before ensure, Codex calls or filesystem writes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-main-refusal-'));
  const source = localSource();
  const defaultHome = path.join(home, '.codex');
  const stateRoot = path.join(home, 'xdg-state');
  const before = fs.readdirSync(home).sort();
  const result = mainCodexHarness(source, { sandbox: home, codexHomeEnv: defaultHome });
  assert.match(result.error?.message || '', /Refusing dogfood Codex source.*shared default/s);
  assert.deepEqual(result.events, [], 'refusal happens before the first Codex operation');
  assert.deepEqual(fs.readdirSync(home).sort(), before, 'refusal creates no target or state directories');
  assert.equal(fs.existsSync(defaultHome), false);
  assert.equal(fs.existsSync(stateRoot), false);
});
