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
const CURRENT_ROOT = '/Users/serhii/.local/state/shipyard/phase49-selected-package-6325fd1c268d';
const CURRENT_SHA = '92270f73cc794f9e3d121767c186330e4d50f8fa44a91750da8f50a3a438be36';
const CURRENT_HEAD = '6325fd1c268d82eb62c8a9c5749d4eb7a2ce50b6';
const CURRENT_TREE = '0636ae50a23ae4e5d606b9429c8895c9206bd913';
const COMPLETE_OWNED = [...OWNED, ...['gate-trailer', 'sentinel', 'state-sync']
  .map(name => 'host/plugins/delivery-pipeline/scripts/' + name + '.cjs'),
  'host/plugins/delivery-pipeline/commands/deliver.md',
  'host/plugins/delivery-pipeline/references/integrator.md', '.codex-plugin/plugin.json', 'package-build.json'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');


const CANONICAL_ROOTS = ['scripts', 'plugins/delivery-pipeline', 'capabilities/delivery-pipeline'];
function canonicalInputs(repository) {
  const rows = CANONICAL_ROOTS.flatMap(directory => inventory(path.join(repository, directory))
    .map(row => ({ path: directory + '/' + row.path, sha256: row.sha256, mode: row.mode })));
  assert(rows.length > 0 && rows.length <= 1000, 'canonical input inventory exceeds bound');
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
function equalInputs(selected, actual) {
  const ordered = rows => rows.map(({ path, sha256, mode }) => ({ path, sha256, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(new Set(actual.map(row => row.path)).size, actual.length, 'duplicate canonical input');
  assert.deepEqual(ordered(actual), ordered(selected), 'complete canonical inputs changed');
}
function admitSuccessor(selection, successor, authenticate) {
  assert.equal(typeof authenticate, 'function', 'protected successor verifier missing');
  const authority = authenticate(successor);
  assert(authority && authority.authenticated === true, 'successor authority missing or forged');
  assert.deepEqual(authority.subject, successor.subject, 'successor subject mismatch');
  assert.deepEqual(authority.original_source, selection.source, 'historical source authority mismatch');
  assert.equal(authority.selection_sha256, successor.selection_sha256, 'foreign selection authority');
  assert.equal(successor.selection_sha256, CURRENT_SHA, 'old selected candidate substitution');
  assert.equal(selection.build_calls, 1);
  assert.equal(selection.source.head, CURRENT_HEAD);
  assert.equal(selection.source.tree, CURRENT_TREE);
  assert.notEqual(successor.subject.head, selection.source.head);
  for (const field of ['head', 'tree', 'base']) assert(successor.subject[field], 'missing current subject');
  assert(Array.isArray(authority.changed_paths) && authority.changed_paths.length > 0);
  assert(authority.changed_paths.every(relative => relative.startsWith('tests/') && !relative.includes('..')),
    'successor contains non-fixture changes');
  equalInputs(selection.inputs, authority.inputs);
  assert.equal(authority.builder_sha256, selection.builder_sha256, 'builder changed');
  assert.deepEqual(authority.current_pins, authority.original_pins, 'kernel/runtime/consumer pins changed');
  for (const field of ['kernel', 'runtime_policy', 'consumers'])
    assert(authority.original_pins[field] && Object.keys(authority.original_pins[field]).length,
      'missing original launch pins: ' + field);
  assert.equal(authority.native.original_stream_sha256, authority.native.recorder_stream_sha256);
  assert.match(authority.native.original_stream_sha256, /^[a-f0-9]{64}$/);
  assert.equal(authority.native.finalized, true);
  assert.equal(authority.native.signed_source, true);
  assert.equal(authority.native.landed, true);
  assert.equal(authority.native.protected_commands, 8);
  const ci = authority.ci;
  assert.equal(ci.headSha, successor.subject.head, 'stale CI');
  assert.equal(ci.status, 'completed');
  assert.equal(ci.conclusion, 'success');
  assert.equal(ci.complete_log, true, 'complete CI log missing');
  const job = ci.jobs.find(row => row.name === 'test-fast');
  assert(job && job.status === 'completed' && job.conclusion === 'success');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success', 'incomplete CI step: ' + name);
  }
  return { reused: true, new_build_calls: 0, original_source: selection.source,
    current_subject: successor.subject, installed_acceptance: false, empirical_acceptance: false };
}

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
  equalInputs(selection.inputs, canonicalInputs(repository));
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
  for (const relative of COMPLETE_OWNED.filter(relative => relative.startsWith('host/'))) {
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
  assert.equal(actual.length, 161, 'incomplete selected package');
  const published = inventory(path.join(repository, 'plugins/shipyard'));
  assert.deepEqual(published, selection.outputs.map(row => ({ path: row.path, sha256: row.sha256,
    bytes: row.bytes, mode: row.publication_mode })), 'incomplete or mixed publication');
  const acceptance = require('../smoke/phase47-runtime-acceptance.cjs');
  const identity = acceptance.comparePackage(path.join(repository, 'plugins/shipyard'), {
    outputs: selection.outputs, source_content_sha256: contentDigest,
    package_sha256: metadata.digest, version: metadata.version });
  assert.equal(identity.output_count, 161);
  return { outputs: actual.length, scoped_outputs: COMPLETE_OWNED.length, complete_publication: true, inspector_build_calls: 0 };
}
function inspectRuntimeConsumers(repository) {
  for (const [runtime, method, fixture, identityType, identityField] of [
    ['codex', 'parseCodexStream', 'codex-agent-stream-exec.jsonl', 'thread.started', 'thread_id'],
    ['claude', 'parseClaudeStream', 'claude-stream-executor.jsonl', 'system', 'session_id'],
  ]) {
    const relative = 'plugins/delivery-pipeline/scripts/' + runtime + '-runtime-host.cjs';
    const canonical = require(path.join(repository, relative));
    const packaged = require(path.join(repository, 'plugins/shipyard/host', relative));
    const records = read(path.join(ROOT, 'tests/fixtures/captured', fixture)).toString('utf8')
      .split('\n').filter(line => line.trim()).map(JSON.parse).filter(record => !record.shipyard_fixture);
    const original = records.find(record => record.type === identityType && record[identityField]);
    assert(original, 'registered runtime identity record missing');
    const identity = structuredClone(original);
    identity[identityField] = 'foreign';
    assert.notEqual(identity[identityField], original[identityField]);
    const stream = records.map(record => JSON.stringify(record)).join('\n');
    assert.deepEqual(packaged[method](stream), canonical[method](stream));
    for (const consumer of [canonical, packaged])
      assert.throws(() => consumer[method](stream + '\n' + JSON.stringify(identity)),
        error => error.code === 'RUNTIME_EVIDENCE_INVALID');
  }
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
function authenticatePublicSelection(root = STAGE_ROOT, digest = SELECTION_SHA, keyName = 'publisher-public-key.asc') {
  const selectionPath = path.join(root, 'selection.json');
  assert.equal(physical(root, true).mode & 0o7777, 0o700, 'private root mode drift');
  const bytes = read(selectionPath, digest);
  const key = path.join(root, keyName);
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

test('phase49 original signed host selection: historical immutable stage remains separate', t => {
  try { fs.accessSync(path.join(STAGE_ROOT, 'selection.json')); }
  catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    t.skip('HOLD: original private host selection unavailable; no native or installed acceptance');
    return;
  }
  const bytes = authenticatePublicSelection();
  const selection = JSON.parse(bytes);
  assert.equal(selection.source.head, HEAD);
  assert.equal(selection.source.tree, TREE);
  assert.equal(selection.build_calls, 1);
  const originalInventory = withoutWrites(() => inventory(path.join(STAGE_ROOT, 'candidate'), '', true));
  assert.equal(originalInventory.length, 161);
  assert.deepEqual(originalInventory, selection.outputs.map(row => ({ path: row.path, sha256: row.sha256,
    bytes: row.bytes, mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })));
  assert.deepEqual(read(path.join(STAGE_ROOT, 'selection.json'), SELECTION_SHA), bytes);
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

test('phase49 repaired signed selection: complete161 publication and supported package identity', t => {
  try { fs.accessSync(path.join(CURRENT_ROOT, 'selection.json')); }
  catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    t.skip('HOLD: original private host selection unavailable; no native or installed acceptance');
    return;
  }
  const bytes = authenticatePublicSelection(CURRENT_ROOT, CURRENT_SHA, 'public-key.asc');

  const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
  const namespace = coverage.repoSlug(ROOT);
  const history = [CURRENT_HEAD, 'bd2d58b2e3f55d441d0ff3cbd26fba34849e7ea5',
    '705fdec2f96c90c28c787f49974a66da959638a5', '24c139fabd0d80bbd413ea20175fb3f28e60cd97'];
  const records = history.map(commit => {
    const verified = coverage.verify({ commit, repo: namespace, worktree: ROOT });
    assert.equal(verified.covered, true, 'protected historical source authority: ' + verified.reason);
    return verified.record;
  });
  const gitCurrent = (...args) => execFileSync('git', ['-C', ROOT, ...args],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  const successorHead = history[3], successorTree = records[3].tree;
  assert.equal(records[1].tree, successorTree);
  assert.equal(records[2].tree, successorTree);
  assert.equal(gitCurrent('rev-parse', '91611a76d3ff5cb380775cbca4873fb848b7a874^{tree}'), successorTree);
  gitCurrent('merge-base', '--is-ancestor', successorHead, 'HEAD');
  const changed = gitCurrent('diff', '--name-only', '--no-renames', CURRENT_HEAD, successorHead)
    .split('\n').filter(Boolean);
  assert.deepEqual(changed, ['tests/unit/role-artifact.test.cjs']);
  const selected = JSON.parse(bytes);
  equalInputs(selected.inputs, canonicalInputs(ROOT));
  const selectedOriginal = JSON.parse(read(selected.source.original_result, selected.source.original_result_sha256));
  const successorStored = coverage.validateFinalizationEvidence(records[1]);
  const originalStored = coverage.validateFinalizationEvidence(records[0]);
  assert.deepEqual(originalStored.receipt, selectedOriginal.receipt, 'original recorder equality');
  assert.equal(successorStored.receipt.policy_hash, selectedOriginal.receipt.policy_hash, 'runtime policy changed');
  for (const receipt of [originalStored.receipt, successorStored.receipt]) {
    const stream = receipt.runtime_evidence.transcript;
    assert.equal(read(stream.path, stream.sha256).length, stream.bytes);
    assert.equal(receipt.compliance, 'verified');
  }
  const ci = JSON.parse(read('/Users/serhii/.local/state/shipyard/T-49-08-current-epic-ci-admission.json',
    '7940bb8157246f0bd11c5cff959aee2b8e1530459dcd50cf4ef31b0d7ea76e2d'));
  assert.equal(ci.headSha, successorHead);
  assert.equal(ci.status, 'completed'); assert.equal(ci.conclusion, 'success');
  const job = ci.jobs.find(row => row.name === 'test-fast');
  assert(job && job.status === 'completed' && job.conclusion === 'success');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success');
  }
  const log = read('/Users/serhii/.local/state/shipyard/phase49-T49-08-current-epic-ci-success.log',
    '9bcf115e27bfe1050178354b96c325421eba82838ddc06d3e05bac3637f1c97f');
  assert.match(log.toString(), /claude statusline smoke passed/);
  assert.match(log.toString(), /test-fast\tComplete job\t/);
  const marker = JSON.parse(read('/Users/serhii/.local/state/shipyard/phase49-T49-09-input-inventory-repair-copies.json'));
  assert.equal(marker.selection_sha256, CURRENT_SHA);
  assert.equal(marker.source_head, CURRENT_HEAD);
  assert.equal(marker.build_calls, 1);
  assert.equal(marker.complete_inventory, 161);
  assert.deepEqual(marker.published, COMPLETE_OWNED.map(relative => 'plugins/shipyard/' + relative));
  t.diagnostic('Historical source/native finalization and full canonical equality checked separately from original selection. CI/copy diagnostics remain coordinator-owned; no current semantic credit or installed acceptance.');

  const result = withoutWrites(() => inspect(bytes, { selection_sha256: CURRENT_SHA, head: CURRENT_HEAD,
    tree: CURRENT_TREE }, ROOT, path.join(CURRENT_ROOT, 'candidate')));
  assert.equal(result.complete_publication, true);
  assert.equal(result.scoped_outputs, 15);
  inspectRuntimeConsumers(ROOT);
  const selection = JSON.parse(bytes);
  const historical = JSON.parse(read(path.join(STAGE_ROOT, 'selection.json'), SELECTION_SHA));
  assert.deepEqual(selection.outputs.map(row => row.path), historical.outputs.map(row => row.path),
    'repaired candidate changed original complete package path set');
  assert.notEqual(selection.package.digest, historical.package.digest, 'old candidate substituted');
  assert.equal(selection.source.head, CURRENT_HEAD);
  assert.equal(selection.source.tree, CURRENT_TREE);
  assert.equal(selection.build_calls, 1);
  const originalInventory = withoutWrites(() => inventory(path.join(CURRENT_ROOT, 'candidate'), '', true));
  assert.equal(originalInventory.length, 161);
  assert.deepEqual(originalInventory, selection.outputs.map(row => ({ path: row.path, sha256: row.sha256,
    bytes: row.bytes, mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })));
  assert.deepEqual(read(path.join(CURRENT_ROOT, 'selection.json'), CURRENT_SHA), bytes);
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(git('rev-parse', CURRENT_HEAD + '^{tree}'), CURRENT_TREE);
  git('merge-base', '--is-ancestor', CURRENT_HEAD, 'HEAD');
  for (const input of selection.inputs) {
    const committed = execFileSync('git', ['-C', ROOT, 'show', CURRENT_HEAD + ':' + input.path], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(sha(committed), input.sha256, 'original producer source drift');
    const mode = git('ls-tree', CURRENT_HEAD, '--', input.path).split(' ')[0];
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
    const fixtureInputs = canonicalInputs(ROOT).map(row => row.path);
    for (const relative of fixtureInputs) {
      const source = path.join(ROOT, relative), target = path.join(repository, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
      fs.chmodSync(target, physical(source).mode & 0o777);
      inputs.push({ path: relative, sha256: sha(read(source)), mode: physical(source).mode & 0o777 });
    }
    const outputs = inventory(stage).map(row => ({ path: row.path, sha256: row.sha256, bytes: row.bytes, publication_mode: row.mode }));
    for (const relative of outputs.map(row => row.path)) {
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

    const originalSource = { ...selection.source, head: CURRENT_HEAD, tree: CURRENT_TREE };
    const reuseSelection = { ...selection, source: originalSource };
    const successor = { selection_sha256: CURRENT_SHA,
      subject: { head: 'fixture-successor', tree: 'fixture-successor-tree', base: 'fixture-base' } };
    const pins = { kernel: { digest: sha(Buffer.from('isolated kernel')) },
      runtime_policy: { digest: sha(Buffer.from('isolated policy')) }, consumers: { digest: sha(bytes) } };
    const proof = { authenticated: true, subject: successor.subject, original_source: originalSource,
      selection_sha256: CURRENT_SHA, changed_paths: ['tests/unit/role-artifact.test.cjs'],
      inputs: canonicalInputs(repository), builder_sha256: selection.builder_sha256,
      original_pins: structuredClone(pins), current_pins: structuredClone(pins),
      native: { original_stream_sha256: sha(bytes), recorder_stream_sha256: sha(bytes),
        finalized: true, signed_source: true, landed: true, protected_commands: 8 },
      ci: { headSha: successor.subject.head, status: 'completed', conclusion: 'success', complete_log: true,
        jobs: [{ name: 'test-fast', status: 'completed', conclusion: 'success',
          steps: ['publish gate', 'runtime digest trailer', 'make test-fast'].map(name =>
            ({ name, status: 'completed', conclusion: 'success' })) }] } };
    const admit = value => {
      const envelope = Buffer.from(JSON.stringify(value));
      const signature = crypto.sign(null, envelope, privateKey);
      return withoutWrites(() => admitSuccessor(reuseSelection, successor, current => {
        assert.deepEqual(current, successor);
        assert(crypto.verify(null, envelope, publicKey, signature));
        return JSON.parse(envelope);
      }));
    };
    const accepted = admit(proof);
    assert.equal(accepted.new_build_calls, 0);
    assert.equal(accepted.original_source.head, CURRENT_HEAD);
    assert.equal(accepted.current_subject.head, successor.subject.head);
    assert.equal(accepted.empirical_acceptance, false);
    assert.throws(() => admitSuccessor(reuseSelection, successor));
    assert.throws(() => admitSuccessor(reuseSelection, successor, () => null));
    assert.throws(() => admitSuccessor(reuseSelection, successor, () => ({ ...proof, authenticated: false })));
    for (const mutate of [
      value => { value.inputs.pop(); },
      value => { value.inputs.push({ path: 'plugins/delivery-pipeline/added', sha256: sha(bytes), mode: 0o644 }); },
      value => { value.inputs[0].sha256 = '0'.repeat(64); },
      value => { value.inputs[0].mode ^= 0o100; },
      value => { value.builder_sha256 = '0'.repeat(64); },
      value => { value.current_pins.kernel.digest = '0'.repeat(64); },
      value => { value.current_pins.runtime_policy.digest = '0'.repeat(64); },
      value => { value.current_pins.consumers.digest = '0'.repeat(64); },
      value => { delete value.original_pins.kernel; },
      value => { value.changed_paths = ['scripts/package-shipyard-codex.cjs']; },
      value => { value.subject.head = 'stale'; },
      value => { value.selection_sha256 = SELECTION_SHA; },
      value => { value.original_source.head = HEAD; },
      value => { value.native.recorder_stream_sha256 = '0'.repeat(64); },
      value => { value.native.finalized = false; },
      value => { value.native.signed_source = false; },
      value => { value.native.landed = false; },
      value => { value.native.protected_commands = 7; },
      value => { value.ci.headSha = 'stale'; },
      value => { value.ci.status = 'in_progress'; },
      value => { value.ci.conclusion = 'failure'; },
      value => { value.ci.complete_log = false; },
      value => { value.ci.jobs[0].steps[2].conclusion = 'skipped'; },
    ]) {
      const altered = structuredClone(proof);
      mutate(altered);
      assert.throws(() => admit(altered));
    }
    const forged = Buffer.from(JSON.stringify({ ...proof, subject: { ...proof.subject, head: 'foreign' } }));
    assert(!crypto.verify(null, forged, publicKey, crypto.sign(null, Buffer.from(JSON.stringify(proof)), privateKey)));
    for (const directory of CANONICAL_ROOTS) {
      const addedInput = path.join(repository, directory, 'added.cjs');
      fs.writeFileSync(addedInput, 'changed canonical input'); assert.throws(consume); fs.unlinkSync(addedInput);
      const removedInput = path.join(repository, selection.inputs.find(row => row.path.startsWith(directory + '/')).path);
      const original = read(removedInput), originalMode = physical(removedInput).mode & 0o7777;
      fs.renameSync(removedInput, removedInput + '.bak'); assert.throws(consume);
      fs.renameSync(removedInput + '.bak', removedInput);
      fs.writeFileSync(removedInput, 'changed canonical bytes'); assert.throws(consume);
      fs.writeFileSync(removedInput, original);
      fs.chmodSync(removedInput, originalMode ^ 0o100); assert.throws(consume);
      fs.chmodSync(removedInput, originalMode);
      fs.renameSync(removedInput, removedInput + '.original');
      fs.symlinkSync(removedInput + '.original', removedInput); assert.throws(consume);
      fs.unlinkSync(removedInput); fs.renameSync(removedInput + '.original', removedInput);
    }

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
    const packageRoot = path.join(repository, 'plugins/shipyard');
    for (const relative of ['package-build.json', '.codex-plugin/plugin.json',
      'host/plugins/delivery-pipeline/commands/deliver.md',
      'host/plugins/delivery-pipeline/references/integrator.md', 'skills/shipyard-route/SKILL.md']) {
      const file = path.join(packageRoot, relative), original = read(file);
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from('foreign')]));
      assert.throws(consume);
      fs.writeFileSync(file, original);
      fs.renameSync(file, file + '.missing'); assert.throws(consume);
      fs.renameSync(file + '.missing', file);
      const mode = physical(file).mode & 0o7777;
      fs.chmodSync(file, mode ^ 0o100); assert.throws(consume); fs.chmodSync(file, mode);
    }
    const extra = path.join(packageRoot, 'foreign');
    fs.writeFileSync(extra, 'foreign'); assert.throws(consume); fs.unlinkSync(extra);
    const publishedMember = path.join(packageRoot, COMPLETE_OWNED[8]);
    fs.renameSync(publishedMember, publishedMember + '.original');
    fs.symlinkSync(publishedMember + '.original', publishedMember); assert.throws(consume);
    fs.unlinkSync(publishedMember); fs.renameSync(publishedMember + '.original', publishedMember);
    assert.equal(consume().scoped_outputs, 15);
    assert.equal(consume().complete_publication, true);
    inspectRuntimeConsumers(repository);

    const originalStageInventory = inventory(stage, '', true);
    const changedCanonical = path.join(repository, 'plugins/delivery-pipeline/commands/deliver.md');
    fs.appendFileSync(changedCanonical, '\nfixture changed canonical input\n');
    assert.throws(consume);
    const distinct = path.join(temporary, 'distinct-changed-input-candidate');
    assert(!fs.existsSync(distinct));
    assert.notEqual(distinct, stage);
    const builderModule = { exports: {} };
    const fixtureRequire = require('node:module').createRequire(path.join(repository, 'scripts/package-shipyard-codex.cjs'));
    require('node:vm').runInNewContext(read(path.join(repository, 'scripts/package-shipyard-codex.cjs')).toString(),
      { require: fixtureRequire, module: builderModule, __dirname: path.join(repository, 'scripts'), Buffer });
    const beforeInputs = canonicalInputs(repository);
    let distinctBuildCalls = 0;
    builderModule.exports.build(distinct); distinctBuildCalls++;
    equalInputs(beforeInputs, canonicalInputs(repository));
    const distinctOutputs = inventory(distinct).map(row => ({ path: row.path, sha256: row.sha256,
      bytes: row.bytes, publication_mode: row.mode }));
    const distinctSelection = { ...selection, source: { head: 'fixture-changed-head', tree: 'fixture-changed-tree' },
      stage: distinct, build_calls: distinctBuildCalls, inputs: beforeInputs, outputs: distinctOutputs,
      package: JSON.parse(read(path.join(distinct, 'package-build.json'))) };
    assert.notEqual(distinctSelection.package.digest, selection.package.digest);
    assert.deepEqual(distinctOutputs.map(row => row.path), outputs.map(row => row.path));
    const distinctBytes = Buffer.from(JSON.stringify(distinctSelection));
    const distinctSignature = crypto.sign(null, distinctBytes, privateKey);
    assert(crypto.verify(null, distinctBytes, publicKey, distinctSignature));
    assert(!crypto.verify(null, distinctBytes, publicKey, signature));
    for (const row of distinctOutputs) {
      const target = path.join(repository, 'plugins/shipyard', row.path);
      fs.copyFileSync(path.join(distinct, row.path), target); fs.chmodSync(target, row.publication_mode);
      fs.chmodSync(path.join(distinct, row.path), row.publication_mode === 0o755 ? 0o500 : 0o400);
    }
    fixtureDirectoryModes(distinct, 0o500);
    try {
      const admitted = withoutWrites(() => inspect(distinctBytes, { selection_sha256: sha(distinctBytes),
        head: distinctSelection.source.head, tree: distinctSelection.source.tree }, repository, distinct));
      assert.equal(admitted.complete_publication, true);
      assert.equal(admitted.inspector_build_calls, 0);
      assert.equal(distinctBuildCalls, 1);
      assert.deepEqual(inventory(stage, '', true), originalStageInventory);
      assert.throws(() => inspect(distinctBytes, expected, repository, distinct));
    } finally { fixtureDirectoryModes(distinct, 0o700); }
  } finally {
    if (fs.existsSync(stage)) fixtureDirectoryModes(stage, 0o700);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

module.exports = { inspect, inventory, read, canonicalInputs, admitSuccessor, OWNED: COMPLETE_OWNED };
