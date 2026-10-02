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
  installCodexMarketplace('serhii-nochevnyi/shipyard', execute, read, { HOME: os.tmpdir() });
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

const fixtureDestinationDefaults = Object.fromEntries([
  'SHIPYARD_ISOLATION_ROOT', 'SHIPYARD_ORIGINAL_HOME', 'SHIPYARD_DOGFOOD_ROOT',
  'CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'AGENTS_SKILLS_DIR', 'CODEX_AGENTS_MD',
  'GSD_CAPABILITIES_DIR', 'GSD_CAPABILITIES_ROOT', 'GSD_DEFAULTS_PATH', 'GSD_HOME',
  'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'TMPDIR', 'TMP', 'TEMP',
  ...['cache', 'prefix', 'logs_dir', 'tmp', 'userconfig', 'globalconfig']
    .flatMap(name => [`npm_config_${name}`, `NPM_CONFIG_${name.toUpperCase()}`]),
].map(key => [key, undefined]));

function codexSetup(source, inspect, { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-sandbox-')),
  codexHomeEnv } = {}) {
  const version = '0.66.0+codex.0123456789abcdef';
  const home = codexHome(version);
  const runs = [];
  const read = () => ({ installed: [{ pluginId: 'shipyard@shipyard', enabled: true, version }] });
  return withEnv({ ...fixtureDestinationDefaults, HOME: sandbox, CODEX_HOME: codexHomeEnv }, () => {
    setupCodexHost(source, (command, args, env) => runs.push({ command, args, env }), read, inspect, home);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'bash');
    assert.equal(runs[0].args[1], '--launch-bootstrap');
    assert.match(runs[0].args[0], /host\/scripts\/ensure-gsd-core\.sh$/);
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
  return withEnv({ ...fixtureDestinationDefaults, HOME: sandbox },
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
  marketplaceList = [], envOverrides = {} } = {}) {
  const home = sandbox || fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-main-home-'));
  const version = '0.66.0+codex.0123456789abcdef';
  const env = { ...process.env, ...fixtureDestinationDefaults, HOME: home,
    CODEX_HOME: codexHomeEnv, ...envOverrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
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

test('old Codex helpers isolate inherited runner config while explicit escaping config refuses', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-runner-env-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const source = localSource();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const inspect = () => ({ version: '0.66.0', sha: 'runner', tagSha: 'release', dirty: true });
  withEnv({ XDG_CONFIG_HOME: '/home/runner/.config' }, () => {
    const selected = codexSetup(source, inspect, { sandbox });
    assert.equal(selected.XDG_CONFIG_HOME, path.join(selected.HOME, '.config'));
    const installed = mainCodexHarness(source, { sandbox, inspect });
    assert.equal(installed.error, null);
    assert.equal(process.env.XDG_CONFIG_HOME, '/home/runner/.config');
    const before = fullSnapshot(sandbox);
    const refused = mainCodexHarness(source, { sandbox, inspect,
      envOverrides: { XDG_CONFIG_HOME: '/home/runner/.config' } });
    assert.match(refused.error.message, /isolation refusal: destination escapes candidate HOME envelope/);
    assert.equal(refused.events.length, 0);
    assert.deepEqual(fullSnapshot(sandbox), before);
  });
});

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
      && event.command === 'bash' && /ensure-gsd-core\.sh$/.test(event.args[0])),
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

const { spawnSync } = require('node:child_process');
const repository = path.resolve(__dirname, '../..');
function fullSnapshot(root) {
  const result = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
      result[path.relative(root, file)] = { mode: String(stat.mode), mtime: String(stat.mtimeNs),
        ino: String(stat.ino), nlink: String(stat.nlink),
        data: stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file).toString('base64') : null };
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root); return result;
}
test('OS-home dependency negative control detects outside writes; every entry refuses divergent native home before writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-boundary-'));
  try {
    const ambient = path.join(dir, 'ambient'), candidate = path.join(dir, 'candidate'), bin = path.join(dir, 'bin');
    fs.mkdirSync(ambient); fs.mkdirSync(bin);
    fs.mkdirSync(path.join(ambient, '.gsd'));
    fs.writeFileSync(path.join(ambient, '.gsd/defaults.json'), '{"operator":"preserve"}\n', { mode: 0o640 });
    const fake = path.join(bin, 'npx');
    fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),os=require('node:os');\nconst dir=path.join(os.homedir(),'.gsd');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'defaults.json'),'{"runtime":"fake-dependency"}');\n`);
    fs.chmodSync(fake, 0o755);
    const before = fullSnapshot(ambient);
    const negative = spawnSync(fake, [], { env: { HOME: ambient }, encoding: 'utf8' });
    assert.equal(negative.status, 0, negative.stderr);
    assert.notDeepEqual(fullSnapshot(ambient), before, 'snapshot actually detects native-home dependency mutation');
    const preload = path.join(dir, 'outside.cjs');
    fs.writeFileSync(preload, `require('node:os').homedir=()=>${JSON.stringify(ambient)};\n`);
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: ambient, CODEX_HOME: path.join(candidate, 'codex'),
      CLAUDE_CONFIG_DIR: path.join(candidate, 'claude'), CLAUDE_HOME: path.join(candidate, 'claude'),
      SHIPYARD_ISOLATION_ROOT: candidate, NODE_OPTIONS: `--require=${preload}`, SHIPYARD_GSD_AUTO_INSTALL: '0' };
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const [command, args] of [
      ['bash', ['scripts/ensure-gsd-core.sh', 'codex']],
      ['bash', ['scripts/ensure-gsd-core.sh', 'claude']],
      ['bash', ['scripts/install-shipyard-codex.sh']],
      ['/bin/bash', ['scripts/ensure-gsd-core.sh', '--launch-marketplace', 'codex']],
      ['/bin/bash', ['scripts/ensure-gsd-core.sh', '--launch-marketplace', 'claude']],
      ['/bin/bash', ['scripts/ensure-gsd-core.sh', '--launch-bootstrap']],
      ['bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(candidate, 'plugin')]],
    ]) {
      const snapshot = fullSnapshot(dir);
      const result = spawnSync(command, args, { cwd: repository, env, encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${args.join(' ')} must refuse`);
      assert.match(result.stderr, /isolation.*(home|HOME|NODE_OPTIONS)/i, `${args.join(' ')}: ${result.stderr}`);
      assert.deepEqual(fullSnapshot(dir), snapshot, `${args.join(' ')} has zero filesystem side effects`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function processFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-process-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ambient = path.join(dir, 'ambient'), candidate = path.join(dir, 'candidate'), bin = path.join(dir, 'bin');
  fs.mkdirSync(ambient); fs.mkdirSync(bin);
  for (const relative of ['.gsd/defaults.json', '.codex/config.toml', '.claude/settings.json', '.cache/sentinel', '.agents/skills/sentinel', '.local/state/sentinel']) {
    const file = path.join(ambient, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'protected operator bytes\n', { mode: 0o640 });
  }
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat().map(r => ({ model: policy.CODEX_MODEL_IDS[r.model_key], effort: r.effort }));
  const capabilities = path.join(dir, 'capabilities.json');
  fs.writeFileSync(capabilities, JSON.stringify({ supportedModels: [...new Set(selections.map(s => s.model))],
    supportedEfforts: [...new Set(selections.map(s => s.effort))], supportedSelections: selections }));
  const executable = (name, content) => {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${content}\n`); fs.chmodSync(path.join(bin, name), 0o755);
  };
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  executable('npm', "console.log('1.14.0');");
  executable('npx', `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const home=os.homedir();fs.mkdirSync(path.join(home,'.gsd'),{recursive:true});
    fs.writeFileSync(path.join(home,'.gsd/defaults.json'),JSON.stringify({runtime:process.argv.includes('--claude')?'claude':'codex',fixture_dependency:true}));
    fs.appendFileSync(path.join(home,'child-trace.jsonl'),JSON.stringify({command:'npx',home,env:process.env})+'\\n');
    const core=path.join(process.argv.includes('--claude')?process.env.CLAUDE_CONFIG_DIR:process.env.CODEX_HOME,'gsd-core');
    fs.mkdirSync(path.join(core,'bin/lib'),{recursive:true});fs.writeFileSync(path.join(core,'VERSION'),'1.14.0');
    fs.writeFileSync(path.join(core,'bin/lib/runtime-artifact-conversion.cjs'),'module.exports={convertClaudeCommandToCodexSkill:x=>x,convertClaudeToCodexMarkdown:x=>x};\\n');
    fs.writeFileSync(path.join(core,'bin/gsd-tools.cjs'),"const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);if(a[0]!=='capability'||a[1]!=='install')process.exit(99);fs.cpSync(a[2],path.join(process.env.GSD_CAPABILITIES_DIR,'delivery-pipeline'),{recursive:true});");`);
  for (const runtime of ['codex', 'claude']) executable(runtime, `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    fs.appendFileSync(path.join(os.homedir(),'child-trace.jsonl'),JSON.stringify({command:${JSON.stringify(runtime)},home:os.homedir(),args:process.argv.slice(2)})+'\\n');
    const a=process.argv.slice(2);if(process.env.FIXTURE_PACKAGE_ROOT&&a.join(' ')==='plugin add shipyard@shipyard'){fs.cpSync(process.env.FIXTURE_PACKAGE_ROOT,path.join(process.env.CODEX_HOME,'plugins/cache/shipyard/shipyard/local'),{recursive:true});}
    if(a[1]==='marketplace'&&a[2]==='list')console.log(JSON.stringify(${runtime === 'codex' ? "{marketplaces:[{name:'gsd-core'}]}" : "[{name:'gsd-core'}]"}));
    else if(a[1]==='list')console.log(JSON.stringify(${runtime === 'codex' ? "{installed:[{pluginId:'gsd-core@gsd-core',enabled:true,version:'1.14.0'},{pluginId:'shipyard@shipyard',enabled:true,version:'local'}]}" : "[{id:'gsd-core@gsd-core',scope:'user',enabled:true,version:'1.14.0'}]"}));`);
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'C', HOME: ambient,
    SHIPYARD_ISOLATION_ROOT: candidate, CODEX_HOME: path.join(candidate, 'codex'),
    CLAUDE_HOME: path.join(candidate, 'claude'), CLAUDE_CONFIG_DIR: path.join(candidate, 'claude'),
    SHIPYARD_CODEX_CAPABILITIES_FILE: capabilities, GSD_CORE_VERSION: '1.14.0', SHIPYARD_PROJECT_DIR: repository };
  const run = (command, args, extra = {}) => spawnSync(command, args, { cwd: repository, env: { ...env, ...extra }, encoding: 'utf8', timeout: 90000 });
  return { dir, ambient, candidate, bin, env, run };
}

test('automatic direct dependency, actual tuner, manifest and reinstall stay inside candidate OS HOME', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = attempt === 0
      ? f.run('/bin/bash', ['scripts/install-shipyard-codex.sh', '--dogfood-root', f.env.CODEX_HOME], { CODEX_HOME: undefined })
      : f.run('/bin/bash', ['scripts/install-shipyard-codex.sh']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fullSnapshot(f.ambient), before);
    const home = path.join(f.candidate, '.shipyard-home');
    const defaults = JSON.parse(fs.readFileSync(path.join(home, '.gsd/defaults.json')));
    assert.equal(defaults.runtime, undefined, 'real tuner removed dependency runtime marker only inside candidate');
    assert.equal(defaults.fixture_dependency, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.env.CODEX_HOME, 'agents/.shipyard-manifest.json')));
    assert.ok(Object.keys(manifest.agent_digests).length > 0);
    assert.equal(manifest.gsd_lib_digest, require('node:crypto').createHash('sha256').update(fs.readFileSync(manifest.gsd_lib)).digest('hex'));
    assert.equal(manifest.capabilities_digest, require('node:crypto').createHash('sha256').update(fs.readFileSync(f.env.SHIPYARD_CODEX_CAPABILITIES_FILE)).digest('hex'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.CODEX_HOME, 'agents/.shipyard-provenance.json'))).schema, 'shipyard.host-provenance.v1');
    const trace = fs.readFileSync(path.join(home, 'child-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(trace.some(row => row.command === 'npx'));
    assert.ok(trace.every(row => row.home === home));
  }
});

test('Claude explicit dependency and unwired dogfood preparation confine native defaults and preserve active state', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  const dependency = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', 'claude']);
  assert.equal(dependency.status, 0, dependency.stdout + dependency.stderr);
  const plugin = path.join(f.candidate, 'plugin');
  const installed = f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', plugin], { SHIPYARD_GSD_AUTO_INSTALL: '0' });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(fs.existsSync(path.join(plugin, '.shipyard-provenance.json')));
  assert.equal(fs.existsSync(path.join(f.env.CLAUDE_HOME, 'settings.json')), false);
  assert.deepEqual(fullSnapshot(f.ambient), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.candidate, '.shipyard-home/.gsd/defaults.json'))).runtime, 'claude');
});

test('two-stage npm executable links survive dependency then Claude hook and packaged bootstrap', t => {
  for (const runtime of ['claude', 'codex', 'claude-plugin-cache']) {
    const pluginCache = runtime === 'claude-plugin-cache';
    const selectedRuntime = pluginCache ? 'claude' : runtime;
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    const fake = path.join(f.bin, 'npx');
    fs.appendFileSync(fake, `
const modules=${pluginCache ? "path.join(process.env.CLAUDE_CONFIG_DIR,'plugins/cache/gsd-core/gsd-core/1.15.0/node_modules')" : "path.join(process.env.npm_config_cache,'_npx','fixture','node_modules')"};
fs.mkdirSync(path.join(modules,'.bin'),{recursive:true});
const executable=${pluginCache ? "'acorn/bin/acorn'" : "'anthropic-ai-sdk/cli.js'"};
fs.mkdirSync(path.dirname(path.join(modules,executable)),{recursive:true});
fs.writeFileSync(path.join(modules,executable),'#!/bin/sh\\nexit 0\\n',{mode:0o755});
fs.symlinkSync('../'+executable,path.join(modules,'.bin',${pluginCache ? "'acorn'" : "'anthropic-ai-sdk'"}));
`);
    const dependency = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', selectedRuntime]);
    assert.equal(dependency.status, 0, dependency.stdout + dependency.stderr);
    const link = pluginCache
      ? path.join(f.env.CLAUDE_CONFIG_DIR, 'plugins/cache/gsd-core/gsd-core/1.15.0/node_modules/.bin/acorn')
      : path.join(f.candidate, '.shipyard-home/.npm/_npx/fixture/node_modules/.bin/anthropic-ai-sdk');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    const continued = selectedRuntime === 'claude'
      ? f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(f.candidate, 'plugin')], { SHIPYARD_GSD_AUTO_INSTALL: '0' })
      : f.run(process.execPath, ['plugins/shipyard/host/scripts/bootstrap-shipyard-plugin.cjs'], { SHIPYARD_GSD_AUTO_INSTALL: '0' });
    assert.equal(continued.status, 0, continued.stdout + continued.stderr);
    assert.ok(fs.existsSync(selectedRuntime === 'claude' ? path.join(f.candidate, 'plugin/.shipyard-provenance.json') : path.join(f.env.CODEX_HOME, 'agents/.shipyard-manifest.json')));
    assert.deepEqual(fullSnapshot(f.ambient), before);
    const target = fs.realpathSync(link);
    fs.accessSync(target, fs.constants.X_OK);
    for (const hazard of ['outside', 'sibling-subtree', 'external-shim', 'outside-reentry', 'component-reentry', 'dotdot-reentry', 'contained-chain', 'dangling', 'cyclic', 'directory', 'hardlink', 'non-npm']) {
      fs.unlinkSync(link);
      let destination = target;
      if (hazard === 'outside') destination = path.join(f.ambient, '.gsd/defaults.json');
      if (hazard === 'sibling-subtree') destination = path.join(f.candidate, '.shipyard-home/.gsd/defaults.json');
      if (hazard === 'external-shim') {
        destination = path.join(f.ambient, '.codex/tmp/arg0/shim');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        assert.ok(fs.lstatSync(destination).isFile());
        fs.accessSync(destination, fs.constants.X_OK);
      }
      if (['outside-reentry', 'component-reentry'].includes(hazard)) {
        const external = path.join(f.dir, 'external-' + hazard);
        fs.symlinkSync(hazard === 'component-reentry' ? path.dirname(target) : target, external);
        destination = hazard === 'component-reentry' ? path.join(external, path.basename(target)) : external;
      }
      if (hazard === 'dotdot-reentry') {
        destination = path.dirname(path.dirname(link)) + '/../node_modules/' + path.relative(path.dirname(path.dirname(link)), target);
      }
      if (hazard === 'contained-chain') {
        destination = path.join(path.dirname(link), 'contained-hop');
        fs.symlinkSync(target, destination);
      }
      if (hazard === 'dangling') destination = path.join(path.dirname(target), 'missing');
      if (hazard === 'cyclic') destination = link;
      if (hazard === 'directory') destination = path.dirname(target);
      if (hazard === 'hardlink') fs.linkSync(target, path.join(path.dirname(target), 'alias'));
      if (hazard === 'non-npm') fs.symlinkSync(target, path.join(f.candidate, 'ordinary-link'));
      fs.symlinkSync(destination, link);
      const snapshot = fullSnapshot(f.dir);
      for (const helper of ['scripts/ensure-gsd-core.sh', 'plugins/shipyard/host/scripts/ensure-gsd-core.sh']) {
      const refused = f.run('/bin/bash', [helper, '--isolation-env', selectedRuntime, f.candidate]);
      assert.equal(refused.status, hazard === 'contained-chain' ? 0 : 3, hazard + refused.stderr);
        if (hazard === 'external-shim') assert.match(refused.stderr, /npm executable escapes npm subtree/);
        assert.deepEqual(fullSnapshot(f.dir), snapshot, hazard + ' refuses before writes');
      }
      if (hazard === 'contained-chain') fs.unlinkSync(destination);
      if (hazard === 'hardlink') fs.unlinkSync(path.join(path.dirname(target), 'alias'));
      if (hazard === 'non-npm') fs.unlinkSync(path.join(f.candidate, 'ordinary-link'));
    }
  }
});

test('preflight rejects all escaping supported overrides and aliasing without any writes', t => {
  const f = processFixture(t);
  for (const key of ['GSD_DEFAULTS_PATH', 'AGENTS_SKILLS_DIR', 'CODEX_AGENTS_MD', 'GSD_CAPABILITIES_DIR', 'GSD_CAPABILITIES_ROOT',
    'npm_config_cache', 'NPM_CONFIG_PREFIX', 'npm_config_userconfig', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    const before = fullSnapshot(f.dir);
    const result = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', '--isolation-env', 'codex', f.candidate], { [key]: path.join(f.ambient, 'escape') });
    assert.notEqual(result.status, 0, key); assert.match(result.stderr, /isolation refusal/);
    assert.deepEqual(fullSnapshot(f.dir), before, key);
  }
  fs.mkdirSync(f.candidate); fs.symlinkSync(f.ambient, path.join(f.candidate, 'alias'));
  let before = fullSnapshot(f.dir);
  let result = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', '--isolation-env', 'codex', f.candidate]);
  assert.notEqual(result.status, 0); assert.deepEqual(fullSnapshot(f.dir), before);
  fs.unlinkSync(path.join(f.candidate, 'alias'));
  fs.linkSync(path.join(f.ambient, '.gsd/defaults.json'), path.join(f.candidate, 'hardlink.json'));
  before = fullSnapshot(f.dir);
  result = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', '--isolation-env', 'codex', f.candidate]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /hardlink/); assert.deepEqual(fullSnapshot(f.dir), before);
});

test('marketplace through generated installed bootstrap and idempotent early return confines all dependency children', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  const packageRoot = path.join(f.dir, 'package');
  require('../../scripts/package-shipyard-codex.cjs').build(packageRoot);
  f.env.FIXTURE_PACKAGE_ROOT = packageRoot;
  const installed = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', '--launch-marketplace', 'codex', '--source', repository]);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const bootstrap = path.join(f.env.CODEX_HOME, 'plugins/cache/shipyard/shipyard/local/host/scripts/bootstrap-shipyard-plugin.cjs');
  const launcher = path.join(path.dirname(bootstrap), 'ensure-gsd-core.sh');
  const hook = JSON.parse(fs.readFileSync(path.join(packageRoot, 'hooks/hooks.json'))).hooks.SessionStart[0].hooks[0].command;
  for (const options of ['', '--no-warnings --trace-warnings']) {
    const safe = f.run('/bin/bash', ['-c', hook], { PLUGIN_ROOT: packageRoot, NODE_OPTIONS: options });
    assert.equal(safe.status, 0, safe.stdout + safe.stderr);
  }
  for (const name of ['route', 'investigate', 'decompose', 'deliver', 'bench', 'delivery-rules']) {
    const skill = fs.readFileSync(path.join(packageRoot, 'skills', 'shipyard-' + name, 'SKILL.md'), 'utf8');
    assert.match(skill, /bash "<plugin-root>\/host\/scripts\/ensure-gsd-core\.sh" --launch-bootstrap/);
    assert.doesNotMatch(skill, /node .*bootstrap-shipyard-plugin/);
  }
  const repeated = f.run('/bin/bash', [launcher, '--launch-bootstrap']);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.ok(fs.existsSync(path.join(f.env.CODEX_HOME, 'shipyard-plugin/installed.json')));
  assert.ok(fs.existsSync(path.join(f.env.CODEX_HOME, 'shipyard-native-skills/shipyard-deliver/SKILL.md')));
  assert.deepEqual(fullSnapshot(f.ambient), before);
  fs.rmSync(path.join(f.env.CODEX_HOME, 'shipyard-plugin/installed.json'));
  const codex = path.join(f.bin, 'codex');
  const codexSource = fs.readFileSync(codex, 'utf8');
  fs.writeFileSync(codex, codexSource.replace('const a=process.argv.slice(2);',
    `const a=process.argv.slice(2);if(a.join(' ')==='debug models'){fs.symlinkSync(${JSON.stringify(path.join(f.ambient, '.gsd/defaults.json'))},path.join(process.env.CODEX_HOME,'shipyard-plugin/capabilities.json'));console.log(JSON.stringify({models:[]}));process.exit(0);}`));
  const beforeProbe = fullSnapshot(f.ambient);
  const unsafeProbe = f.run(process.execPath, [bootstrap], { SHIPYARD_CODEX_CAPABILITIES_FILE: undefined });
  assert.notEqual(unsafeProbe.status, 0, unsafeProbe.stdout + unsafeProbe.stderr);
  assert.match(unsafeProbe.stderr, /isolation refusal: (?:symlink destination|destination escapes candidate HOME envelope)/);
  assert.deepEqual(fullSnapshot(f.ambient), beforeProbe, 'the capabilities probe cannot write through its planted alias');
  assert.ok(fs.lstatSync(path.join(f.env.CODEX_HOME, 'shipyard-plugin/capabilities.json')).isSymbolicLink());
  const preload = path.join(f.dir, 'outside-home.cjs');
  fs.writeFileSync(preload, `require('node:os').homedir=()=>${JSON.stringify(f.ambient)};`);
  const snapshot = fullSnapshot(f.dir);
  const refused = f.run('/bin/bash', [launcher, '--launch-bootstrap'], { NODE_OPTIONS: `--require=${preload}`, SHIPYARD_GSD_AUTO_INSTALL: '0' });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /isolation refusal/);
  assert.deepEqual(fullSnapshot(f.dir), snapshot, 'matching installed state cannot skip preflight');
});

test('isolated Claude config without an envelope refuses before dependency and dogfood copy', t => {
  const f = processFixture(t), before = fullSnapshot(f.dir);
  for (const args of [['scripts/ensure-gsd-core.sh', 'claude'], ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(f.candidate, 'plugin'), '--wire-hooks']]) {
    const result = f.run('/bin/bash', args, { SHIPYARD_ISOLATION_ROOT: undefined, SHIPYARD_INSTALL_KIND: 'dogfood' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /absolute bounded candidate root/);
    assert.deepEqual(fullSnapshot(f.dir), before);
  }
});

test('published proof keeps historical approved baseline, attempts, exact PR408 gates and independent HOLDs', () => {
  const proof = fs.readFileSync(path.join(repository, 'docs/audits/phase46/2026-10-01-isolated-native-rollout-proof.md'), 'utf8');
  const data = JSON.parse(proof.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(data.operator_baseline_acceptance.historical_restoration_claim, false);
  assert.equal(data.operator_baseline_acceptance.decision, 'accept-current-shared-defaults-as-baseline-and-test-fresh-isolated-installation');
  assert.equal(data.baseline.sha256, '2edab0e2e95e8d265da9c66fcf4de6d5193b3511b629d4d07920dda4ac4ee4b0');
  assert.equal(data.attempts.length, 3);
  for (const attempt of data.attempts) {
    assert.equal(attempt.exit, 0);
    for (const key of ['sha256', 'bytes', 'mode', 'uid', 'gid', 'mtime_ns']) assert.equal(attempt.shared_defaults_after[key], data.baseline[key]);
    const log = data.retained_files.find(record => record.path === attempt.log);
    assert.equal(log.sha256, attempt.log_sha256); assert.equal(log.bytes, attempt.log_bytes);
    assert.ok(path.isAbsolute(attempt.cwd)); assert.equal(attempt.environment_overrides.GSD_CORE_VERSION, '1.14.0');
  }
  const head = '992fd1fca755ce812ef04d3714f12e108378c090';
  assert.deepEqual(data.pr408_review, [{ commit_id: head, state: 'APPROVED', submitted_at: '2026-10-01T19:36:02Z', user: 'copilot-pull-request-reviewer[bot]' }]);
  assert.deepEqual(data.pr408_checks.map(check => check.name).sort(), ['copilot-pull-request-reviewer', 'test-fast']);
  for (const check of data.pr408_checks) { assert.equal(check.head_sha, head); assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'success'); }
  assert.equal(data.codex_authenticated_status.logged_in, true);
  assert.equal(data.claude_authenticated_normal_home_status.environment, 'normal-home');
  assert.equal(data.claude_authenticated_normal_home_status.loggedIn, true);
  assert.equal(data.claude_authenticated_dedicated_home_status.exit, 0);
  assert.equal(data.claude_authenticated_dedicated_home_status.loggedIn, true);
  assert.equal(data.claude_authenticated_dedicated_home_status.active_keychain_metadata_unchanged, true);
  assert.deepEqual(data.controlled_source_attempts.map(a => a.exit), [0, 0, 3]);
  assert.ok(data.controlled_source_attempts.every(a => a.shared_defaults_unchanged && a.source_head === '3eea0e4d58e327970c5a70aa3e498317a79d88ae'));
  assert.equal(data.controlled_source_dependency_versions.observed_claude_marketplace, '1.15.0');
  assert.equal(data.controlled_source_dependency_versions.marketplace_pin_honored, false);
  assert.doesNotMatch(proof, /candidate OS HOME authentication remains \*\*FALSE\*\*/);
  assert.match(proof, /Actual controlled current-safe-link installation is still required/);
  assert.match(proof, /rollback rehearsal, final release live-round, operator rollout checkpoint and activation/);
  assert.equal((proof.match(/\| HOLD —/g) || []).length, 8);
  const runbook = fs.readFileSync(path.join(repository, '.planning/architecture/ADR-024-ROLLOUT.md'), 'utf8');
  assert.match(runbook, /--launch-marketplace/); assert.match(proof, /Direct external.*unsupported/);
  assert.match(runbook, /--isolation-env/); assert.match(runbook, /SHIPYARD_ISOLATION_ROOT/);
  assert.match(runbook, /candidate_run claude .*ensure-gsd-core/); assert.match(runbook, /prior reviewed installer must support/);
});

test('wired Claude hooks and real tuner remain candidate-owned', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  const result = f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(f.candidate, 'plugin'), '--wire-hooks']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(f.env.CLAUDE_HOME, 'settings.json')));
  assert.ok(settings.hooks.UserPromptSubmit.length);
  const defaults = JSON.parse(fs.readFileSync(path.join(f.candidate, '.shipyard-home/.gsd/defaults.json')));
  assert.equal(defaults.runtime, undefined);
  assert.deepEqual(fullSnapshot(f.ambient), before);
});

test('isolated real tuning failure is fatal and protects outside state', t => {
  for (const runtime of ['codex', 'claude']) {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    const fake = path.join(f.bin, 'npx');
    const source = fs.readFileSync(fake, 'utf8');
    fs.writeFileSync(fake, source.replace("JSON.stringify({runtime:process.argv.includes('--claude')?'claude':'codex',fixture_dependency:true})", "'invalid-defaults-json'"));
    const args = runtime === 'codex' ? ['scripts/install-shipyard-codex.sh']
      : ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(f.candidate, 'plugin'), '--wire-hooks'];
    const result = f.run('/bin/bash', args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /defaults|JSON/);
    assert.deepEqual(fullSnapshot(f.ambient), before);
  }
});

test('empty explicit envelopes and relative selected runtime paths refuse before any mutation', t => {
  const f = processFixture(t);
  for (const [command, args, extra] of [
    ['/bin/bash', ['scripts/install-shipyard-codex.sh'], { SHIPYARD_ISOLATION_ROOT: '' }],
    [process.execPath, ['scripts/install-shipyard-marketplace.cjs', 'codex'], { CODEX_HOME: 'relative' }],
    [process.execPath, ['scripts/bootstrap-shipyard-plugin.cjs'], { CODEX_HOME: 'relative' }],
    ['/bin/bash', ['scripts/ensure-gsd-core.sh', '--isolation-env', 'codex', 'relative'], {}],
  ]) {
    const before = fullSnapshot(f.dir), result = f.run(command, args, extra);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /isolation refusal/);
    assert.deepEqual(fullSnapshot(f.dir), before);
  }
});

 test('legacy make unwired Claude dogfood copies only; wired copy without envelope refuses', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  const plugin = path.join(f.candidate, 'legacy-plugin');
  const env = { ...f.env, SHIPYARD_ISOLATION_ROOT: undefined, CLAUDE_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined };
  const installed = spawnSync('make', ['install-shipyard-dogfood-claude', `DOGFOOD_ROOT=${plugin}`], { cwd: repository, env, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(fs.existsSync(path.join(plugin, '.shipyard-provenance.json')));
  assert.deepEqual(fullSnapshot(f.ambient), before);
  assert.equal(fs.existsSync(path.join(f.candidate, '.shipyard-home')), false);
  for (const unsafe of [f.ambient, path.join(f.ambient, '.gsd'), path.join(f.ambient, '.claude'), repository]) {
    const snapshot = fullSnapshot(f.dir);
    const refused = spawnSync('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', unsafe], { cwd: repository, env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /overlaps protected state/);
    assert.deepEqual(fullSnapshot(f.dir), snapshot);
  }
  const snapshot = fullSnapshot(f.dir);
  const wired = spawnSync('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', plugin, '--wire-hooks'], { cwd: repository, env, encoding: 'utf8' });
  assert.notEqual(wired.status, 0);
  assert.match(wired.stderr, /absolute bounded candidate root/);
  assert.deepEqual(fullSnapshot(f.dir), snapshot);
});


test('copy-only Claude dogfood protects divergent active roots and physical aliases', t => {
  for (const kind of ['config', 'config-alias', 'default-claude', 'codex']) {
    const f = processFixture(t);
    const hookHome = path.join(f.dir, 'hook-home'), config = path.join(f.dir, 'active-config');
    const codex = path.join(f.dir, 'active-codex');
    for (const root of [hookHome, config, codex]) fs.mkdirSync(root);
    fs.writeFileSync(path.join(config, 'settings.json'), 'active config bytes\n', { mode: 0o640 });
    const alias = path.join(f.dir, 'config-alias');
    fs.symlinkSync(config, alias);
    const active = kind === 'default-claude' ? path.join(f.ambient, '.claude') : kind === 'codex' ? codex : config;
    const target = path.join(active, 'candidate');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, '.shipyard-provenance.json'), '{}\n');
    fs.writeFileSync(path.join(target, 'sentinel'), 'existing active contents\n');
    const env = { ...f.env, SHIPYARD_ISOLATION_ROOT: undefined, CLAUDE_HOME: hookHome,
      CLAUDE_CONFIG_DIR: config, CODEX_HOME: codex };
    const before = fullSnapshot(f.dir);
    const destination = kind === 'config-alias' ? path.join(alias, 'candidate') : target;
    const result = spawnSync('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', destination],
      { cwd: repository, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, kind + ': ' + result.stdout + result.stderr);
    assert.match(result.stderr, /overlaps protected state/);
    assert.deepEqual(fullSnapshot(f.dir), before, kind + ' preserves all fixture bytes and metadata');
  }
});

test('copy-only Claude dogfood retains strict duplicate HOME protections', t => {
  for (const kind of ['source', 'CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    const f = processFixture(t);
    const source = path.join(f.dir, 'source-home');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(source, 'plugins/delivery-pipeline/scripts'), { recursive: true });
    for (const name of ['install-shipyard-claude-hook.sh', 'ensure-gsd-core.sh'])
      fs.copyFileSync(path.join(repository, 'scripts', name), path.join(source, 'scripts', name));
    fs.copyFileSync(path.join(repository, 'plugins/delivery-pipeline/scripts/host-provenance.cjs'),
      path.join(source, 'plugins/delivery-pipeline/scripts/host-provenance.cjs'));
    const home = kind === 'source' ? source : f.ambient;
    const target = path.join(home, 'candidate-plugin');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, '.shipyard-provenance.json'), '{}\n');
    fs.writeFileSync(path.join(target, 'sentinel'), 'preserve before recursive replacement\n', { mode: 0o640 });
    const env = { ...f.env, HOME: home, SHIPYARD_ISOLATION_ROOT: undefined,
      CLAUDE_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined };
    if (kind !== 'source') env[kind] = home;
    const before = fullSnapshot(f.dir);
    const result = spawnSync('/bin/bash', [path.join(source, 'scripts/install-shipyard-claude-hook.sh'), '--dogfood-root', target],
      { cwd: repository, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, kind);
    assert.match(result.stderr, /overlaps protected state/, kind);
    assert.deepEqual(fullSnapshot(f.dir), before, kind + ' refuses before deletion or copy');
  }
});

test('root-only canonical and published bootstrap use guarded runtime home before state access', t => {
  for (const entry of ['canonical', 'published']) {
    const f = processFixture(t);
    const before = fullSnapshot(f.ambient);
    const args = entry === 'canonical'
      ? ['-e', "require('./scripts/bootstrap-shipyard-plugin.cjs').bootstrap({packageRoot:require('node:path').resolve('plugins/shipyard')})"]
      : ['plugins/shipyard/host/scripts/bootstrap-shipyard-plugin.cjs'];
    const result = f.run(process.execPath, args, { CODEX_HOME: undefined });
    assert.equal(result.status, 0, entry + ': ' + result.stdout + result.stderr);
    assert.deepEqual(fullSnapshot(f.ambient), before, entry + ' preserves ambient bytes and metadata');
    const home = f.candidate;
    const marker = JSON.parse(fs.readFileSync(path.join(home, 'shipyard-plugin/installed.json')));
    assert.ok(marker.backup.startsWith(home + path.sep));
    assert.equal(fs.existsSync(path.join(home, 'shipyard-plugin/install.lock')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'agents/.shipyard-manifest.json')));
    assert.ok(Object.keys(manifest.agent_digests).length > 0);
    assert.ok(manifest.gsd_lib.startsWith(home + path.sep));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'agents/.shipyard-provenance.json'))).schema, 'shipyard.host-provenance.v1');
    assert.ok(fs.existsSync(path.join(home, 'shipyard-native-skills/shipyard-deliver/SKILL.md')));
    const nativeHome = path.join(f.candidate, '.shipyard-home');
    const trace = fs.readFileSync(path.join(nativeHome, 'child-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(trace.some(row => row.command === 'npx'));
    assert.ok(trace.every(row => row.home === nativeHome));
  }
});


test('explicit empty unwired Claude envelope refuses before copy', t => {
  const f = processFixture(t), before = fullSnapshot(f.dir);
  const result = f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(f.candidate, 'plugin')], { SHIPYARD_ISOLATION_ROOT: '' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /isolation refusal/);
  assert.deepEqual(fullSnapshot(f.dir), before);
});

test('canonical and published guards reject external inward aliases for every writable family', t => {
  const f = processFixture(t);
  fs.mkdirSync(f.candidate);
  const alias = path.join(f.dir, 'inward'); fs.symlinkSync(f.candidate, alias);
  const keys = ['CODEX_HOME', 'CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'AGENTS_SKILLS_DIR', 'CODEX_AGENTS_MD',
    'GSD_CAPABILITIES_DIR', 'GSD_CAPABILITIES_ROOT', 'GSD_DEFAULTS_PATH', 'GSD_HOME', 'SHIPYARD_DOGFOOD_ROOT',
    'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP',
    ...['cache', 'prefix', 'logs_dir', 'tmp', 'userconfig', 'globalconfig'].flatMap(k => ['npm_config_' + k, ('npm_config_' + k).toUpperCase()])];
  for (const script of ['scripts/ensure-gsd-core.sh', 'plugins/shipyard/host/scripts/ensure-gsd-core.sh']) {
    for (const key of keys) {
      const before = fullSnapshot(f.dir);
      const result = f.run('/bin/bash', [script, '--isolation-env', 'codex', f.candidate], { [key]: path.join(alias, 'destination') });
      assert.notEqual(result.status, 0, script + ': ' + key);
      assert.match(result.stderr, /isolation refusal/);
      assert.deepEqual(fullSnapshot(f.dir), before, key + ' no writes');
    }
    const before = fullSnapshot(f.dir);
    const result = f.run('/bin/bash', [script, '--isolation-env', 'codex', alias], { CODEX_HOME: undefined, CLAUDE_HOME: undefined, CLAUDE_CONFIG_DIR: undefined });
    assert.notEqual(result.status, 0, 'aliased envelope');
    assert.deepEqual(fullSnapshot(f.dir), before);
  }
});


test('direct dogfood selection cannot erase an unsafe inward alias before preflight', t => {
  const f = processFixture(t); fs.mkdirSync(f.candidate);
  const alias = path.join(f.dir, 'direct-inward'); fs.symlinkSync(f.candidate, alias);
  const before = fullSnapshot(f.dir);
  const result = f.run('/bin/bash', ['scripts/install-shipyard-codex.sh', '--dogfood-root', path.join(alias, 'codex')], { CODEX_HOME: undefined });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /isolation refusal/);
  assert.deepEqual(fullSnapshot(f.dir), before);
});


for (const transition of ['core', 'direct', 'claude', 'bootstrap', 'bootstrap-early', 'marketplace']) {
  test('dependency transitions rescan escaping aliases: ' + transition, t => {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    if (transition === 'bootstrap-early') {
      const installed = f.run(process.execPath, ['-e', "require('./scripts/bootstrap-shipyard-plugin.cjs').bootstrap({packageRoot:require('node:path').resolve('plugins/shipyard')});"]);
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    }
    const marker = path.join(f.candidate, 'codex/shipyard-plugin/installed.json');
    const priorMarker = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
    const priorPaths = Object.fromEntries(['parent-continuation', 'codex/agents', 'claude/hooks', 'claude/settings.json', 'codex/shipyard-plugin/capabilities.json', 'codex/shipyard-plugin/installed.json'].map(relative => [relative, fs.existsSync(path.join(f.candidate, relative))]));
    const mutation = `const fs=require('node:fs'),path=require('node:path');const root=process.env.SHIPYARD_ISOLATION_ROOT;fs.mkdirSync(root,{recursive:true});fs.symlinkSync(${JSON.stringify(f.ambient)},path.join(root,'dependency-escape'));fs.writeFileSync(path.join(root,'dependency-completed'),'fixture');`;
    let command = '/bin/bash', args;
    if (transition === 'core') {
      fs.appendFileSync(path.join(f.bin, 'npx'), '\n{' + mutation + '}');
      args = ['scripts/ensure-gsd-core.sh', 'codex'];
    } else if (transition === 'direct' || transition === 'claude') {
      fs.writeFileSync(path.join(f.bin, 'bash'), `#!${process.execPath}\nif(process.argv[2].endsWith('/ensure-gsd-core.sh')&&['codex','claude'].includes(process.argv[3])){const r=require('node:child_process').spawnSync(${JSON.stringify(path.join(f.bin, 'npx'))},[process.argv[3]==='claude'?'--claude':'--codex'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);${mutation}}else{const r=require('node:child_process').spawnSync('/bin/bash',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}`);
      fs.chmodSync(path.join(f.bin, 'bash'), 0o755);
      args = [transition === 'direct' ? 'scripts/install-shipyard-codex.sh' : 'scripts/install-shipyard-claude-hook.sh'];
    } else {
      command = process.execPath;
      const helper = path.join(repository, 'scripts/ensure-gsd-plugin.cjs');
      const fakeEnsure = `()=>{${mutation}return {version:'1.14.0'};}`;
      args = ['-e', transition.startsWith('bootstrap')
        ? `require(${JSON.stringify(helper)});require.cache[${JSON.stringify(helper)}].exports.ensure=${fakeEnsure};const cp=require('node:child_process'),original=cp.spawnSync;cp.spawnSync=(cmd,args,opts)=>{if(cmd==='bash'&&args[0].endsWith('/install-shipyard-codex.sh')){require('node:fs').writeFileSync(require('node:path').join(process.env.SHIPYARD_ISOLATION_ROOT,'parent-continuation'),'fixture');return {status:0};}return original(cmd,args,opts);};require('./scripts/bootstrap-shipyard-plugin.cjs').bootstrap({packageRoot:require('node:path').resolve('plugins/shipyard')});`
        : `require('./scripts/install-shipyard-marketplace.cjs').main(['codex','--source','https://example.invalid/fixture.git'],{ensure:${fakeEnsure},execute:()=>{throw Error('unexpected marketplace continuation')},read:()=>{throw Error('unexpected marketplace read')},run:()=>{throw Error('unexpected bootstrap continuation')}});`];
    }
    const result = f.run(command, args);
    assert.ok(fs.existsSync(path.join(f.candidate, 'dependency-completed')), transition + ': actual dependency transition ran');
    assert.notEqual(result.status, 0, transition + ': must refuse');
    assert.match(result.stderr, /isolation refusal/, transition + ': ' + result.stdout + result.stderr);
    assert.deepEqual(fullSnapshot(f.ambient), before, transition + ': no outside writes');
    for (const relative of ['parent-continuation', 'codex/agents', 'claude/hooks', 'claude/settings.json', 'codex/shipyard-plugin/capabilities.json', 'codex/shipyard-plugin/installed.json'])
      assert.equal(fs.existsSync(path.join(f.candidate, relative)), priorPaths[relative], transition + ': no further parent mutation at ' + relative);
    if (priorMarker !== null) assert.equal(fs.readFileSync(marker, 'utf8'), priorMarker, 'idempotence marker unchanged');
    if (transition === 'core') {
      const trace = fs.readFileSync(path.join(f.candidate, '.shipyard-home/child-trace.jsonl'), 'utf8');
      assert.equal(trace.includes('"command":"codex"'), false, 'marketplace helper never launched after npx');
    }
  });
}

for (const entry of ['direct', 'marketplace']) {
  test(`${entry} default dogfood selection consumes inherited XDG state base only for the dedicated root`, t => {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    const state = path.join(f.dir, 'external-state');
    const home = dogfoodHome('codex', fs.realpathSync(repository), { HOME: f.ambient, XDG_STATE_HOME: state });
    const extra = { CODEX_HOME: undefined, CLAUDE_HOME: undefined, CLAUDE_CONFIG_DIR: undefined,
      SHIPYARD_ISOLATION_ROOT: undefined, XDG_STATE_HOME: state, SHIPYARD_INSTALL_KIND: 'dogfood',
      SHIPYARD_SOURCE_ROOT: repository, FIXTURE_PACKAGE_ROOT: path.join(repository, 'plugins/shipyard') };
    const result = entry === 'direct'
      ? f.run('/bin/bash', ['scripts/install-shipyard-codex.sh'], extra)
      : f.run(process.execPath, ['scripts/install-shipyard-marketplace.cjs', 'codex', '--source', repository], extra);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fullSnapshot(f.ambient), before);
    assert.ok(fs.existsSync(path.join(home, 'agents/.shipyard-manifest.json')));
    const childHome = path.join(home, '.shipyard-home');
    const trace = fs.readFileSync(path.join(childHome, 'child-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(trace.some(row => row.command === 'npx'));
    assert.ok(trace.every(row => row.home === childHome));
    assert.ok(trace.filter(row => row.env).every(row => row.env.XDG_STATE_HOME.startsWith(home + path.sep)));
    assert.deepEqual(fs.readdirSync(state), ['shipyard']);

    const snapshot = fullSnapshot(f.dir);
    const refused = entry === 'direct'
      ? f.run('/bin/bash', ['scripts/install-shipyard-codex.sh', '--dogfood-root', f.candidate], { ...extra, CODEX_HOME: undefined })
      : f.run(process.execPath, ['scripts/install-shipyard-marketplace.cjs', 'codex', '--source', repository], { ...extra, CODEX_HOME: f.candidate });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /destination escapes candidate HOME envelope/);
    assert.deepEqual(fullSnapshot(f.dir), snapshot, 'independent escaping destination refuses before further writes');
  });
}

for (const transition of ['marketplace-add', 'bootstrap-installer', 'npm-query', 'core-plugin']) {
  test('fresh child mutations refuse before parent consumption: ' + transition, t => {
    const f = processFixture(t);
    const outside = path.join(f.ambient, 'outside-package');
    fs.mkdirSync(path.join(outside, 'host/scripts'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'package-build.json'), '{}');
    fs.writeFileSync(path.join(outside, 'host/scripts/bootstrap-shipyard-plugin.cjs'), "require('node:fs').writeFileSync(require('node:path').join(process.env.HOME,'outside-executed'),'bad');");
    const protectedBefore = fullSnapshot(f.ambient);
    const mutation = `const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});if(!fs.existsSync(path.join(process.env.CODEX_HOME,'child-escape')))fs.symlinkSync(${JSON.stringify(outside)},path.join(process.env.CODEX_HOME,'child-escape'));`;
    let command = process.execPath, args;
    if (transition === 'marketplace-add') {
      args = ['-e', `const fs=require('node:fs'),path=require('node:path');require('./scripts/install-shipyard-marketplace.cjs').main(['codex'],{ensure:()=>({version:'1.14.0'}),read:(c,a)=>a[1]==='marketplace'?{marketplaces:[]}:{installed:[{pluginId:'shipyard@shipyard',enabled:true,version:'local'}]},execute:(c,a,e)=>{if(c==='codex'&&a[1]==='add'){const cache=path.join(e.CODEX_HOME,'plugins/cache/shipyard/shipyard');fs.mkdirSync(cache,{recursive:true});fs.symlinkSync(${JSON.stringify(outside)},path.join(cache,'local'));}else if(c===process.execPath){require('node:child_process').execFileSync(c,a,{env:e});}}});`];
    } else if (transition === 'bootstrap-installer') {
      args = ['-e', `const cp=require('node:child_process'),original=cp.spawnSync;cp.spawnSync=(c,a,o)=>{if(c==='bash'&&a[0].endsWith('/install-shipyard-codex.sh')){${mutation}return {status:0};}return original(c,a,o);};require('./scripts/bootstrap-shipyard-plugin.cjs').bootstrap({packageRoot:require('node:path').resolve('plugins/shipyard')});`];
    } else {
      command = '/bin/bash'; args = ['scripts/ensure-gsd-core.sh', 'codex'];
      if (transition === 'npm-query') fs.appendFileSync(path.join(f.bin, 'npm'), '\n{' + mutation + '}');
      else {
        fs.writeFileSync(path.join(f.bin, 'codex'), `#!${process.execPath}\nconst a=process.argv.slice(2),fs=require('node:fs'),path=require('node:path');const marker=path.join(process.env.CODEX_HOME,'plugin-added');if(a.join(' ')==='plugin add gsd-core@gsd-core'){${mutation}fs.writeFileSync(marker,'fixture');}else if(a[1]==='marketplace')console.log(JSON.stringify({marketplaces:[{name:'gsd-core'}]}));else console.log(JSON.stringify({installed:fs.existsSync(marker)?[{pluginId:'gsd-core@gsd-core',enabled:true,version:'1.14.0'}]:[]}));`);
      }
    }
    const result = f.run(command, args, transition === 'npm-query' ? { GSD_CORE_VERSION: 'latest' } : {});
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /isolation refusal/);
    assert.deepEqual(fullSnapshot(f.ambient), protectedBefore);
    assert.equal(fs.existsSync(path.join(f.candidate, '.shipyard-home/outside-executed')), false);
    assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'shipyard-plugin/installed.json')), false);
    if (transition === 'npm-query') assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'gsd-core')), false);
  });
}

for (const transition of ['validator', 'generator', 'capability', 'codex-tuner', 'claude-stop', 'claude-tuner', 'config-merge', 'notify']) {
  test('installer continuation and cleanup refuse mutated candidate: ' + transition, t => {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    const preload = path.join(f.dir, 'mutating-child.cjs');
    fs.writeFileSync(preload, `const path=require('node:path');const script=path.basename(process.argv[1]||'');const match=${JSON.stringify(transition)};if((match==='validator'&&script==='gsd-tune.cjs'&&process.argv.includes('--validate-codex-bundle'))||(match==='config-merge'&&script==='merge-codex-config.cjs')||(match==='notify'&&script==='configure-codex-notify.cjs')||(match==='generator'&&script==='gen-codex-shipyard.cjs')||(match==='capability'&&script==='gsd-tools.cjs')||(match.endsWith('-tuner')&&script==='gsd-tune.cjs'&&process.argv.includes('--apply'))||(match==='claude-stop'&&script==='stop-gate.cjs'))process.on('exit',()=>{const fs=require('node:fs');fs.symlinkSync(${JSON.stringify(f.ambient)},path.join(process.env.SHIPYARD_ISOLATION_ROOT,'child-escape'));});`);
    const claude = transition.startsWith('claude');
    const completeBefore = fullSnapshot(f.dir);
    const result = f.run('/bin/bash', [claude ? 'scripts/install-shipyard-claude-hook.sh' : 'scripts/install-shipyard-codex.sh'], { NODE_OPTIONS: '--require=' + preload });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /isolation refusal/);
    assert.match(result.stderr, /unsupported NODE_OPTIONS/);
    assert.deepEqual(fullSnapshot(f.dir), completeBefore, 'preload refuses before any child or installer mutation');
    assert.deepEqual(fullSnapshot(f.ambient), before);
    if (!claude) assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'agents/.shipyard-provenance.json')), false);
    if (transition === 'generator') assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'agents')), false);
    if (transition === 'capability') assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'AGENTS.md')), false);
    if (transition === 'claude-stop') assert.equal(fs.existsSync(path.join(f.env.CLAUDE_HOME, 'settings.json')), false);
  });
}

for (const runtime of ['codex', 'claude']) for (const throws of [false, true]) {
  test(`marketplace ${runtime} mutation refuses next child and rollback (failure=${throws})`, t => {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    let calls = 0;
    const execute = (command, args, env) => {
      calls++;
      if (calls === 1) return;
      fs.mkdirSync(env.SHIPYARD_ISOLATION_ROOT, { recursive: true });
      fs.symlinkSync(f.ambient, path.join(env.SHIPYARD_ISOLATION_ROOT, 'marketplace-escape'));
      if (throws) throw new Error('fixture child failed after mutation');
    };
    const source = 'https://example.invalid/new.git';
    const read = (command, args) => runtime === 'codex'
      ? args[1] === 'marketplace' ? { marketplaces: [{ name: 'shipyard', marketplaceSource: { sourceType: 'git', source: 'https://example.invalid/old.git' } }] } : { installed: [] }
      : args[1] === 'marketplace' ? [{ name: 'shipyard', url: 'https://example.invalid/old.git' }] : [];
    const api = require('../../scripts/install-shipyard-marketplace.cjs');
    assert.throws(() => runtime === 'codex'
      ? api.installCodexMarketplace(source, execute, read, f.env)
      : api.installClaudeMarketplace(source, execute, read, () => ({}), f.env), /isolation refusal/);
    assert.equal(calls, 2, 'no further mutating child or rollback');
    assert.deepEqual(fullSnapshot(f.ambient), before);
  });
}

test('cleanup conditional context cannot suppress a failed isolation guard', t => {
  const f = processFixture(t);
  fs.mkdirSync(f.candidate);
  fs.symlinkSync(f.ambient, path.join(f.candidate, 'escape'));
  const before = fullSnapshot(f.dir);
  const result = f.run('/bin/bash', ['-c', 'source scripts/ensure-gsd-core.sh --library; prepare_isolation codex "$CODEX_HOME" "$SHIPYARD_ISOLATION_ROOT" || exit 3; touch "$SHIPYARD_ISOLATION_ROOT/continued"']);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /isolation refusal/);
  assert.deepEqual(fullSnapshot(f.dir), before, 'guard failure does not prepare directories or continue');
});

test('Claude capability child mutations are revalidated before marketplace install succeeds', t => {
  const f = processFixture(t);
  const marker = path.join(f.dir, 'capability-ran');
  const mutationScript = `const fs=require('node:fs'),path=require('node:path');fs.symlinkSync(${JSON.stringify(f.ambient)},path.join(process.env.SHIPYARD_ISOLATION_ROOT,'capability-escape'));`;
  fs.writeFileSync(path.join(f.bin, 'bash'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2),script=args[0]||'';
const result=cp.spawnSync('/bin/bash',args,{stdio:'inherit'});
if(result.status===0&&script.endsWith('/ensure-gsd-core.sh')&&args[1]==='claude'){
  fs.writeFileSync(path.join(process.env.CLAUDE_HOME,'gsd-core/bin/gsd-tools.cjs'),${JSON.stringify(mutationScript)});
}
if(result.status===0&&script.endsWith('/install-shipyard-capability.sh'))fs.writeFileSync(${JSON.stringify(marker)},'ran');
process.exit(result.status??1);
`);
  fs.chmodSync(path.join(f.bin, 'bash'), 0o755);
  const env = { ...f.env, PATH: `${f.bin}:${f.env.PATH}` };
  assert.throws(() => main(['claude', '--source', 'https://example.invalid/fixture.git'], {
    env,
    ensure: () => ({ version: '1.14.0' }),
    read: () => [],
    execute: () => {},
  }), /isolation refusal/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});

test('owned tuner cleans native fixture helpers before parent continuation and refuses hostile aliases', t => {
  const executable = process.execPath;
  const target = fs.realpathSync(executable);
  const bytes = fs.readFileSync(target), stat = fs.statSync(target);
  for (const hazard of ['none', 'unknown', 'repointed', 'preexisting', 'parent', 'shim', 'alias-hop', 'cli-repointed', 'parent-replaced']) {
    const f = processFixture(t), outside = fullSnapshot(f.ambient);
    const cliDir = path.join(f.candidate, 'native-bin'); fs.mkdirSync(cliDir, { recursive: true });
    const cli = path.join(cliDir, 'codex');
    fs.copyFileSync(executable, cli); fs.chmodSync(cli, 0o755);
    const probe = path.join(f.dir, 'probe.cjs');
    const mutation = hazard === 'unknown' ? "fs.symlinkSync(cli,path.join(dir,'unknown-helper'));"
      : hazard === 'repointed' ? "fs.unlinkSync(path.join(dir,'apply_patch'));fs.symlinkSync(process.env.HOME,path.join(dir,'apply_patch'));"
      : hazard === 'alias-hop' ? "const alias=path.join(process.env.SHIPYARD_ISOLATION_ROOT,'..','external-cli-alias');fs.symlinkSync(cli,alias);fs.unlinkSync(path.join(dir,'apply_patch'));fs.symlinkSync(alias,path.join(dir,'apply_patch'));"
      : hazard === 'cli-repointed' ? "const alias=process.env.PATH.split(path.delimiter)[0]+'/codex';fs.unlinkSync(alias);fs.symlinkSync(process.env.HOME,alias);"
      : hazard === 'parent-replaced' ? "fs.renameSync(base,base+'-old');fs.mkdirSync(base);"
      : '';
    fs.writeFileSync(probe, `const fs=require('node:fs'),path=require('node:path');const cli=${JSON.stringify(cli)};const r=require('node:child_process').spawnSync(cli,['--version'],{stdio:'inherit',timeout:10000});if(r.status!==0)process.exit(1);const base=path.join(process.env.CODEX_HOME,'tmp/arg0'),dir=path.join(base,'codex-arg0Fixture');fs.mkdirSync(dir,{recursive:true});for(const leaf of ['apply_patch','applypatch','codex-execve-wrapper'])fs.symlinkSync(cli,path.join(dir,leaf));${mutation}`);
    if (hazard === 'shim') {
      fs.unlinkSync(cli);
      fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    if (hazard === 'preexisting' || hazard === 'parent') {
      const dir = path.join(f.env.CODEX_HOME, 'tmp/arg0/codex-arg0Before');
      fs.mkdirSync(dir, { recursive: true });
      if (hazard === 'preexisting') fs.symlinkSync(executable, path.join(dir, 'apply_patch'));
      else { fs.rmdirSync(dir); fs.symlinkSync(f.ambient, dir); }
    }
    fs.mkdirSync(f.env.CODEX_HOME, { recursive: true, mode: 0o700 });
    const before = fullSnapshot(f.candidate);
    const result = f.run('/bin/bash', ['-c', 'source scripts/ensure-gsd-core.sh --library; prepare_isolation codex "$CODEX_HOME" "$SHIPYARD_ISOLATION_ROOT"; run_isolated_tuner "$1" || exit $?; isolation_env codex "$SHIPYARD_ISOLATION_ROOT" >/dev/null || exit $?; touch "$CODEX_HOME/parent-continued"', 'probe', probe], { PATH: `${cliDir}:${f.env.PATH}` });
    if (hazard === 'none') {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /v\d+\.\d+\.\d+/, 'native fixture version input remains available');
      assert.ok(fs.existsSync(path.join(f.env.CODEX_HOME, 'parent-continued')));
      const base = path.join(f.env.CODEX_HOME, 'tmp/arg0');
      for (const dir of fs.readdirSync(base)) for (const leaf of ['apply_patch', 'applypatch', 'codex-execve-wrapper'])
        assert.equal(fs.existsSync(path.join(base, dir, leaf)), false);
    } else {
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /isolation refusal/);
      assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'parent-continued')), false);
      if (hazard === 'preexisting' || hazard === 'parent') assert.deepEqual(fullSnapshot(f.candidate), before);
    }
    assert.deepEqual(fullSnapshot(f.ambient), outside);
    assert.deepEqual(fs.readFileSync(target), bytes);
    const after = fs.statSync(target);
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) assert.equal(after[key], stat[key], key);
  }
});


test('exported Codex marketplace refuses compromised candidate before read', t => {
  const f = processFixture(t);
  fs.mkdirSync(f.candidate);
  fs.symlinkSync(f.ambient, path.join(f.candidate, 'escape'));
  const before = fullSnapshot(f.dir);
  let reads = 0, writes = 0;
  assert.throws(() => installCodexMarketplace('example/fixture', () => writes++, () => {
    reads++; return { marketplaces: [] };
  }, f.env), /isolation refusal/);
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.deepEqual(fullSnapshot(f.dir), before);
});

test('explicit temp templates confine Codex stage and Claude verification with BSD mktemp behavior', t => {
  for (const runtime of ['codex', 'claude', 'capability']) {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    const trace = path.join(f.dir, 'mktemp-trace.jsonl');
    fs.writeFileSync(path.join(f.bin, 'mktemp'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),template=args.find(x=>!x.startsWith('-'));
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,tmp:process.env.TMPDIR})+'\\n');
if(!template){console.error('fixture BSD mktemp would ignore TMPDIR');process.exit(98);}
if(!template.endsWith('XXXXXX'))process.exit(97);
const dir=fs.mkdtempSync(template.slice(0,-6));console.log(dir);
`);
    fs.chmodSync(path.join(f.bin, 'mktemp'), 0o755);
    let result;
    if (runtime === 'capability') {
      const dependency = f.run('/bin/bash', ['scripts/ensure-gsd-core.sh', 'claude']);
      assert.equal(dependency.status, 0, dependency.stdout + dependency.stderr);
      const tmp = path.join(f.candidate, '.shipyard-tmp');
      fs.mkdirSync(tmp, { recursive: true });
      result = f.run('/bin/bash', ['scripts/install-shipyard-capability.sh', 'claude'], {
        TMPDIR: tmp,
        GSD_CAPABILITIES_DIR: path.join(f.candidate, '.shipyard-home/.gsd/capabilities'),
      });
    } else {
      result = f.run('/bin/bash', runtime === 'codex' ? ['scripts/install-shipyard-codex.sh']
        : ['scripts/install-shipyard-claude-hook.sh', '--dogfood-root', path.join(f.candidate, 'plugin'), '--wire-hooks']);
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(row => row.args.some(arg => arg.startsWith(f.candidate + path.sep))));
    assert.ok(calls.some(row => row.args.some(arg => arg.startsWith(row.tmp + path.sep))));
    assert.deepEqual(fullSnapshot(f.ambient), before);
  }
});

test('Codex plugin list mutation refuses before cache inspection or bootstrap consumption', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  const installer = require('../../scripts/install-shipyard-marketplace.cjs');
  let executed = false;
  const read = () => {
    const cache = path.join(f.env.CODEX_HOME, 'plugins/cache');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.symlinkSync(f.ambient, cache);
    return { installed: [{ pluginId: 'shipyard@shipyard', enabled: true, version: 'local' }] };
  };
  assert.throws(() => installer.setupCodexHost('fixture', () => { executed = true; }, read,
    undefined, undefined, f.env, { home: f.env.CODEX_HOME, env: f.env }), /isolation refusal/);
  assert.equal(executed, false);
  assert.deepEqual(fullSnapshot(f.ambient), before);
});

test('isolated preflight preserves supported diagnostics and explicitly refuses import options', t => {
  const f = processFixture(t);
  const before = fullSnapshot(f.dir);
  const args = ['scripts/ensure-gsd-core.sh', '--isolation-env', 'codex', f.candidate];
  const safe = f.run('/bin/bash', args, { NODE_OPTIONS: '--no-warnings --trace-warnings' });
  assert.equal(safe.status, 0, safe.stderr);
  assert.equal({ NODE_OPTIONS: '--no-warnings --trace-warnings', ...JSON.parse(safe.stdout).environment }.NODE_OPTIONS, '--no-warnings --trace-warnings');
  const refused = f.run('/bin/bash', args, { NODE_OPTIONS: '--import=data:text/javascript,process.exit(0)' });
  assert.equal(refused.status, 3, refused.stderr);
  assert.match(refused.stderr, /unsupported NODE_OPTIONS/);
  assert.deepEqual(fullSnapshot(f.dir), before);
});


test('original-home marker is trusted only for a generated rebased child', t => {
  for (const entry of ['scripts/ensure-gsd-core.sh', 'plugins/shipyard/host/scripts/ensure-gsd-core.sh']) {
    const f = processFixture(t);
    assert.notEqual(f.ambient, os.userInfo().homedir);
    const before = fullSnapshot(f.dir);
    const forged = f.run('/bin/bash', [entry, 'codex'], {
      SHIPYARD_ORIGINAL_HOME: path.join(f.dir, 'stale-home'),
      SHIPYARD_ISOLATION_ROOT: f.ambient, CODEX_HOME: f.ambient,
      CLAUDE_HOME: undefined, CLAUDE_CONFIG_DIR: undefined,
    });
    assert.notEqual(forged.status, 0, entry + ': forged marker must refuse');
    assert.match(forged.stderr, /candidate aliases active state/, entry);
    assert.deepEqual(fullSnapshot(f.dir), before, entry + ': no candidate or dependency mutation');
    const first = f.run('/bin/bash', [entry, '--isolation-env', 'codex', f.candidate], {
      SHIPYARD_ORIGINAL_HOME: path.join(f.dir, 'stale-home'),
    });
    assert.equal(first.status, 0, first.stderr);
    const prepared = JSON.parse(first.stdout).environment;
    assert.equal(prepared.SHIPYARD_ORIGINAL_HOME, f.ambient);
    assert.equal(prepared.HOME, path.join(f.candidate, '.shipyard-home'));
    const repeated = f.run('/bin/bash', [entry, '--isolation-env', 'codex', f.candidate], prepared);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout).environment, prepared);
    const protectedRoot = path.join(f.ambient, '.codex');
    const protectedChild = f.run('/bin/bash', [entry, '--isolation-env', 'codex', protectedRoot], {
      ...prepared, HOME: path.join(protectedRoot, '.shipyard-home'),
    });
    assert.notEqual(protectedChild.status, 0);
    assert.match(protectedChild.stderr, /candidate aliases active state/);
    assert.deepEqual(fullSnapshot(f.dir), before, entry + ': repeated validation is read only');
  }
});


test('original-home marker cannot turn an aliased child HOME into a generated rebase', t => {
  const f = processFixture(t);
  const childHome = path.join(f.candidate, '.shipyard-home');
  fs.mkdirSync(childHome, { recursive: true });
  const alias = path.join(f.dir, 'child-home-alias');
  fs.symlinkSync(childHome, alias);
  const before = fullSnapshot(f.dir);
  for (const entry of ['scripts/ensure-gsd-core.sh', 'plugins/shipyard/host/scripts/ensure-gsd-core.sh']) {
    const result = f.run('/bin/bash', [entry, '--isolation-env', 'codex', f.candidate], {
      HOME: alias, SHIPYARD_ORIGINAL_HOME: f.ambient,
    });
    assert.notEqual(result.status, 0, entry);
    assert.match(result.stderr, /candidate aliases active state/, entry);
    assert.deepEqual(fullSnapshot(f.dir), before);
    const legitimate = f.run('/bin/bash', [entry, '--isolation-env', 'codex', f.candidate], {
      HOME: childHome, SHIPYARD_ORIGINAL_HOME: f.ambient,
    });
    assert.equal(legitimate.status, 0, legitimate.stderr);
    assert.equal(JSON.parse(legitimate.stdout).environment.SHIPYARD_ORIGINAL_HOME, f.ambient);
    assert.deepEqual(fullSnapshot(f.dir), before);
  }
});

for (const kind of ['require', 'import']) test(`supported shell startup blocks effective ${kind} evaluation and exit writers`, t => {
  const f = processFixture(t), packageRoot = path.join(f.dir, 'fresh-package');
  require('../../scripts/package-shipyard-codex.cjs').build(packageRoot);
  const marker = path.join(f.dir, 'preload-executed');
  const preload = path.join(f.dir, `writer.${kind === 'require' ? 'cjs' : 'mjs'}`);
  const imports = kind === 'require' ? "const fs=require('node:fs');" : "import fs from 'node:fs';";
  fs.writeFileSync(preload, imports + `const write=()=>{fs.writeFileSync(${JSON.stringify(marker)},'executed');fs.writeFileSync(${JSON.stringify(path.join(f.ambient, '.gsd/defaults.json'))},'preload write');};write();process.on('exit',write);`);
  const options = `--${kind}=${preload}`;
  const hook = JSON.parse(fs.readFileSync(path.join(packageRoot, 'hooks/hooks.json'))).hooks.SessionStart[0].hooks[0].command;
  const entries = [
    ['scripts/ensure-gsd-core.sh', '--launch-marketplace', 'codex', '--source', repository],
    ['scripts/ensure-gsd-core.sh', '--launch-marketplace', 'claude', '--source', repository],
    ['-c', hook]
  ];
  const protectedBefore = fullSnapshot(f.ambient), before = fullSnapshot(f.dir);
  for (const args of entries) {
    const result = f.run('/bin/bash', args, { NODE_OPTIONS: options, PLUGIN_ROOT: packageRoot });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /unsupported NODE_OPTIONS/);
    assert.deepEqual(fullSnapshot(f.dir), before);
  }
  const control = f.run(process.execPath, ['-e', ''], { NODE_OPTIONS: options });
  assert.equal(control.status, 0, control.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
  assert.notDeepEqual(fullSnapshot(f.ambient), protectedBefore);
});

test('ordinary active generated hook supports safe diagnostic startup', t => {
  const f = processFixture(t), packageRoot = path.join(f.dir, 'ordinary-package'), home = path.join(f.dir, 'ordinary-home');
  fs.mkdirSync(home);
  require('../../scripts/package-shipyard-codex.cjs').build(packageRoot);
  const hook = JSON.parse(fs.readFileSync(path.join(packageRoot, 'hooks/hooks.json'))).hooks.SessionStart[0].hooks[0].command;
  for (const options of ['', '--no-warnings --trace-warnings']) {
    const result = f.run('/bin/bash', ['-c', hook], { HOME: home, PLUGIN_ROOT: packageRoot,
      SHIPYARD_ISOLATION_ROOT: undefined, CODEX_HOME: undefined, CLAUDE_HOME: undefined,
      GSD_CAPABILITIES_DIR: path.join(home, '.gsd/capabilities'),
      CLAUDE_CONFIG_DIR: undefined, NODE_OPTIONS: options });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fs.existsSync(path.join(home, '.codex/shipyard-plugin/installed.json')));
  }
});

function publishedSequenceFixture(t) {
  const f = processFixture(t), checkout = path.join(f.dir, 'checkout');
  fs.mkdirSync(checkout);
  for (const entry of ['scripts', 'plugins', 'capabilities', 'Makefile', 'README.md', 'CLAUDE.md']) {
    fs.cpSync(path.join(repository, entry), path.join(checkout, entry), { recursive: true });
  }
  const sequences = [];
  for (const file of ['README.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(checkout, file), 'utf8');
    for (const match of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
      if (match[1].includes('--launch-marketplace')) sequences.push([file, match[1]]);
    }
  }
  assert.equal(sequences.length, 3);
  for (const target of ['package-shipyard-codex', 'install-shipyard-codex',
    'install-shipyard-marketplace-codex', 'install-shipyard-marketplace-claude']) {
    sequences.push([target, 'make ' + target]);
  }
  const run = (script, extra = {}) => spawnSync('/bin/bash', ['-ec', script], {
    cwd: checkout, env: { ...f.env, ...extra }, encoding: 'utf8', timeout: 90000,
  });
  return { ...f, checkout, sequences, run };
}

for (const kind of ['require', 'import']) test(`complete published sequences refuse ${kind} before package or dogfood Node startup`, t => {
  const f = publishedSequenceFixture(t), marker = path.join(f.dir, 'preload-marker');
  const preload = path.join(f.dir, 'writer.' + (kind === 'require' ? 'cjs' : 'mjs'));
  const imports = kind === 'require' ? "const fs=require('node:fs');" : "import fs from 'node:fs';";
  fs.writeFileSync(preload, imports + `const write=()=>{fs.writeFileSync(${JSON.stringify(marker)},'executed');fs.writeFileSync(${JSON.stringify(path.join(f.ambient, '.gsd/defaults.json'))},'preload write');};write();process.on('exit',write);`);
  const before = fullSnapshot(f.dir);
  for (const [name, script] of f.sequences) {
    const result = f.run(script, { NODE_OPTIONS: `--${kind}=${preload}` });
    assert.notEqual(result.status, 0, name + result.stdout + result.stderr);
    assert.match(result.stderr, /unsupported NODE_OPTIONS/, name);
    assert.deepEqual(fullSnapshot(f.dir), before, name + ' leaves package, candidate, traces and outside sentinels unchanged');
  }
  const control = f.run('node -e ""', { NODE_OPTIONS: `--${kind}=${preload}` });
  assert.equal(control.status, 0, control.stderr);
  assert.ok(fs.existsSync(marker));
  assert.notDeepEqual(fullSnapshot(f.dir), before, 'effective disposable direct-Node control');
});

test('guarded Make package and published local route support ordinary safe startup', t => {
  const f = publishedSequenceFixture(t), home = path.join(f.dir, 'ordinary-home');
  fs.mkdirSync(home);
  const before = fullSnapshot(f.ambient);
  for (const options of ['', '--no-warnings --trace-warnings']) {
    const result = f.run('make package-shipyard-codex\nmake install-shipyard-marketplace-codex', { NODE_OPTIONS: options, HOME: home,
      SHIPYARD_ISOLATION_ROOT: undefined, CODEX_HOME: undefined, CLAUDE_HOME: undefined,
      CLAUDE_CONFIG_DIR: undefined, GSD_CAPABILITIES_DIR: path.join(home, '.gsd/capabilities'),
      FIXTURE_PACKAGE_ROOT: path.join(f.checkout, 'plugins/shipyard') });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fs.existsSync(path.join(home, '.codex/shipyard-plugin/installed.json')));
    assert.deepEqual(fullSnapshot(f.ambient), before);
    const generated = JSON.parse(fs.readFileSync(path.join(f.checkout, 'plugins/shipyard/package-build.json')));
    assert.match(generated.digest, /^[a-f0-9]{64}$/);
    const local = f.run(f.sequences[0][1], { NODE_OPTIONS: options,
      FIXTURE_PACKAGE_ROOT: path.join(f.checkout, 'plugins/shipyard') });
    assert.equal(local.status, 0, local.stdout + local.stderr);
    assert.ok(fs.existsSync(path.join(f.env.CODEX_HOME, 'shipyard-plugin/installed.json')));
    assert.deepEqual(fullSnapshot(f.ambient), before);
  }
});

for (const hazard of ['alias', 'capabilities']) {
  test(`bootstrap capability probe refuses child-created ${hazard} before capability write`, t => {
    const f = processFixture(t), before = fullSnapshot(f.ambient);
    const packageRoot = path.join(f.dir, 'package');
    require('../../scripts/package-shipyard-codex.cjs').build(packageRoot);
    const sentinel = path.join(f.ambient, '.gsd/defaults.json');
    const target = hazard === 'capabilities'
      ? path.join(f.env.CODEX_HOME, 'shipyard-plugin/capabilities.json')
      : path.join(f.candidate, 'probe-escape');
    fs.writeFileSync(path.join(f.bin, 'codex'), `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
if(a.join(' ')==='debug models'){fs.symlinkSync(${JSON.stringify(hazard === 'capabilities' ? sentinel : f.ambient)},${JSON.stringify(target)});console.log(JSON.stringify({models:[]}));}
else if(a[1]==='marketplace')console.log(JSON.stringify({marketplaces:[{name:'gsd-core'}]}));
else console.log(JSON.stringify({installed:[{pluginId:'gsd-core@gsd-core',enabled:true,version:'1.14.0'}]}));
`);
    const result = f.run('/bin/bash', ['-c', 'bash "$PLUGIN_ROOT/host/scripts/ensure-gsd-core.sh" --launch-bootstrap'],
      { PLUGIN_ROOT: packageRoot, SHIPYARD_CODEX_CAPABILITIES_FILE: undefined });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /isolation refusal/);
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'probe actually introduced the hazard');
    assert.deepEqual(fullSnapshot(f.ambient), before);
    assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'agents')), false);
    if(hazard === 'alias') assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'shipyard-plugin/capabilities.json')), false);
  });
}

test('ordinary custom Claude home installs and removes while explicit invalid envelopes refuse', t => {
  const f = processFixture(t), before = fullSnapshot(f.ambient);
  const custom = path.join(f.dir, 'ordinary-claude');
  const env = { SHIPYARD_ISOLATION_ROOT: undefined, CLAUDE_HOME: custom,
    CLAUDE_CONFIG_DIR: custom, CODEX_HOME: undefined, SHIPYARD_GSD_AUTO_INSTALL: '0' };
  for (const envelope of ['', 'relative-root']) {
    const snapshot = fullSnapshot(f.dir);
    const refused = f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh'], { ...env, SHIPYARD_ISOLATION_ROOT: envelope });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /isolation refusal/);
    assert.deepEqual(fullSnapshot(f.dir), snapshot);
  }
  const installed = f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh'], env);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(JSON.parse(fs.readFileSync(path.join(custom, 'settings.json'))).hooks.UserPromptSubmit.length);
  assert.deepEqual(fullSnapshot(f.ambient), before);
  const removed = f.run('/bin/bash', ['scripts/install-shipyard-claude-hook.sh', '--remove'], env);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(fs.existsSync(path.join(custom, 'hooks/shipyard-auto-route.sh')), false);
  assert.deepEqual(fullSnapshot(f.ambient), before);
});
