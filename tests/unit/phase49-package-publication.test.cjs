'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { build } = require('../../scripts/package-shipyard-codex.cjs');
const ROOT = path.resolve(__dirname, '../..');
const STAGE_ROOT = '/Users/serhii/.local/state/shipyard/phase49-selected-package-bd18893c6948';
const SELECTION_SHA = 'b09e4ab44ee00bd8600fb34774994a37e46dc2c98d1b311d163b881b939c65db';
const PUBLIC_SHA = 'a2831936134d378395058b84e81ae9411c4da03800933700f1d995ebd51f89c3';
const FINGERPRINT = '2F485C0A455BA33463F66332900FCE87BD1BFF0D';
const HEAD = 'bd18893c69484c47db9b6d1b0613b4bac962b237';
const TREE = '60dc53b466502e62a33d8e8d48233e8469e1c60c';
const OWNED = ['codex-arch-review-context', 'codex-runtime-host', 'codex-delivery-host',
  'context-packet', 'role-artifact', 'claude-role-host', 'phase-integrator-preflight', 'base-merge']
  .map(name => 'host/plugins/delivery-pipeline/scripts/' + name + '.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function physical(file, directory = false) {
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile(), 'nonphysical member: ' + file);
  assert.equal(fs.realpathSync(file), path.resolve(file), 'symlinked ancestor: ' + file);
  return stat;
}
function read(file, digest) {
  const before = physical(file);
  assert(before.size <= 32 * 1024 * 1024, 'input exceeds bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = physical(file);
    for (const stat of [opened, fs.fstatSync(fd), after])
      for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'])
        assert.equal(stat[key], before[key], 'input changed during inspection');
    assert.equal(bytes.length, before.size);
    if (digest !== undefined) assert.equal(sha(bytes), digest, 'digest mismatch: ' + file);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function inventory(root, prefix = '', immutable = false) {
  const directory = physical(root, true);
  if (immutable) assert.equal(directory.mode & 0o7777, 0o500, 'immutable directory mode drift');
  const rows = [];
  for (const name of fs.readdirSync(root).sort((a, b) => a.localeCompare(b))) {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) rows.push(...inventory(file, prefix + name + '/', immutable));
    else {
      const bytes = read(file);
      rows.push({ path: prefix + name, sha256: sha(bytes), bytes: bytes.length, mode: stat.mode & 0o7777 });
    }
    assert(rows.length <= 1000, 'inventory exceeds bound');
  }
  return rows;
}
function safeRelative(relative) {
  assert.equal(typeof relative, 'string');
  assert(relative && !relative.includes('\\') && !path.isAbsolute(relative));
  assert(relative.split('/').every(part => part && part !== '.' && part !== '..'));
}
function inspect(selectionBytes, expected, repository, stage) {
  assert.equal(sha(selectionBytes), expected.selection_sha256, 'selected bytes changed');
  const selection = JSON.parse(selectionBytes);
  assert.equal(selection.schema, 'shipyard.phase49.selected-package.v1');
  assert.equal(selection.stage, stage, 'foreign or rebuilt stage');
  assert.equal(selection.source.head, expected.head, 'stale source');
  assert.equal(selection.source.tree, expected.tree, 'foreign source tree');
  assert.equal(selection.build_calls, 1, 'second build cannot replace selection');
  assert.equal(selection.builder_sha256, sha(read(path.join(repository, 'scripts/package-shipyard-codex.cjs'))));
  assert(Array.isArray(selection.inputs) && selection.inputs.length > 0 && selection.inputs.length <= 1000);
  assert(Array.isArray(selection.outputs) && selection.outputs.length > 0 && selection.outputs.length <= 1000);
  for (const rows of [selection.inputs, selection.outputs]) {
    assert.equal(new Set(rows.map(row => row.path)).size, rows.length, 'duplicate inventory credit');
    for (const row of rows) safeRelative(row.path);
  }
  for (const directory of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline']) {
    const names = inventory(path.join(repository, directory)).map(row => directory + '/' + row.path)
      .filter(relative => !/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(relative));
    assert.deepEqual(names.sort(), selection.inputs.filter(row => row.path.startsWith(directory + '/'))
      .map(row => row.path).sort(), 'canonical inventory drift');
  }
  for (const row of selection.inputs) {
    read(path.join(repository, row.path), row.sha256);
    assert.equal(physical(path.join(repository, row.path)).mode & 0o7777, row.mode, 'source mode drift');
  }
  const actual = inventory(stage, '', true);
  assert.deepEqual(actual.map(row => ({ path: row.path, sha256: row.sha256, bytes: row.bytes })),
    selection.outputs.map(row => ({ path: row.path, sha256: row.sha256, bytes: row.bytes })), 'candidate inventory drift');
  for (const row of actual) {
    const selected = selection.outputs.find(output => output.path === row.path);
    assert([0o644, 0o755].includes(selected.publication_mode), 'unsupported publication mode');
    assert.equal(row.mode, selected.publication_mode === 0o755 ? 0o500 : 0o400, 'immutable candidate mode drift');
  }
  for (const relative of OWNED) {
    const output = selection.outputs.find(row => row.path === relative);
    assert(output, 'missing assigned output');
    const sourcePath = relative.slice('host/'.length);
    const input = selection.inputs.find(row => row.path === sourcePath);
    assert(input, 'missing canonical source');
    assert.equal(output.sha256, input.sha256, 'canonical/stage drift');
    assert.equal(output.publication_mode, input.mode);
    const mirror = path.join(repository, 'plugins/shipyard', relative);
    read(mirror, output.sha256);
    assert.equal(physical(mirror).mode & 0o7777, output.publication_mode, 'mirror mode drift');
  }
  const metadata = JSON.parse(read(path.join(stage, 'package-build.json')));
  assert.deepEqual(metadata, selection.package);
  const hash = crypto.createHash('sha256');
  for (const row of actual) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)) continue;
    hash.update(row.path + '\0'); hash.update(read(path.join(stage, row.path)));
  }
  const contentDigest = hash.digest('hex');
  const manifest = read(path.join(stage, '.codex-plugin/plugin.json'));
  assert.equal(JSON.parse(manifest).version, metadata.version);
  assert(metadata.version.endsWith('+codex.' + contentDigest.slice(0, 16)));
  assert.equal(metadata.digest, sha(Buffer.concat([Buffer.from(contentDigest + '\0'), manifest])));
  return { outputs: actual.length, scoped_outputs: OWNED.length, complete_publication: false, inspector_build_calls: 0 };
}
function fixtureDirectoryModes(root, mode) {
  fs.chmodSync(root, mode);
  for (const name of fs.readdirSync(root)) {
    const member = path.join(root, name);
    if (fs.lstatSync(member).isDirectory()) fixtureDirectoryModes(member, mode);
  }
}
function withoutWrites(callback) {
  const methods = ['writeFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'copyFileSync', 'cpSync',
    'chmodSync', 'unlinkSync', 'appendFileSync', 'symlinkSync'];
  const originals = methods.map(name => fs[name]);
  try {
    methods.forEach(name => { fs[name] = () => { throw new Error('inspection attempted write: ' + name); }; });
    return callback();
  } finally { methods.forEach((name, index) => { fs[name] = originals[index]; }); }
}
function authenticatePublicSelection() {
  const selectionPath = path.join(STAGE_ROOT, 'selection.json');
  const bytes = read(selectionPath, SELECTION_SHA);
  const key = path.join(STAGE_ROOT, 'publisher-public-key.asc');
  read(key, PUBLIC_SHA);
  read(selectionPath + '.asc');
  const temporary = temporaryDirectory('phase49-public-signature-');
  try {
    const keyring = path.join(temporary, 'publisher.gpg');
    execFileSync('gpg', ['--batch', '--no-options', '--homedir', temporary, '--dearmor', '--output', keyring, key], { timeout: 10000, stdio: 'pipe' });
    const status = execFileSync('gpgv', ['--homedir', temporary, '--keyring', keyring, '--status-fd', '1', selectionPath + '.asc', selectionPath], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
    const signatures = status.split('\n').filter(line => line.startsWith('[GNUPG:] VALIDSIG '));
    assert.equal(signatures.length, 1);
    assert.equal(signatures[0].split(' ')[2], FINGERPRINT);
    return bytes;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('phase49 original signed host selection: read-only complete stage and eight scoped mirrors', t => {
  try { fs.accessSync(path.join(STAGE_ROOT, 'selection.json')); }
  catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    t.skip('HOLD: original private host selection unavailable; no native or installed acceptance');
    return;
  }
  const bytes = authenticatePublicSelection();
  const result = withoutWrites(() => inspect(bytes, { selection_sha256: SELECTION_SHA, head: HEAD, tree: TREE }, ROOT, path.join(STAGE_ROOT, 'candidate')));
  assert.equal(result.outputs, 161);
  assert.equal(result.scoped_outputs, 8);
  assert.equal(result.complete_publication, false);
  assert.deepEqual(read(path.join(STAGE_ROOT, 'selection.json'), SELECTION_SHA), bytes, 'selection moved during inspection');
  const selection = JSON.parse(bytes);
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(git('rev-parse', HEAD + '^{tree}'), TREE);
  git('merge-base', '--is-ancestor', HEAD, 'HEAD');
  for (const input of selection.inputs) {
    const committed = execFileSync('git', ['-C', ROOT, 'show', HEAD + ':' + input.path], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(sha(committed), input.sha256, 'original producer source drift');
    const mode = git('ls-tree', HEAD, '--', input.path).split(' ')[0];
    assert.equal(mode, input.mode === 0o755 ? '100755' : '100644');
  }
  const original = JSON.parse(read(selection.source.original_result, selection.source.original_result_sha256));
  assert.equal(original.dispatch_id, selection.source.original_dispatch);
  assert.equal(original.ticket, 'T-49-08');
  assert.equal(original.receipt.dispatch_id, original.dispatch_id);
  const transcript = original.receipt.runtime_evidence.transcript;
  assert.equal(read(transcript.path, transcript.sha256).length, transcript.bytes);
  t.diagnostic('Signed source attestation and original stream integrity inspected; private DurableRecorder/sealed-artifact authentication remains trusted-host custody. No semantic/native/installed/10x acceptance.');
});

test('isolated canonical candidate rejects tampering, stale binding and replacement without writes', () => {
  const temporary = temporaryDirectory('phase49-publication-fixture-');
  const stage = path.join(temporary, 'candidate'), repository = path.join(temporary, 'repository');
  try {
    build(stage);
    fs.mkdirSync(repository);
    const inputs = [];
    const fixtureInputs = ['scripts/package-shipyard-codex.cjs'];
    for (const directory of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
      fixtureInputs.push(...inventory(path.join(ROOT, directory)).map(row => directory + '/' + row.path)
        .filter(relative => !/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(relative)));
    for (const relative of fixtureInputs) {
      const source = path.join(ROOT, relative), target = path.join(repository, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
      fs.chmodSync(target, physical(source).mode & 0o777);
      inputs.push({ path: relative, sha256: sha(read(source)), mode: physical(source).mode & 0o777 });
    }
    const outputs = inventory(stage).map(row => ({ path: row.path, sha256: row.sha256, bytes: row.bytes, publication_mode: row.mode }));
    for (const relative of OWNED) {
      const target = path.join(repository, 'plugins/shipyard', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(stage, relative), target);
      fs.chmodSync(target, outputs.find(row => row.path === relative).publication_mode);
    }
    const selection = { schema: 'shipyard.phase49.selected-package.v1', source: { head: 'fixture-head', tree: 'fixture-tree' },
      stage, build_calls: 1, builder_sha256: sha(read(path.join(ROOT, 'scripts/package-shipyard-codex.cjs'))), inputs, outputs,
      package: JSON.parse(read(path.join(stage, 'package-build.json'))) };
    const bytes = Buffer.from(JSON.stringify(selection));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const signature = crypto.sign(null, bytes, privateKey);
    assert(crypto.verify(null, bytes, publicKey, signature));
    const foreignKey = crypto.generateKeyPairSync('ed25519').publicKey;
    assert(!crypto.verify(null, bytes, foreignKey, signature));
    assert(!crypto.verify(null, Buffer.concat([bytes, Buffer.from(' ')]), publicKey, signature));
    const expected = { selection_sha256: sha(bytes), head: 'fixture-head', tree: 'fixture-tree' };
    for (const row of outputs) fs.chmodSync(path.join(stage, row.path), row.publication_mode === 0o755 ? 0o500 : 0o400);
    fixtureDirectoryModes(stage, 0o500);
    const consume = () => withoutWrites(() => inspect(bytes, expected, repository, stage));
    assert.equal(consume().inspector_build_calls, 0);
    for (const patch of [{ head: 'stale' }, { tree: 'foreign' }, { selection_sha256: '0'.repeat(64) }])
      assert.throws(() => inspect(bytes, { ...expected, ...patch }, repository, stage));
    const secondStage = path.join(temporary, 'second-build');
    build(secondStage);
    assert.throws(() => inspect(bytes, expected, repository, secondStage));
    for (const patch of [{ build_calls: 2 }, { outputs: outputs.slice(1) }, { stage: '../candidate' }]) {
      const altered = Buffer.from(JSON.stringify({ ...selection, ...patch }));
      assert(!crypto.verify(null, altered, publicKey, signature));
      assert.throws(() => inspect(altered, { ...expected, selection_sha256: sha(altered) }, repository, stage));
    }
    const member = path.join(stage, OWNED[7]), originalBytes = read(member), mode = physical(member).mode & 0o777;
    fs.chmodSync(member, 0o600); fs.writeFileSync(member, 'tampered'); fs.chmodSync(member, mode);
    assert.throws(consume);
    fs.chmodSync(member, 0o600); fs.writeFileSync(member, originalBytes); fs.chmodSync(member, mode);
    for (const changedMode of [mode | 0o200, mode | 0o040, mode | 0o004, mode | 0o010, mode | 0o001, mode & ~0o100, mode | 0o4000]) {
      fs.chmodSync(member, changedMode); assert.throws(consume); fs.chmodSync(member, mode);
    }
    const nonExecutable = outputs.find(row => row.publication_mode === 0o644);
    assert(nonExecutable);
    const plainMember = path.join(stage, nonExecutable.path);
    fs.chmodSync(plainMember, 0o500); assert.throws(consume); fs.chmodSync(plainMember, 0o400);
    for (const changedMode of [0o700, 0o550, 0o505, 0o400]) {
      fs.chmodSync(stage, changedMode); assert.throws(consume); fs.chmodSync(stage, 0o500);
    }
    const alias = path.join(temporary, 'candidate-alias');
    fs.symlinkSync(stage, alias);
    assert.throws(() => inventory(alias, '', true));
    fs.unlinkSync(alias);
    const mirror = path.join(repository, 'plugins/shipyard', OWNED[7]);
    fs.chmodSync(mirror, 0o644); assert.throws(consume); fs.chmodSync(mirror, 0o755);
    const canonical = path.join(repository, OWNED[0].slice(5));
    const canonicalMode = physical(canonical).mode & 0o777;
    fs.chmodSync(canonical, canonicalMode ^ 0o100); assert.throws(consume); fs.chmodSync(canonical, canonicalMode);
    const canonicalBytes = read(canonical); fs.writeFileSync(canonical, 'foreign source'); assert.throws(consume);
    fs.writeFileSync(canonical, canonicalBytes);
    fixtureDirectoryModes(stage, 0o700);
    fs.renameSync(member, member + '.missing');
    fixtureDirectoryModes(stage, 0o500); assert.throws(consume);
    fixtureDirectoryModes(stage, 0o700); fs.renameSync(member + '.missing', member);
    fs.renameSync(member, member + '.original'); fs.symlinkSync(member + '.original', member);
    fixtureDirectoryModes(stage, 0o500); assert.throws(consume);
    fixtureDirectoryModes(stage, 0o700);
    fs.unlinkSync(member); fs.renameSync(member + '.original', member);
    fixtureDirectoryModes(stage, 0o500);
    assert.equal(consume().scoped_outputs, 8);
  } finally {
    if (fs.existsSync(stage)) fixtureDirectoryModes(stage, 0o700);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

module.exports = { inspect, inventory, read, OWNED };
