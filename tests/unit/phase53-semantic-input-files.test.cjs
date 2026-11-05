'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const owner = path.join(__dirname, 'phase53-codex-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner;
loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
  };
  loaded._compile(fs.readFileSync(owner, 'utf8') + '\nmodule.exports = { publicIntegrationFixture, write, commit, semanticFixture, supportedPartitionCaller, currentPartitionConsumer, coldCurrent, contract, captureOriginals };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, write, commit, semanticFixture, supportedPartitionCaller,
  currentPartitionConsumer, coldCurrent, contract, captureOriginals } = loaded.exports;

test('ordinary integration reads repository-sized sources without an inline material budget', async () => {
  await publicIntegrationFixture(async f => {
    const content = Array.from({ length: 50000 }, (_, index) => 'exports.contract_' + index + ' = ' + index + ';').join('\n') + '\n';
    assert.ok(Buffer.byteLength(content) > 1291563);
    write(f.worktree, 'src/repository-scale.cjs', content);
    commit(f, 'fixture: source inventory matches the real review repository scale');
    const prepared = semanticFixture(f);
    delete prepared.options.storageRoot;
    const completed = await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(completed.result.outcome, 'passed');
    assert.equal(prepared.launches.length, 3);
    assert.ok(prepared.launches.every(launch => Buffer.byteLength(launch.input) <= 1048576));
    const source = prepared.launches.at(-1).payload.material.find(item => item.aliases.some(alias => alias.path === 'src/repository-scale.cjs'));
    assert.ok(source);
    assert.equal(fs.readFileSync(path.resolve(f.worktree, source.read_path), 'utf8'), content);
    assert.equal(currentPartitionConsumer(f)?.contract, contract);
    const wire = JSON.parse(prepared.launches.at(-1).input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\s*([\s\S]*?)\s*<\/AUTHENTICATED_SEMANTIC_REVIEW>/)[1]);
    for (const launch of prepared.launches) {
      assert.ok(launch.runtime_args.includes('permissions.shipyard-runtime.extends=":read-only"'));
      const profile = launch.runtime_args.find(argument => argument.startsWith('permissions.shipyard-runtime.filesystem='));
      assert.ok(profile);
      const denied = [...profile.matchAll(/("(?:[^"\\]|\\.)*")="deny"/g)].map(match => JSON.parse(match[1]));
      for (const asset of [...wire.material, ...wire.originals])
        assert.ok(!denied.some(directory => asset.read_path === directory || asset.read_path.startsWith(directory + path.sep)));
    }
    assert.ok(wire.material.every(item => !Object.hasOwn(item, 'content')));
    assert.ok(wire.originals.every(item => !Object.hasOwn(item, 'result') && !Object.hasOwn(item, 'original_text')));
    for (const asset of [wire.material.find(item => item.source_id === source.source_id), wire.originals[0]]) {
      const file = path.resolve(f.worktree, asset.read_path), original = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([original, Buffer.from('tampered')]));
        assert.equal(coldCurrent(f), null, 'changed public input bytes cannot grant current authority');
      } finally { fs.writeFileSync(file, original); }
      assert.equal(coldCurrent(f)?.contract, contract);
    }
  });
});

test('missing optional accounting stays unknown after authenticated complete native review', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f, { native(rows) {
      const index = rows.findIndex(row => row.payload?.type === 'token_count');
      if (index >= 0) rows.splice(index, 1);
    } });
    const completed = await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(completed.result.outcome, 'passed');
    for (const original of captureOriginals(f, prepared)) {
      assert.equal(original.native.accounting.status, 'unknown');
      assert.equal(original.native.resource_failure, null);
      assert.deepEqual(original.native.observation, []);
    }
    assert.equal(currentPartitionConsumer(f)?.contract, contract);
  });
});

test('host-protected role evidence never receives a model write grant', () => {
  const filename = require.resolve('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const runtime = new Module(filename, module);
  runtime.filename = filename;
  runtime.paths = Module._nodeModulePaths(path.dirname(filename));
  runtime._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { staticEvidenceWritePath, signerPermissionProfileArgs };', filename);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'semantic-permission-')));
  try {
    for (const role of ['arch-review', 'code-review']) {
      const evidence = path.join(directory, '.shipyard-' + role + '-evidence.md');
      const selection = { agent_file: 'shipyard-' + role + '.toml', agent_file_content: 'Installed role instructions.' };
      const grant = runtime.exports.staticEvidenceWritePath(directory, selection, 'read-only', [evidence]);
      const args = runtime.exports.signerPermissionProfileArgs([evidence], 'read-only', grant);
      const profile = args.find(value => value.startsWith('permissions.shipyard-runtime.filesystem='));
      assert.ok(profile.includes(JSON.stringify(evidence) + '="deny"'));
      assert.ok(!profile.includes(JSON.stringify(evidence) + '="write"'));
      assert.equal(runtime.exports.staticEvidenceWritePath(directory, selection, 'read-only'), evidence);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
