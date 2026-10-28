'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { build } = require('../../scripts/package-shipyard-codex.cjs');
const generator = require('../../scripts/gen-codex-shipyard.cjs');
const { generateFixture, fixtureEnvironment, hash, ROOT, SOURCE } = require('../smoke/phase53-review-acceptance.cjs');
const PACKAGE = path.join(ROOT, 'plugins/shipyard');
const mirrors = ['commands/deliver.md', 'references/arch-review.md', 'references/code-review.md', 'references/integrator.md',
  ...['check-state', 'ci-wait', 'claude-delivery-host', 'claude-role-host', 'claude-runtime-host', 'code-review-core',
    'codex-arch-review-context', 'codex-code-review-context', 'codex-delivery-host', 'codex-runtime-host',
    'dispatch-boundary', 'phase-code-review', 'role-artifact', 'runtime-context', 'state-sync', 'wait-events']
    .map(name => 'scripts/' + name + '.cjs')];
const changedPayload = [...mirrors.map(file => 'host/plugins/delivery-pipeline/' + file),
  'host/scripts/ensure-gsd-plugin.cjs', '.codex-plugin/plugin.json', 'package-build.json'].sort();

function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = prefix + entry.name, file = path.join(root, relative), stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'package must contain physical payloads: ' + relative);
      if (entry.isDirectory()) return inventory(root, relative + '/');
      const bytes = fs.readFileSync(file);
      return [{ path: relative, sha256: hash(bytes), bytes: bytes.length, mode: stat.mode & 0o7777 }];
    });
}

function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-shipping-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function packageIdentity(root) {
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha256');
  for (const row of inventory(root)) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)) continue;
    digest.update(row.path + '\0').update(fs.readFileSync(path.join(root, row.path)));
  }
  const sourceDigest = digest.digest('hex');
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(SOURCE, '.claude-plugin/plugin.json')));
  const manifest = fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'));
  return { version: sourceManifest.version + '+codex.' + sourceDigest.slice(0, 16),
    digest: crypto.createHash('sha256').update(sourceDigest).update('\0').update(manifest).digest('hex') };
}

function validateSourceBound(fixture, trusted) {
  const manifest = generator.validateCodexBundle(fixture.out, fixture.options);
  assert.deepEqual(inventory(fixture.out), trusted, 'candidate cannot replace original source-generated instruction or payload pins');
  return manifest;
}

function runSmoke(arguments_, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 180000);
    const append = (channel, bytes) => {
      if (channel === 'stdout') stdout += bytes; else stderr += bytes;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 8 * 1024 * 1024) {
        clearTimeout(timer); child.kill('SIGTERM'); reject(new Error('smoke exceeded its existing output bound'));
      }
    };
    child.stdout.on('data', bytes => append('stdout', bytes));
    child.stderr.on('data', bytes => append('stderr', bytes));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer);
      if (timedOut) reject(new Error('smoke exceeded its existing 180-second bound: ' + stderr));
      else resolve({ status, stdout, stderr });
    });
  });
}

describe('phase53 shipping boundaries', { concurrency: 2 }, () => {
test('real temporary build matches complete shipped bytes, modes, version, digest and exact phase 53 output delta', t => {
  const candidate = path.join(temporary(t), 'candidate');
  build(candidate);
  assert.deepEqual(inventory(candidate), inventory(PACKAGE));
  const identity = packageIdentity(candidate);
  const record = JSON.parse(fs.readFileSync(path.join(candidate, 'package-build.json')));
  assert.equal(record.version, identity.version);
  assert.equal(record.digest, identity.digest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(candidate, '.codex-plugin/plugin.json'))).version, identity.version);
  assert.equal(changedPayload.length, 23);
  for (const file of mirrors) {
    const input = path.join(SOURCE, file), output = path.join(candidate, 'host/plugins/delivery-pipeline', file);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(input));
    assert.equal(fs.statSync(output).mode & 0o7777, fs.statSync(input).mode & 0o7777);
  }
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'host/scripts/ensure-gsd-plugin.cjs')),
    fs.readFileSync(path.join(ROOT, 'scripts/ensure-gsd-plugin.cjs')));
  const producer = path.join(temporary(t), 'producer');
  fs.mkdirSync(path.join(producer, 'scripts'), { recursive: true });
  for (const directory of ['scripts', 'plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
    fs.cpSync(path.join(ROOT, directory), path.join(producer, directory), { recursive: true });
  const builder = path.join(producer, 'scripts/package-shipyard-codex.cjs');
  const baseline = path.join(producer, 'baseline'), changed = path.join(producer, 'changed');
  const runBuilder = destination => {
    const result = spawnSync(process.execPath, [builder, destination], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  };
  runBuilder(baseline);
  for (const file of mirrors)
    fs.appendFileSync(path.join(producer, 'plugins/delivery-pipeline', file), '\n');
  fs.appendFileSync(path.join(producer, 'scripts/ensure-gsd-plugin.cjs'), '\n');
  runBuilder(changed);
  const before = new Map(inventory(baseline).map(row => [row.path, row]));
  const actual = inventory(changed);
  assert.deepEqual(actual.map(row => row.path), [...before.keys()]);
  assert.deepEqual(actual.filter(row => JSON.stringify(row) !== JSON.stringify(before.get(row.path)))
    .map(row => row.path).sort(), changedPayload);

});

for (const identity of ['source-fixture', 'staged-package-fixture'])
  test(identity + ': ordinary six-role acceptance, current gates, restart, stale pins and retired dispatch refusal', async t => {
    const directory = temporary(t);
    const plugin = identity === 'source-fixture' ? SOURCE
      : path.join(build(path.join(directory, 'candidate')), 'host/plugins/delivery-pipeline');
    const env = fixtureEnvironment(path.join(directory, 'home'));
    const result = await runSmoke([path.join(ROOT, 'tests/smoke/phase53-review-acceptance.cjs'), identity, plugin], env);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.identity, identity);
    assert.equal(observed.payload_root, fs.realpathSync(plugin));
    assert.deepEqual(observed.roles.map(row => row.runtime + '/' + row.role),
      ['codex', 'claude'].flatMap(runtime => ['integrator', 'arch-review', 'code-review'].map(role => runtime + '/' + role)));
    for (const role of observed.roles) {
      assert.ok(role.dispatch_id);
      assert.match(role.instruction.sha256, /^[a-f0-9]{64}$/);
      assert.match(role.snapshot_sha256, /^[a-f0-9]{64}$/);
      assert.ok(role.instruction.bytes > 0);
      for (const key of ['applied_model', 'applied_effort', 'observed_model', 'observed_effort', 'policy_hash'])
        assert.equal(typeof role.selection[key], 'string');
    }
    assert.equal(observed.installed_native_acceptance, false);
    assert.equal(observed.production_resource_fit, 'unknown');
    assert.equal(observed.rollout, false); assert.equal(observed.release, false);
  });

for (const identity of ['source-fixture', 'staged-package-fixture'])
  for (const group of ['historical', 'recovery', 'outcomes', 'ci', 'launch'])
    test(identity + ': original ' + group + ' contracts through delivered entrypoints', async t => {
      const directory = temporary(t);
      const plugin = identity === 'source-fixture' ? SOURCE
        : path.join(build(path.join(directory, 'candidate')), 'host/plugins/delivery-pipeline');
      const env = fixtureEnvironment(path.join(directory, 'home'));
      const result = await runSmoke(
        [path.join(ROOT, 'tests/smoke/phase53-review-acceptance.cjs'), identity, plugin, group], env);
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.group, group);
      assert.equal(observed.identity, identity);
      assert.equal(observed.payload_root, fs.realpathSync(plugin));
      assert.ok(observed.completed.length > 0);
      assert.equal(observed.installed_native_acceptance, false);
    });

for (const payload of ['source', 'package']) test(payload + ': genuine generated bundle binds current source and refuses substituted pins', t => {
  const directory = temporary(t);
  const plugin = payload === 'source' ? SOURCE
    : path.join(build(path.join(directory, 'package')), 'host/plugins/delivery-pipeline');
  const fixture = generateFixture(path.join(directory, 'generation'), plugin);
  const trusted = inventory(fixture.out);
  const manifestFile = path.join(fixture.out, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestFile);
  validateSourceBound(fixture, trusted);
  for (const file of ['scripts/codex-delivery-host.cjs', 'scripts/claude-role-host.cjs',
    'scripts/role-artifact.cjs', 'references/integrator.md', 'references/arch-review.md', 'references/code-review.md'])
    assert.deepEqual(fs.readFileSync(path.join(fixture.out, 'bundle', file)), fs.readFileSync(path.join(plugin, file)));
  for (const role of ['arch-review', 'code-review', 'integrator']) {
    const variant = generator.codexStaticVariants(2).find(item => item.role === role);
    const instructions = fs.readFileSync(path.join(fixture.out, 'agents', variant.file), 'utf8');
    const original = fs.readFileSync(path.join(plugin, 'references', variant.reference + '.md'), 'utf8');
    assert.ok(instructions.includes(generator.shipyardRewrites(original, fixture.manifest.scriptsRoot)));
  }
  const mutations = [
    ['bundle/scripts/codex-delivery-host.cjs', 'bundle_digests', 'scripts/codex-delivery-host.cjs'],
    ['bundle/scripts/claude-role-host.cjs', 'bundle_digests', 'scripts/claude-role-host.cjs'],
    ['bundle/references/integrator.md', 'bundle_digests', 'references/integrator.md'],
    ['agents/' + fixture.manifest.agent_files[0], 'agent_digests', fixture.manifest.agent_files[0]],
    ['bundle/scripts/model-policy.cjs', 'bundle_digests', 'scripts/model-policy.cjs'],
    ['bundle/codex-capabilities.json', 'bundle_digests', 'codex-capabilities.json'],
  ];
  for (const [relative, field, key] of mutations) {
    const file = path.join(fixture.out, relative), bytes = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, '\nsubstituted stale generation\n');
      assert.throws(() => generator.validateCodexBundle(fixture.out, fixture.options));
      const altered = JSON.parse(originalManifest);
      altered[field][key] = hash(fs.readFileSync(file));
      if (key === 'codex-capabilities.json') altered.capabilities_digest = hash(fs.readFileSync(file));
      fs.writeFileSync(manifestFile, JSON.stringify(altered) + '\n');
      assert.throws(() => validateSourceBound(fixture, trusted), 'editing a candidate digest cannot bless different source');
    } finally { fs.writeFileSync(file, bytes); fs.writeFileSync(manifestFile, originalManifest); }
    validateSourceBound(fixture, trusted);
  }
  for (const field of ['policy_hash', 'capabilities_digest', 'config_digest', 'gsd_lib_digest', 'codexHome']) {
    const altered = JSON.parse(originalManifest); altered[field] = 'foreign-generation';
    fs.writeFileSync(manifestFile, JSON.stringify(altered) + '\n');
    try { assert.throws(() => generator.validateCodexBundle(fixture.out, fixture.options)); }
    finally { fs.writeFileSync(manifestFile, originalManifest); }
  }
  const converter = fs.readFileSync(fixture.converter);
  try {
    fs.appendFileSync(fixture.converter, '\nchanged converter\n');
    assert.throws(() => generator.validateCodexBundle(fixture.out, fixture.options));
  } finally { fs.writeFileSync(fixture.converter, converter); }
  validateSourceBound(fixture, trusted);
});

test('delivery documentation names fixture provenance, original-stage recovery and current-head human review', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs/gsd_multilevel_delivery_pipeline.md'), 'utf8');
  for (const phrase of ['shipyard.semantic-review.v1', 'two semantic workers', 'full originals',
    'source-fixture', 'staged-package-fixture', 'original-stage recovery', 'APPROVED review on the current PR head'])
    assert.ok(guide.includes(phrase), 'missing operator contract: ' + phrase);
});

});
