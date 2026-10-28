'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const policy = require(path.join(scripts, 'model-policy.cjs'));
const adapters = require(path.join(scripts, 'runtime-adapters.cjs'));
const quiet = { write() {} };
const constructed = new Error('fixture: stopped after real runtime construction');
const nativeStopped = new Error('fixture: stopped at native spawn; no receipt produced');

function roleBuilders() {
  const file = path.join(__dirname, 'claude-role-host.test.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(__dirname);
  const source = fs.readFileSync(file, 'utf8');
  loaded._compile(`const test = () => {};
    const assert = require('node:assert/strict');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    ${source.slice(source.indexOf("const crypto = require('node:crypto');"))}
    module.exports = { setupRepository, hostOptions, request, cleanupFixture, useCoordinatorGraph };`, file);
  return loaded.exports;
}

function fixture(t, runtime, entry) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-launch-')));
  const saved = { ...process.env };
  const savedCwd = process.cwd();
  const savedHome = os.homedir;
  let role, builders;
  t.after(() => {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    os.homedir = savedHome;
    if (role) builders.cleanupFixture(role);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  os.homedir = () => home;
  for (const key of Object.keys(process.env)) {
    if (/^(CODEX|CLAUDE|SHIPYARD|GSD|ANTHROPIC|OPENAI)_/.test(key)) delete process.env[key];
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete process.env[key];
  }
  for (const key of ['GNUPGHOME', 'GPG_AGENT_INFO', 'GPG_TTY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID']) delete process.env[key];
  const gitConfig = path.join(home, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  Object.assign(process.env, { HOME: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: bin + path.delimiter + saved.PATH,
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const worktree = path.join(dir, 'project');
  fs.mkdirSync(worktree);
  execFileSync('git', ['init', '-q', worktree]);
  fs.mkdirSync(process.env.CODEX_HOME);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const config = runtime === 'codex' ? path.join(process.env.CODEX_HOME, 'config.toml')
    : path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(config, runtime === 'codex' ? '# initial\n' : '{}\n');
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(calls, '');
  const executable = path.join(bin, runtime);
  const help = runtime === 'codex' ? '--json --model --config --cd --ignore-user-config'
    : '--model --effort --output-format stream-json --session-id --permission-mode --permission-prompts --allowedTools --tools --restricted --strict-mcp-config --settings --setting-sources --agent --agents';
  fs.writeFileSync(executable, `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
    if (process.argv[2] === '--version') console.log('${runtime}-fixture 1.2.3');
    else if (process.argv[2] === 'auth') console.log('{"loggedIn":true,"authMethod":"fixture-native-mode"}');
    else console.log(${JSON.stringify(help)});
  `, { mode: 0o755 });
  const caps = path.join(dir, 'capabilities.json');
  fs.writeFileSync(caps, JSON.stringify({ supportedModels: Object.values(adapters.CODEX_MODEL_IDS),
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }));
  process.env.SHIPYARD_CODEX_CAPABILITIES_FILE = caps;
  let request, argv, options;
  if (entry === 'role') {
    builders = roleBuilders();
    role = builders.setupRepository('arch-review');
    builders.useCoordinatorGraph(role);
    request = builders.request(role);
    options = builders.hostOptions(role);
    delete options.createRuntimeHost;
  } else {
    request = runtime === 'codex'
      ? { scope: { run_id: 'reuse-launch', ticket: 'T-53-05', phase: 53, worktree },
        role: 'drift-check', context: { prompt: 'fixture launch' } }
      : { schema: 'shipyard.claude-delivery-request.v1',
        scope: { run_id: 'reuse-launch', ticket: 'T-53-05', phase: 53, worktree },
        args: { tickets: [{ id: 'T-53-05', worktreePath: worktree }] } };
    options = { storageRoot: path.join(dir, 'storage') };
  }
  process.chdir(role ? role.root : worktree);
  const requestFile = path.join(dir, 'request.json');
  const writeRequest = () => fs.writeFileSync(requestFile, JSON.stringify(request));
  writeRequest();
  argv = runtime === 'codex' || entry === 'role' ? ['--args-file', requestFile]
    : ['--workflow', 'executors', '--request-file', requestFile];
  const versions = [], launches = [], pending = [];
  let invocation = 0;
  let mutate = () => {};
  const native = require(path.join(scripts, `${runtime}-runtime-host.cjs`));
  const factoryName = runtime === 'codex' ? 'createCodexRuntimeHost' : 'createClaudeRuntimeHost';
  const factory = input => {
    mutate(input);
    input.controller = { ...input.controller, markUnavailable() {} };
    const host = native[factoryName](input);
    versions.push(host.runtime_version);
    const selection = policy.resolveDispatch({ runtime, role: 'drift-check', signals: {} });
    const launch = runtime === 'codex'
      ? host.launch({ ...selection, sandbox_mode: 'read-only' }, { prompt: 'fixture launch', dispatch_id: 'fixture-launch' })
      : host.agent('fixture launch', { ...selection, readOnly: true });
    pending.push(assert.rejects(launch, /fixture: stopped at native spawn/));
    throw constructed;
  };
  Object.assign(options, { executable, preflightStderr: quiet, stderr: quiet,
    spawn(file, args, settings) { launches.push({ file, args, settings }); throw nativeStopped; } });
  const filename = path.join(scripts, `${runtime}-${entry === 'role' ? 'role' : 'delivery'}-host.cjs`);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(scripts);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => name === `./${runtime}-runtime-host.cjs`
    ? { ...native, [factoryName]: factory } : originalRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const invoke = loaded.exports[runtime === 'codex' ? 'runCli'
    : entry === 'role' ? 'runClaudeRoleCli' : 'runClaudeDeliveryCli'];
  return { dir, home, executable, config, calls, request, options, versions, launches,
    worktree: role ? role.root : worktree, writeRequest,
    mutate(fn) { mutate = fn; },
    physicalCalls() { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean); },
    count() { return this.physicalCalls().filter(line => line === '--version').length; },
    async run(extra = {}) {
      let failure;
      if (request.scope) {
        request.scope.run_id = `reuse-launch-${++invocation}`;
        writeRequest();
      }
      try { await invoke(argv, quiet, { ...options, ...extra }); } catch (error) { failure = error; }
      await Promise.all(pending.splice(0));
      return failure;
    } };
}

for (const [runtime, entry] of [['codex', 'delivery'], ['claude', 'delivery'], ['claude', 'role']]) {
  const label = `${runtime} ${entry}`;
  test(`${label}: actual CLI and native constructor acquire one unchanged observation per launch`, async t => {
    const f = fixture(t, runtime, entry);
    let originalOptions;
    f.mutate(input => { originalOptions ||= input; });
    assert.equal(await f.run(), constructed);
    assert.equal(f.count(), 1);
    assert.deepEqual(f.physicalCalls(), runtime === 'codex' ? ['--version', 'exec --help']
      : ['--version', '--help', 'auth status --json']);
    assert.deepEqual(f.versions, [`${runtime}-fixture 1.2.3`]);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].file, f.executable);
    assert.ok(f.launches[0].args.includes('--model'));
    assert.ok(f.launches[0].args.includes(runtime === 'codex' ? '--config' : '--effort'));
    const selected = policy.resolveDispatch({ runtime, role: 'drift-check', signals: {} });
    assert.equal(f.launches[0].args[f.launches[0].args.indexOf('--model') + 1], selected.model);
    assert.ok(runtime === 'codex'
      ? f.launches[0].args.includes(`model_reasoning_effort="${selected.effort}"`)
      : f.launches[0].args[f.launches[0].args.indexOf('--effort') + 1] === selected.effort);
    assert.equal(await f.run({ preparation: originalOptions, validated: true, reuse: true }), constructed);
    assert.equal(f.count(), 2, 'a new launch must acquire a new observation');
  });
  for (const mutation of ['config', 'executable', 'resolution', 'environment', 'instructions', 'auth-mode', 'policy']) {
    test(`${label}: ${mutation} mutation between preflight and construction refreshes`, async t => {
      const f = fixture(t, runtime, entry);
      f.mutate(input => {
        if (mutation === 'policy') {
          const read = fs.readFileSync, policyFile = path.join(scripts, 'model-policy.cjs');
          t.after(() => { fs.readFileSync = read; });
          fs.readFileSync = function(file, ...args) {
            const value = read.call(this, file, ...args);
            if (String(file) !== policyFile) return value;
            return Buffer.isBuffer(value) ? Buffer.concat([value, Buffer.from('\nchanged policy source\n')])
              : value + '\nchanged policy source\n';
          };
        }
        if (mutation === 'config') fs.appendFileSync(f.config, '\n');
        if (mutation === 'executable') fs.appendFileSync(f.executable, '\n// changed executable\n');
        if (mutation === 'resolution') {
          const replacement = path.join(f.dir, 'replacement');
          fs.copyFileSync(f.executable, replacement);
          input.executable = replacement;
        }
        if (mutation === 'environment') process.env[`${runtime.toUpperCase()}_MODEL`] = 'changed';
        if (mutation === 'instructions') fs.writeFileSync(path.join(f.worktree, 'AGENTS.md'), 'new instruction\n');
        if (mutation === 'auth-mode') process.env[runtime === 'codex' ? 'CODEX_API_KEY' : 'CLAUDE_CODE_USE_BEDROCK'] = 'fixture-mode';
      });
      assert.equal(await f.run(), constructed);
      assert.equal(f.count(), 2);
      assert.equal(f.launches.length, 1);
    });
  }
  test(`${label}: an executable lost after preflight refuses without native spawn`, async t => {
    const f = fixture(t, runtime, entry);
    f.mutate(() => fs.unlinkSync(f.executable));
    const error = await f.run();
    assert.equal(error?.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(f.launches.length, 0);
  });
  test(`${label}: unchanged command text with a new PATH resolution refreshes`, async t => {
    const f = fixture(t, runtime, entry);
    const bin = path.join(f.dir, 'replacement-bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(f.executable, path.join(bin, runtime));
    f.mutate(() => { process.env.PATH = bin + path.delimiter + process.env.PATH; });
    assert.equal(await f.run({ executable: runtime }), constructed);
    assert.equal(f.count(), 2);
    assert.equal(f.launches[0].settings.env.PATH.split(path.delimiter)[0], bin);
  });
  if (runtime === 'claude') test(`${label}: changed native reference bytes invalidate preparation`, async t => {
    const f = fixture(t, runtime, entry);
    const read = fs.readFileSync;
    const reference = path.resolve(scripts, '../references', entry === 'role' ? 'arch-review.md' : 'drift-check.md');
    t.after(() => { fs.readFileSync = read; });
    f.mutate(() => {
      fs.readFileSync = function(file, ...args) {
        const bytes = read.call(this, file, ...args);
        if (String(file) !== reference) return bytes;
        return Buffer.isBuffer(bytes) ? Buffer.concat([bytes, Buffer.from('\nchanged reference\n')]) : bytes + '\nchanged reference\n';
      };
    });
    assert.equal(await f.run(), constructed);
    assert.equal(f.count(), 2);
  });
  test(`${label}: failed preflight never constructs or launches a native child`, async t => {
    const f = fixture(t, runtime, entry);
    fs.writeFileSync(f.executable, '#!/bin/sh\nexit 7\n');
    assert.equal((await f.run())?.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(f.versions.length, 0);
    assert.equal(f.launches.length, 0);
  });
  for (const observation of [undefined, { status: 'malformed' }, { status: 'unavailable', reason: 'runtime_missing' }])
    test(`${label}: unsuccessful observation ${JSON.stringify(observation)} never launches`, async t => {
      const f = fixture(t, runtime, entry);
      assert.equal((await f.run({ probe: () => observation }))?.code, 'RUNTIME_UNAVAILABLE');
      assert.equal(f.versions.length, 0);
      assert.equal(f.launches.length, 0);
      assert.equal(f.count(), 0);
    });
  test(`${label}: serialized availability and reuse flags grant no preparation`, async t => {
    const f = fixture(t, runtime, entry);
    Object.assign(f.request, { probe: { status: 'available', executable: f.executable },
      preparation: { validated: true }, reuse: true });
    f.writeRequest();
    assert.ok(await f.run());
    assert.equal(f.count(), 0);
    assert.equal(f.launches.length, 0);
  });
  test(`${label}: missing private observation reacquires through the native constructor`, async t => {
    const f = fixture(t, runtime, entry);
    assert.equal(await f.run({ probe: () => ({ status: 'available' }) }), constructed);
    assert.equal(f.count(), 1);
    assert.equal(f.launches.length, 1);
  });
}


const runtimeFixtureFile = path.join(__dirname, 'runtime-context.test.cjs');
const runtimeFixtureModule = new Module(runtimeFixtureFile, module);
runtimeFixtureModule.filename = runtimeFixtureFile;
runtimeFixtureModule.paths = Module._nodeModulePaths(__dirname);
const runtimeFixtureSource = fs.readFileSync(runtimeFixtureFile, 'utf8').split("suite('runtime context")[0]
  .replace("const { suite, test, done, assert } = require('./assert-harness.cjs');", "const assert = require('node:assert/strict');");
runtimeFixtureModule._compile(runtimeFixtureSource + '\nmodule.exports = { project };', runtimeFixtureFile);
const { project } = runtimeFixtureModule.exports;



function launchFixture() {
  const root = project(undefined);
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const options = { scope: { worktree: root }, executable, env: { HOME: root, CODEX_HOME: root,
    SHIPYARD_RUNTIME: 'codex', GSD_RUNTIME: 'codex', GSD_HOME: root,
    GSD_TOOLS: undefined, SHIPYARD_GSD_TOOLS: undefined, GSD_CORE_HOME: undefined,
    SHIPYARD_CODEX_CAPABILITIES_FILE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_PLUGIN_ROOT: undefined } };
  const probe = { schema: 'shipyard.codex-runtime-probe.v1', version: 1, status: 'available',
    executable, runtime_version: 'original-native-version', capabilities: {
      supportedModels: ['original-native-model'], supportedEfforts: ['low'], observedModel: true, observedEffort: true } };
  const context = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');
  const prepare = (acquire = () => probe) => context.preflight({ runtime: 'codex', worktree: root,
    scriptDir: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts'), env: options.env,
    graphDir: null, launchOptions: options, probe: acquire });
  return { root, executable, options, probe, context, prepare };
}

test('only the original private successful observation can be consumed once across option handoffs', () => {
  const f = launchFixture();
  try {
    const report = f.prepare();
    assert.equal(report.ok, true);
    const first = f.context.handoffLaunchPreparation(report, { ...f.options });
    const alias = f.context.handoffLaunchPreparation(first, { ...f.options });
    let acquired = 0;
    const fresh = () => { acquired++; return f.probe; };
    assert.deepEqual(f.context.acquireRuntimeProbe(first, 'codex', fresh), f.probe);
    assert.equal(acquired, 0);
    f.context.acquireRuntimeProbe(alias, 'codex', fresh);
    assert.equal(acquired, 1);
    const next = f.prepare();
    const forged = f.context.handoffLaunchPreparation(JSON.parse(JSON.stringify(next)),
      { ...f.options, preparation: next, validated: true, reuse: true });
    f.context.acquireRuntimeProbe(forged, 'codex', fresh);
    assert.equal(acquired, 2);
    assert.equal(JSON.stringify(next).includes('original-native-version'), false);
    assert.equal(JSON.stringify(first).includes('original-native-model'), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('private preparation snapshots original native evidence and refreshes if an observation is absent or malformed', () => {
  const f = launchFixture();
  try {
    const report = f.prepare();
    const options = f.context.handoffLaunchPreparation(report, { ...f.options });
    f.probe.runtime_version = 'caller-mutated-version';
    f.probe.capabilities.supportedModels[0] = 'caller-mutated-model';
    const original = f.context.acquireRuntimeProbe(options, 'codex', () => assert.fail('unchanged launch must reuse'));
    assert.equal(original.runtime_version, 'original-native-version');
    assert.deepEqual(original.capabilities.supportedModels, ['original-native-model']);
    for (const observation of [undefined, null, {}, { status: 'available' }, { status: 'unavailable' }]) {
      const result = f.prepare(() => observation);
      if (observation?.status !== 'available') { assert.equal(result.ok, false); continue; }
      let acquired = 0;
      const target = f.context.handoffLaunchPreparation(result, { ...f.options });
      f.context.acquireRuntimeProbe(target, 'codex', () => { acquired++; return f.probe; });
      assert.equal(acquired, 1);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('governing mutations during the physical probe cannot mint reuse authority', () => {
  const f = launchFixture();
  try {
    const report = f.prepare(() => {
      fs.appendFileSync(f.executable, '# changed while probing\n');
      return f.probe;
    });
    assert.equal(report.ok, true);
    const target = f.context.handoffLaunchPreparation(report, { ...f.options });
    let acquired = 0;
    f.context.acquireRuntimeProbe(target, 'codex', () => { acquired++; return f.probe; });
    assert.equal(acquired, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('credential environment changes invalidate private identity without serializing credential contents', () => {
  const f = launchFixture();
  try {
    f.options.env.OPENAI_API_KEY = 'fixture-secret-before';
    const report = f.prepare();
    const target = f.context.handoffLaunchPreparation(report,
      { ...f.options, env: { ...f.options.env, OPENAI_API_KEY: 'fixture-secret-after' } });
    let acquired = 0;
    f.context.acquireRuntimeProbe(target, 'codex', () => { acquired++; return f.probe; });
    assert.equal(acquired, 1);
    assert.equal(JSON.stringify(report).includes('fixture-secret'), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('unavailable instruction identity and a foreign worktree force fresh preparation', () => {
  const f = launchFixture();
  const other = project(undefined);
  try {
    for (const mutation of ['unreadable', 'worktree']) {
      const report = f.prepare();
      const target = f.context.handoffLaunchPreparation(report, { ...f.options });
      if (mutation === 'worktree') target.scope = { worktree: other };
      else fs.symlinkSync(path.join(f.root, 'missing-instructions'), path.join(f.root, 'AGENTS.md'));
      let acquired = 0;
      f.context.acquireRuntimeProbe(target, 'codex', () => { acquired++; return f.probe; });
      assert.equal(acquired, 1);
      if (mutation === 'unreadable') fs.unlinkSync(path.join(f.root, 'AGENTS.md'));
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
