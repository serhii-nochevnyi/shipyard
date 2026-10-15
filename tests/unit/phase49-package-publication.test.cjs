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
const ACCOUNTING_ROOT = '/Users/serhii/.local/state/shipyard/phase49-selected-package-22f0064d2123';
const ACCOUNTING_SHA = '998663f1d220924f4ca57ed8407200baebac7f0d8ebd1b4c7e14244f73c3f265';
const ACCOUNTING_HEAD = '22f0064d2123f7ab72362396bb9ea1800c5b3655';
const ACCOUNTING_TREE = 'ad0dce6d886e608409d77ae9c735025ea3f0444b';
const ACCOUNTING_OWNED = ['host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs',
  'host/plugins/delivery-pipeline/scripts/role-artifact.cjs', '.codex-plugin/plugin.json', 'package-build.json'];
const COMPLETE_OWNED = [...OWNED, ...['gate-trailer', 'sentinel', 'state-sync']
  .map(name => 'host/plugins/delivery-pipeline/scripts/' + name + '.cjs'),
  'host/plugins/delivery-pipeline/commands/deliver.md',
  'host/plugins/delivery-pipeline/references/integrator.md', '.codex-plugin/plugin.json', 'package-build.json'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');


test('ordinary-complete-candidate-package-parity', () => {
  const temporary = temporaryDirectory('ordinary-package-parity-');
  try {
    const expectedRoot = build(path.join(temporary, 'expected'));
    const expected = inventory(expectedRoot);
    assert.deepEqual(inventory(path.join(ROOT, 'plugins/shipyard')), expected,
      'complete candidate differs from unchanged builder output');
    const copy = path.join(temporary, 'mutation');
    for (const mutate of [
      root => fs.appendFileSync(path.join(root, 'host/plugins/delivery-pipeline/scripts/sentinel.cjs'), '\nstale'),
      root => fs.appendFileSync(path.join(root, '.codex-plugin/plugin.json'), ' '),
      root => fs.appendFileSync(path.join(root, 'package-build.json'), ' '),
      root => fs.unlinkSync(path.join(root, 'package-build.json')),
      root => fs.writeFileSync(path.join(root, 'extra-member'), 'extra'),
      root => {
        const file = path.join(root, 'host/plugins/delivery-pipeline/scripts/sentinel.cjs');
        fs.chmodSync(file, (fs.statSync(file).mode & 0o7777) ^ 0o100);
      },
    ]) {
      fs.rmSync(copy, { recursive: true, force: true });
      fs.cpSync(expectedRoot, copy, { recursive: true });
      assert.deepEqual(inventory(copy), expected);
      mutate(copy);
      assert.throws(() => assert.deepEqual(inventory(copy), expected));
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});


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
function inspect(selectionBytes, expected, repository, stage, owned = COMPLETE_OWNED) {
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
  for (const relative of owned.filter(relative => relative.startsWith('host/'))) {
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
  assert.equal(actual.length, selection.outputs.length, 'incomplete selected package');
  const published = inventory(path.join(repository, 'plugins/shipyard'));
  assert.deepEqual(published, selection.outputs.map(row => ({ path: row.path, sha256: row.sha256,
    bytes: row.bytes, mode: row.publication_mode })), 'incomplete or mixed publication');
  const acceptance = require('../smoke/phase47-runtime-acceptance.cjs');
  const identity = acceptance.comparePackage(path.join(repository, 'plugins/shipyard'), {
    outputs: selection.outputs, source_content_sha256: contentDigest,
    package_sha256: metadata.digest, version: metadata.version });
  assert.equal(identity.output_count, selection.outputs.length);
  return { outputs: actual.length, scoped_outputs: owned.length, complete_publication: true, inspector_build_calls: 0 };
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
  assert.equal(git('rev-parse', HEAD), HEAD);
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

  if (fs.existsSync(path.join(ACCOUNTING_ROOT, 'selection.json'))) {
    const historical = JSON.parse(bytes);
    const actual = withoutWrites(() => inventory(historical.stage, '', true));
    assert.deepEqual(actual, historical.outputs.map(row => ({ path: row.path, sha256: row.sha256,
      bytes: row.bytes, mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })));
    assert.equal(historical.source.head, CURRENT_HEAD);
    assert.equal(historical.source.tree, CURRENT_TREE);
    assert.equal(historical.build_calls, 1);
    const git = (...args) => execFileSync('git', ['-C', ROOT, ...args],
      { encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(git('rev-parse', CURRENT_HEAD + '^{tree}'), CURRENT_TREE);
    for (const input of historical.inputs) {
      const committed = execFileSync('git', ['-C', ROOT, 'show', CURRENT_HEAD + ':' + input.path],
        { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(sha(committed), input.sha256, 'historical canonical source drift');
      assert.equal(git('ls-tree', CURRENT_HEAD, '--', input.path).split(' ')[0],
        input.mode === 0o755 ? '100755' : '100644');
    }
    const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
    const verified = coverage.verify({ commit: CURRENT_HEAD, repo: coverage.repoSlug(ROOT), worktree: ROOT });
    assert.equal(verified.covered, true, 'historical source authority: ' + verified.reason);
    const original = JSON.parse(read(historical.source.original_result, historical.source.original_result_sha256));
    assert.equal(original.ticket, 'T-49-08');
    assert.equal(original.dispatch_id, historical.source.original_dispatch);
    assert.deepEqual(coverage.validateFinalizationEvidence(verified.record).receipt, original.receipt);
    const stream = original.receipt.runtime_evidence.transcript;
    assert.equal(read(stream.path, stream.sha256).length, stream.bytes);
    t.diagnostic('Original6325 remains immutable historical authority; changed-source distribution is checked separately.');
    return;
  }

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
  assert.equal(gitCurrent('rev-parse', successorHead), successorHead);
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
  assert.equal(git('rev-parse', CURRENT_HEAD), CURRENT_HEAD);
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


function inspectAccountingSuccessor(bytes, expected, repository, stage, historical) {
  const selected = JSON.parse(bytes);
  assert.notEqual(selected.source.head, historical.source.head, 'old producer substituted');
  assert.notEqual(stage, historical.stage, 'historical stage reused');
  assert.notEqual(selected.package.digest, historical.package.digest, 'old package substituted');
  assert.equal(selected.inputs.length, 162, 'incomplete canonical input inventory');
  assert.equal(historical.outputs.length, 161);
  assert.deepEqual(selected.inputs.map(row => row.path).sort(), historical.inputs.map(row => row.path).sort(),
    'canonical input paths added or removed');
  const changedInputs = selected.inputs.filter(row => {
    const old = historical.inputs.find(previous => previous.path === row.path);
    assert.equal(row.mode, old.mode, 'canonical input mode changed');
    return row.sha256 !== old.sha256;
  }).map(row => row.path).sort();
  assert.deepEqual(changedInputs, ACCOUNTING_OWNED.slice(0, 2).map(relative => relative.slice('host/'.length)).sort(),
    'unexpected canonical input change');
  assert.equal(selected.builder_sha256, historical.builder_sha256, 'historical builder changed');
  assert.deepEqual(selected.outputs.map(row => row.path), historical.outputs.map(row => row.path),
    'output paths added or removed');
  const changed = selected.outputs.filter(row => {
    const old = historical.outputs.find(previous => previous.path === row.path);
    return row.sha256 !== old.sha256 || row.bytes !== old.bytes || row.publication_mode !== old.publication_mode;
  }).map(row => row.path).sort();
  assert.deepEqual(changed, [...ACCOUNTING_OWNED].sort(), 'unexpected generated delta requires ownership amendment');
  const result = inspect(bytes, expected, repository, stage);
  inspectAccountingAPIs(path.join(repository, 'plugins/shipyard/host/plugins/delivery-pipeline'));
  return { ...result, unchanged_outputs: 157, installed_acceptance: false, empirical_acceptance: false };
}

const MODE_ROOT = '/Users/serhii/.local/state/shipyard/phase49-selected-package-7d1608645431';
const MODE_SHA = '378f07d528a41d25424839092b203f6b6b2f8f5647133a5c3501d512d99d9a2d';
const MODE_HEAD = '7d16086454311ce1524d3cd4f500cabc8ffb6522';
const MODE_TREE = '3ad781d746cb28c4097633d10054a0eac977ecd9';
const MODE_INPUT = 'plugins/delivery-pipeline/scripts/ticket-worktree.sh';
const MODE_OUTPUT = 'host/' + MODE_INPUT;


const BATCH_INPUTS = ['codex-arch-review-context.cjs', 'codex-runtime-host.cjs', 'role-artifact.cjs',
  'deliver-dispatch.cjs', 'codex-delivery-host.cjs'].map(name => 'plugins/delivery-pipeline/scripts/' + name)
  .concat('plugins/delivery-pipeline/commands/deliver.md');
const BATCH_OUTPUTS = BATCH_INPUTS.map(relative => 'host/' + relative)
  .concat('.codex-plugin/plugin.json', 'package-build.json');

test('combined batch successor admits only the six-source/eight-output union and preserves modes', () => {
  const historical = { source: { head: 'original15', tree: 'original15-tree' }, stage: '/original15',
    build_calls: 1, builder_sha256: 'builder', package: { digest: 'original15' },
    inputs: canonicalInputs(ROOT), outputs: inventory(path.join(ROOT, 'plugins/shipyard'))
      .map(row => ({ ...row, publication_mode: row.mode })) };
  const selected = structuredClone(historical);
  selected.source = { head: 'combined17', tree: 'combined17-tree' };
  selected.stage = '/combined17'; selected.package.digest = 'combined17';
  for (const row of selected.inputs) if (BATCH_INPUTS.includes(row.path)) row.sha256 = 'a'.repeat(64);
  for (const row of selected.outputs) if (BATCH_OUTPUTS.includes(row.path)) row.sha256 = 'b'.repeat(64);
  const observed = inspectBatchDelta(selected, historical);
  assert.deepEqual(observed.changed_inputs, [...BATCH_INPUTS].sort());
  assert.deepEqual(observed.changed_outputs, [...BATCH_OUTPUTS].sort());
  assert.equal(observed.unchanged_inputs, 156); assert.equal(observed.unchanged_outputs, 153);
  for (const mutate of [
    value => { value.inputs.pop(); },
    value => { value.outputs.pop(); },
    value => { value.inputs[0].path = value.inputs[1].path; },
    value => { value.outputs.find(row => row.path === 'skills/shipyard-deliver/SKILL.md').sha256 = 'c'.repeat(64); },
    value => { value.inputs.find(row => row.path === MODE_INPUT).mode = 0o644; },
    value => { value.outputs.find(row => row.path === MODE_OUTPUT).publication_mode = 0o644; },
    value => { value.outputs.find(row => !BATCH_OUTPUTS.includes(row.path)).sha256 = 'd'.repeat(64); },
    value => { value.stage = historical.stage; },
    value => { value.build_calls = 2; },
    value => { value.builder_sha256 = 'foreign'; },
  ]) {
    const altered = structuredClone(selected); mutate(altered);
    assert.throws(() => inspectBatchDelta(altered, historical));
  }
  const unchanged = structuredClone(selected);
  for (const field of ['inputs', 'outputs']) {
    const row = unchanged[field].find(item => item.path === (field === 'inputs' ? BATCH_INPUTS[0] : 'host/' + BATCH_INPUTS[0]));
    row.sha256 = historical[field].find(item => item.path === row.path).sha256;
  }
  assert.equal(inspectBatchDelta(unchanged, historical).unchanged_inputs, 157);
  assert.equal(inspectBatchDelta(unchanged, historical).unchanged_outputs, 154);
});

function inspectBatchDelta(selected, historical) {
  assert.notEqual(selected.source.head, historical.source.head, 'old producer substituted');
  assert.notEqual(selected.source.tree, historical.source.tree, 'old source tree substituted');
  assert.notEqual(selected.stage, historical.stage, 'historical stage reused');
  assert.equal(selected.build_calls, 1); assert.equal(historical.build_calls, 1);
  assert.equal(selected.builder_sha256, historical.builder_sha256, 'builder changed');
  assert.notEqual(selected.package.digest, historical.package.digest, 'old package substituted');
  const result = {};
  for (const [field, count, mode, allowed] of [
    ['inputs', 162, 'mode', BATCH_INPUTS], ['outputs', 161, 'publication_mode', BATCH_OUTPUTS],
  ]) {
    const rows = selected[field], oldRows = historical[field];
    assert.equal(rows.length, count); assert.equal(oldRows.length, count);
    for (const list of [rows, oldRows]) {
      assert.equal(new Set(list.map(row => row.path)).size, count, 'duplicate inventory credit');
      list.forEach(row => safeRelative(row.path));
    }
    assert.deepEqual(rows.map(row => row.path).sort(), oldRows.map(row => row.path).sort(),
      'complete inventory paths changed');
    const changed = [];
    for (const row of rows) {
      const old = oldRows.find(previous => previous.path === row.path);
      assert.equal(row[mode], old[mode], 'batch successor mode changed');
      if (row.sha256 !== old.sha256 || row.bytes !== old.bytes) changed.push(row.path);
    }
    assert.deepEqual(changed.filter(relative => !allowed.includes(relative)), [],
      'unexpected delta requires ownership amendment');
    result['changed_' + field] = changed.sort();
    result['unchanged_' + field] = count - changed.length;
  }
  assert.equal(selected.inputs.find(row => row.path === MODE_INPUT).mode, 0o755);
  assert.equal(selected.outputs.find(row => row.path === MODE_OUTPUT).publication_mode, 0o755);
  assert.deepEqual(result.changed_outputs.filter(relative => relative.startsWith('host/')),
    result.changed_inputs.map(relative => 'host/' + relative).sort(), 'mixed source/output generation');
  assert(result.changed_outputs.includes('.codex-plugin/plugin.json'), 'missing derived version delta');
  assert(result.changed_outputs.includes('package-build.json'), 'missing derived digest delta');
  return result;
}

function inspectBatchSuccessor(bytes, expected, repository, stage, historicalBytes, historicalExpected, historicalRepository) {
  assert.equal(sha(bytes), expected.selection_sha256, 'selected bytes changed');
  assert.equal(sha(historicalBytes), historicalExpected.selection_sha256, 'historical selection changed');
  const historical = JSON.parse(historicalBytes), selected = JSON.parse(bytes);
  assert.equal(historical.source.head, historicalExpected.head);
  assert.equal(historical.source.tree, historicalExpected.tree);
  const delta = inspectBatchDelta(selected, historical);
  assert.deepEqual(inventory(historical.stage, '', true), historical.outputs.map(row => ({
    path: row.path, sha256: row.sha256, bytes: row.bytes,
    mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })), 'original15 physical inventory changed');
  equalInputs(historical.inputs, canonicalInputs(historicalRepository));
  const observed = inspect(bytes, expected, repository, stage);
  for (const relative of BATCH_INPUTS) {
    const input = selected.inputs.find(row => row.path === relative);
    const output = selected.outputs.find(row => row.path === 'host/' + relative);
    assert.equal(output.sha256, input.sha256, 'combined canonical/stage drift');
    assert.equal(output.publication_mode, input.mode);
  }
  inspectBatchAPIs(path.join(repository, 'plugins/shipyard/host/plugins/delivery-pipeline'));
  inspectRuntimeConsumers(repository);
  return { ...observed, ...delta, installed_acceptance: false, empirical_acceptance: false };
}

function inspectBatchAPIs(hostRoot) {
  inspectAccountingAPIs(hostRoot);
  const runtime = require(path.join(hostRoot, 'scripts/codex-runtime-host.cjs'));
  const dispatch = require(path.join(hostRoot, 'scripts/deliver-dispatch.cjs'));
  const delivery = require(path.join(hostRoot, 'scripts/codex-delivery-host.cjs'));
  for (const method of ['validateCompletedSourceRestoration', 'validateCompletedSourceClaimRecovery',
    'prepareCompletedSource', 'validateCompletedSourceConsumption']) assert.equal(typeof runtime[method], 'function');
  for (const method of ['buildCodexExecutorRequest', 'parseBuildArgs']) assert.equal(typeof dispatch[method], 'function');
  for (const method of ['prepareRepair', 'completeRepairFeedback', 'parseRepairActionResumeArguments'])
    assert.equal(typeof delivery[method], 'function');
}

function inspectBatchInstalled(identity, authenticated, selectionBytes, expected, authenticate) {
  assert.equal(typeof authenticate, 'function', 'protected installed verifier missing');
  const proof = authenticate(expected);
  assert(proof && proof.authenticated === true, 'installed authority missing or forged');
  assert.deepEqual(proof.expected, expected, 'independent installed references differ');
  assert.deepEqual(proof.identity, identity, 'installed identity substitution');
  assert.deepEqual(proof.binding, authenticated, 'installed binding substitution');
  for (const field of ['source_head', 'source_tree', 'publication_head', 'publication_tree'])
    assert.match(expected[field], /^[a-f0-9]{40}$/, 'missing exact installed subject');
  assert.equal(sha(selectionBytes), expected.selection_sha256, 'foreign installed selection');
  assert(![MODE_SHA, ACCOUNTING_SHA, CURRENT_SHA, SELECTION_SHA].includes(expected.selection_sha256),
    'old installed selection');
  assert.equal(typeof expected.runtime_root, 'string');
  assert(path.isAbsolute(expected.runtime_root), 'missing isolated runtime reference');
  inspectBatchCI(proof.source_ci, expected.source_head);
  inspectBatchCI(proof.ci, expected.publication_head);
  assert.equal(expected.selection_sha256, BATCH_SHA, 'old or foreign batch selection');
  assert.equal(expected.selection_root, BATCH_ROOT, 'foreign combined stage root');
  assert.equal(expected.source_head, BATCH_HEAD); assert.equal(expected.source_tree, BATCH_TREE);
  const signedBytes = authenticatePublicSelection(expected.selection_root, expected.selection_sha256, 'public-key.asc');
  assert.deepEqual(selectionBytes, signedBytes, 'installed unsigned selection substitution');
  const historicalBytes = authenticatePublicSelection(MODE_ROOT, MODE_SHA, 'public-key.asc');
  const selected = JSON.parse(selectionBytes);
  const sourceReceipt = authenticateBatchSource(selected, 'T-49-18', BATCH_HEAD, BATCH_TREE);
  assert(proof.publication_result && typeof proof.publication_result.path === 'string',
    'original publication native result missing');
  assert.match(proof.publication_dispatch, /^dispatch-[a-zA-Z0-9-]+$/, 'original publication dispatch missing');
  const publicationReceipt = authenticateBatchSource({ ...selected, source: { ...selected.source,
    head: expected.publication_head, tree: expected.publication_tree,
    original_result: proof.publication_result.path, original_result_sha256: proof.publication_result.sha256,
    original_dispatch: proof.publication_dispatch } }, 'T-49-17', expected.publication_head, expected.publication_tree);
  assert.equal(publicationReceipt.policy_hash, sourceReceipt.policy_hash, 'publication runtime policy changed');
  assert(proof.publication_native && typeof proof.publication_native.path === 'string',
    'original publication native session reference missing');
  inspectBatchNative(publicationReceipt, proof.publication_native.path);
  inspectBatchNative(sourceReceipt, '/Users/serhii/.codex/sessions/2026/10/13/'
    + 'rollout-2026-10-13T16-43-23-01a13580-e767-75f2-afed-fee49aa2d65e.jsonl');
  authenticateBatchSource(JSON.parse(historicalBytes), 'T-49-14', MODE_HEAD, MODE_TREE);
  historicalAccountingRepository(JSON.parse(historicalBytes), historicalRepository => withoutWrites(() =>
    inspectBatchSuccessor(selectionBytes, { selection_sha256: expected.selection_sha256,
      head: expected.source_head, tree: expected.source_tree }, ROOT, selected.stage,
    historicalBytes, { selection_sha256: MODE_SHA, head: MODE_HEAD, tree: MODE_TREE }, historicalRepository)));
  assert.equal(selected.stage, path.join(expected.selection_root, 'candidate'));
  assert.deepEqual(authenticated.binding.outputs, selected.outputs, 'installed inventory differs');
  assert.equal(authenticated.binding.version, selected.package.version);
  assert.equal(authenticated.binding.package_sha256, selected.package.digest);
  equalInputs(selected.inputs, authenticated.binding.source.identities);
  assert.equal(identity.source_head, expected.publication_head, 'stale installed source');
  assert.equal(identity.source_tree, expected.publication_tree, 'foreign installed source tree');
  assert.equal(identity.runtime_root, expected.runtime_root, 'same-version cache substitution');
  assert.equal(authenticated.identity.head, expected.publication_head);
  assert.equal(authenticated.identity.tree, expected.publication_tree);
  const observed = require('../smoke/phase47-runtime-acceptance.cjs').inspectInstalled(identity, authenticated);
  inspectBatchAPIs(identity.host_root);
  const physicalIdentity = inspectBatchInstalledPhysical(identity, selected, proof);
  return { ...observed, ...physicalIdentity, empirical_acceptance: false };
}

function authenticateBatchSource(selected, ticket, head, tree) {
  assert.equal(selected.source.head, head); assert.equal(selected.source.tree, tree);
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }).trim();
  assert.equal(git('rev-parse', head + '^{tree}'), tree);
  for (const row of selected.inputs) {
    const original = execFileSync('git', ['-C', ROOT, 'show', head + ':' + row.path],
      { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(sha(original), row.sha256, 'original canonical source drift');
    assert.equal(git('ls-tree', head, '--', row.path).split(' ')[0], row.mode === 0o755 ? '100755' : '100644');
  }
  const builder = execFileSync('git', ['-C', ROOT, 'show', head + ':scripts/package-shipyard-codex.cjs'],
    { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(sha(builder), selected.builder_sha256, 'original builder identity drift');
  const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
  const verified = coverage.verify({ commit: head, repo: coverage.repoSlug(ROOT), worktree: ROOT });
  assert.equal(verified.covered, true, 'protected original source authority: ' + verified.reason);
  assert.equal(verified.record.tree, tree);
  const original = JSON.parse(read(selected.source.original_result, selected.source.original_result_sha256));
  assert.equal(original.ticket, ticket); assert.equal(original.role, 'executor');
  assert.equal(original.dispatch_id, selected.source.original_dispatch);
  const stored = coverage.validateFinalizationEvidence(verified.record);
  assert.deepEqual(stored.receipt, original.receipt, 'original source recorder equality');
  assert.equal(original.receipt.compliance, 'verified');
  const stream = original.receipt.runtime_evidence.transcript;
  assert.equal(read(stream.path, stream.sha256).length, stream.bytes);
  return stored.receipt;
}

function inspectBatchNative(receipt, nativePath) {
  const evidence = receipt.runtime_evidence, pin = evidence.native_session_evidence;
  assert(pin && typeof nativePath === 'string', 'original native source reference missing');
  assert.equal(path.basename(nativePath), pin.file, 'native source path substitution');
  const native = read(nativePath, pin.sha256);
  assert.equal(native.length, pin.bytes);
  const runtime = require('../../plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const parsed = runtime.parseNativeCodexTranscript(native.toString('utf8'), evidence.session_id);
  for (const field of ['session_id', 'provider', 'models', 'efforts', 'selections', 'turn_contexts', 'records', 'sha256'])
    assert.deepEqual(parsed[field], pin[field], 'original native source association changed');
  assert.deepEqual(parsed.models, [receipt.requested_model]);
  assert.deepEqual(parsed.efforts, [receipt.requested_effort]);
  const stream = evidence.transcript;
  assert.equal(runtime.parseCodexStream(read(stream.path, stream.sha256).toString('utf8')).session_id,
    parsed.session_id, 'stream/native source session association changed');
  return parsed;
}

function inspectBatchCI(ci, head) {
  assert(ci, 'separate exact source/publication CI missing');
  assert.equal(ci.headSha, head, 'stale full CI');
  assert.equal(ci.status, 'completed'); assert.equal(ci.conclusion, 'success');
  const job = ci.jobs.find(row => row.name === 'test-fast');
  assert(job && job.status === 'completed' && job.conclusion === 'success', 'incomplete full CI');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success', 'incomplete full CI');
  }
  const log = ci.original_full_log;
  assert(log && typeof log.path === 'string', 'original full CI log missing');
  assert.equal(read(log.path, log.sha256).length, log.bytes, 'full CI log changed');
}

test('ordinary same-source physical inspection refuses stale sentinel, metadata, inventory and runtime custody', () => {
  const temporary = temporaryDirectory('ordinary-physical-fixture-');
  try {
    const runtimeRoot = path.join(temporary, 'runtime');
    const packageRoot = build(path.join(runtimeRoot, 'package'));
    const hostRoot = path.join(runtimeRoot, 'shipyard'); fs.mkdirSync(hostRoot);
    const outputs = inventory(packageRoot).map(({ mode, ...row }) => ({ ...row, publication_mode: mode }));
    const prefix = 'host/plugins/delivery-pipeline/';
    for (const row of outputs.filter(row => row.path.startsWith(prefix) &&
      ['scripts/', 'references/', 'templates/', 'workflows/', 'skills/delivery-rules/']
        .some(directory => row.path.startsWith(prefix + directory)))) {
      const file = path.join(hostRoot, row.path.slice(prefix.length));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(packageRoot, row.path), file); fs.chmodSync(file, row.publication_mode);
    }
    const reference = file => ({ path: file, sha256: sha(read(file)), bytes: read(file).length });
    const capabilities = path.join(hostRoot, 'codex-capabilities.json');
    fs.writeFileSync(capabilities, '{}\n', { mode: 0o644 });
    const converterFile = path.join(runtimeRoot, 'fixture-converter.cjs');
    fs.writeFileSync(converterFile, 'exports.convertClaudeCommandToCodexSkill = value => value;\n');
    const converted = require('../../scripts/gen-codex-shipyard.cjs').shipyardRewrites(
      read(path.join(packageRoot, prefix, 'commands/deliver.md')).toString('utf8'), hostRoot)
      .replace(/\$shipyard-(route|investigate|decompose|deliver|bench|delivery-rules)\b/g, '$shipyard:shipyard-$1');
    const nativeDeliver = path.join(runtimeRoot, 'native-deliver.md'); fs.writeFileSync(nativeDeliver, converted);
    const installerLog = path.join(temporary, 'fixture-installer.log');
    fs.writeFileSync(installerLog, 'Fixture only; no actual installation or Source acceptance.\n');
    const versionFile = path.join(runtimeRoot, 'VERSION'); fs.writeFileSync(versionFile, '1.0.0\n');
    const proof = { installer_log: reference(installerLog), gsd_version: { ...reference(versionFile), version: '1.0.0' },
      converter: reference(converterFile), native_deliver: reference(nativeDeliver) };
    for (const [key, root] of [['package_manifest', packageRoot], ['bundle_manifest', hostRoot]]) {
      const file = path.join(temporary, key + '.json');
      fs.writeFileSync(file, JSON.stringify({ root, files: inventory(root) })); proof[key] = reference(file);
    }
    const selected = { outputs };
    const identity = { source_dirty: false, package_root: packageRoot, host_root: hostRoot,
      runtime_root: runtimeRoot, native_capabilities: reference(capabilities) };
    const inspectPhysical = (subject = selected, custody = proof, installed = identity) =>
      inspectBatchInstalledPhysical(installed, subject, custody);
    assert.equal(inspectPhysical().package_files, outputs.length);
    for (const file of ['host/plugins/delivery-pipeline/scripts/sentinel.cjs',
      '.codex-plugin/plugin.json', 'package-build.json']) {
      const target = path.join(packageRoot, file), original = read(target);
      fs.appendFileSync(target, 'stale generation'); assert.throws(() => inspectPhysical());
      fs.writeFileSync(target, original);
    }
    const sentinel = path.join(hostRoot, 'scripts/sentinel.cjs'), original = read(sentinel);
    fs.appendFileSync(sentinel, 'old23 sentinel'); assert.throws(() => inspectPhysical()); fs.writeFileSync(sentinel, original);
    const mode = fs.statSync(sentinel).mode & 0o7777;
    fs.chmodSync(sentinel, mode ^ 0o100); assert.throws(() => inspectPhysical()); fs.chmodSync(sentinel, mode);
    fs.renameSync(sentinel, sentinel + '.missing'); assert.throws(() => inspectPhysical());
    fs.renameSync(sentinel + '.missing', sentinel);
    const extra = path.join(packageRoot, 'extra'); fs.writeFileSync(extra, 'extra');
    assert.throws(() => inspectPhysical()); fs.unlinkSync(extra);
    const old = structuredClone(selected);
    old.outputs.find(row => row.path === prefix + 'scripts/sentinel.cjs').sha256 = '0'.repeat(64);
    assert.throws(() => inspectPhysical(old), /BUNDLE identity differs/);
    for (const key of ['package_manifest', 'bundle_manifest', 'installer_log', 'gsd_version', 'converter', 'native_deliver']) {
      const absent = { ...proof }; delete absent[key]; assert.throws(() => inspectPhysical(selected, absent));
    }
    assert.throws(() => inspectPhysical(selected, proof, { ...identity, runtime_root: runtimeRoot + '-foreign' }));
    assert.throws(() => inspectPhysical(selected, proof, { ...identity, source_dirty: true }));
    const ci = { headSha: 'a'.repeat(40), status: 'completed', conclusion: 'success', original_full_log: reference(installerLog),
      jobs: [{ name: 'test-fast', status: 'completed', conclusion: 'success', steps:
        ['publish gate', 'runtime digest trailer', 'make test-fast'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] };
    inspectBatchCI(ci, ci.headSha);
    assert.throws(() => inspectBatchCI(ci, CURRENT_REVIEW.head), /stale full CI/);
    assert.throws(() => inspectBatchCI({ ...ci, original_full_log: null }, ci.headSha), /log missing/);
    fs.appendFileSync(installerLog, 'tampered'); assert.throws(() => inspectBatchCI(ci, ci.headSha));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('batch installed admission retains separate source/publication CI and refuses forged authority', () => {
  const temporary = temporaryDirectory('phase49-batch-ci-refusal-');
  try {
    const logPath = path.join(temporary, 'fixture-only-full-ci.log');
    const logBytes = Buffer.from('fixture-only CI log; no actual source or publication acceptance\n');
    fs.writeFileSync(logPath, logBytes);
    const expected = { selection_sha256: sha(Buffer.from('{}')), source_head: 'a'.repeat(40), source_tree: 'b'.repeat(40),
      publication_head: 'd'.repeat(40), publication_tree: 'e'.repeat(40), runtime_root: '/fixture-only-runtime' };
    const identity = {}, binding = {};
    const ci = head => ({ headSha: head, status: 'completed', conclusion: 'success', jobs: [
      { name: 'test-fast', status: 'completed', conclusion: 'success', steps:
        ['publish gate', 'runtime digest trailer', 'make test-fast'].map(name =>
          ({ name, status: 'completed', conclusion: 'success' })) },
    ], original_full_log: { path: logPath, sha256: sha(logBytes), bytes: logBytes.length } });
    const proof = { authenticated: true, expected, identity, binding,
      source_ci: ci(expected.source_head), ci: ci(expected.publication_head) };
    assert.throws(() => inspectBatchInstalled(identity, binding, Buffer.from('{}'), expected), /verifier missing/);
    for (const [mutate, refusal] of [
      [value => { value.authenticated = false; }, /authority missing or forged/],
      [value => { value.expected.publication_head = expected.source_head; }, /independent installed references differ/],
      [value => { value.identity.source_head = null; }, /installed identity substitution/],
      [value => { value.binding.identity = null; }, /installed binding substitution/],
      [value => { delete value.source_ci; }, /separate exact source/],
      [value => { value.source_ci.headSha = expected.publication_head; }, /stale full CI/],
      [value => { value.ci.headSha = expected.source_head; }, /stale full CI/],
      [value => { value.source_ci.status = 'cancelled'; }, /strictly equal/],
      [value => { value.ci.conclusion = 'failure'; }, /strictly equal/],
      [value => { value.source_ci.jobs[0].steps[2].conclusion = 'skipped'; }, /incomplete full CI/],
      [value => { value.ci.jobs[0].steps.pop(); }, /incomplete full CI/],
      [value => { delete value.source_ci.original_full_log; }, /original full CI log missing/],
      [value => { value.ci.original_full_log.sha256 = '0'.repeat(64); }, /digest|hash|changed/],
      [() => {}, /old or foreign batch selection/],
    ]) {
      const altered = structuredClone(proof); mutate(altered);
      assert.throws(() => inspectBatchInstalled(identity, binding, Buffer.from('{}'), expected, () => altered), refusal);
    }
    fs.appendFileSync(logPath, 'tampered');
    assert.throws(() => inspectBatchCI(proof.source_ci, expected.source_head));
    assert.throws(() => inspectBatchCI(proof.ci, expected.publication_head));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

const BATCH_ROOT = '/Users/serhii/.local/state/shipyard/phase49-selected-package-23c54b703811';
const BATCH_SHA = 'ba4be421f42a856091e11d8347ff698a8abfb33dd32ff1427ca855d0926769b7';
const BATCH_HEAD = '23c54b703811d4ebdebe23b260fd00e12e8c227b';
const BATCH_TREE = '5998044394d6021e07c7ebebe2d9469f6c9cd03e';
const BATCH_OBSERVATION = '/Users/serhii/.local/state/shipyard/phase49-T49-17-combined-stage-ready-observation.json';

test('original combined stage independently pins all162/all161 and exact same-stage publication', t => {
  if (!fs.existsSync(BATCH_OBSERVATION) || !fs.existsSync(path.join(BATCH_ROOT, 'selection.json'))) {
    t.skip('HOLD: original combined stage unavailable; no installed or empirical acceptance');
    return;
  }
  const marker = JSON.parse(read(BATCH_OBSERVATION,
    'f8c6eef922fbf703c82cf43902c8fa3d8df327af839e4d3a365f27e27a634ae6'));
  assert.equal(marker.ready, true); assert.equal(marker.build_calls, 1);
  assert.equal(marker.root, BATCH_ROOT); assert.equal(marker.selection_sha256, BATCH_SHA);
  assert.equal(marker.source_head, BATCH_HEAD); assert.equal(marker.source_tree, BATCH_TREE);
  const copies = JSON.parse(read(marker.original_copies,
    '6e186575670e53d73b28219c37863b2d61a20d9c2fc298ade853f057d69d33a5'));
  assert.equal(copies.selection_sha256, BATCH_SHA); assert.equal(copies.source_head, BATCH_HEAD);
  assert.equal(copies.build_calls, 1); assert.equal(copies.canonical_inputs, 162);
  assert.equal(copies.complete_outputs, 161);
  assert.deepEqual(copies.published, BATCH_OUTPUTS.map(relative => 'plugins/shipyard/' + relative).sort());
  const launch = JSON.parse(read(marker.actual_clean_launch,
    'b84faa5ac72c5beac9b96b91f17682cd1607bbed216ef01fc88160c13fc0b367'));
  assert.equal(launch.tracked_clean, true); assert.equal(launch.head_still_pinned, true);
  assert.equal(launch.baseline_head, '099d92d0d7cff9445e67c06d5a02e777741f5155');
  assert.equal(launch.baseline_tree, BATCH_TREE); assert.equal(launch.source_head, BATCH_HEAD);
  assert.equal(launch.worktree, '/Volumes/KINGSTON/worktrees/phase47-1-investigation/.wt-claude-shipyard/T-49-17');
  assert.equal(launch.ticket, 'T-49-17');
  assert(Number.isSafeInteger(launch.native_process_id) && launch.native_process_id > 0);
  read(launch.prelaunch_observation.path, launch.prelaunch_observation.sha256);
  const gitHistory = (...args) => execFileSync('git', ['-C', ROOT, ...args],
    { timeout: 10000, encoding: 'utf8' }).trim();
  const mergedModeSource = '9a44d1fec668148ca349f923757a08fece4cccde';
  const originalModePublication = '7d39c7e7e85d42b75daa05cd4d0affce96aa0d48';
  const mergedModePublication = '424cc6dd3c7e2b85376ca493586a0fe5f03a626e';
  assert.equal(gitHistory('rev-parse', mergedModeSource + '^{tree}'), MODE_TREE);
  assert.equal(gitHistory('rev-parse', MODE_HEAD + '^{tree}'), MODE_TREE);
  assert.equal(gitHistory('rev-parse', mergedModeSource + '^'), gitHistory('rev-parse', MODE_HEAD + '^'));
  assert.equal(gitHistory('rev-parse', originalModePublication + '^'), MODE_HEAD);
  assert.equal(gitHistory('rev-parse', mergedModePublication + '^'), mergedModeSource);
  assert.equal(gitHistory('rev-parse', originalModePublication + '^{tree}'),
    gitHistory('rev-parse', mergedModePublication + '^{tree}'));
  gitHistory('merge-base', '--is-ancestor', mergedModePublication, BATCH_HEAD);
  const mergedBatchSource = 'a8261467c4be457b9d4b0640cb713b9dc60f50ef';
  assert.equal(gitHistory('rev-parse', BATCH_HEAD + '^{tree}'), BATCH_TREE);
  assert.equal(gitHistory('rev-parse', mergedBatchSource + '^{tree}'), BATCH_TREE);
  gitHistory('merge-base', '--is-ancestor', mergedModePublication, mergedBatchSource);
  gitHistory('merge-base', '--is-ancestor', mergedBatchSource, 'HEAD');
  const bytes = authenticatePublicSelection(BATCH_ROOT, BATCH_SHA, 'public-key.asc');
  const historicalBytes = authenticatePublicSelection(MODE_ROOT, MODE_SHA, 'public-key.asc');
  const selected = JSON.parse(bytes), historical = JSON.parse(historicalBytes);
  const sourceReceipt = authenticateBatchSource(selected, 'T-49-18', BATCH_HEAD, BATCH_TREE);
  const modeReceipt = authenticateBatchSource(historical, 'T-49-14', MODE_HEAD, MODE_TREE);
  assert.equal(sourceReceipt.policy_hash, modeReceipt.policy_hash, 'original runtime policy changed');
  const custody = JSON.parse(read('/Users/serhii/.local/state/shipyard/phase49-T49-18-23c54b7-original-native-custody.json',
    '798e83b17e188bd4a40ea3da522a7e0a2b31428524eea773128979ddfe600f5c'));
  assert.equal(custody.length, 2);
  for (const row of custody) assert.equal(read(row.path, row.sha256).length, row.bytes);
  const originalNative = custody.find(row => row.sha256 === sourceReceipt.runtime_evidence.native_session_evidence.sha256);
  assert(originalNative, 'original native SOURCE18 custody association missing');
  inspectBatchNative(sourceReceipt, originalNative.path);
  inspectBatchNative(modeReceipt, '/Users/serhii/.codex/sessions/2026/10/11/'
    + 'rollout-2026-10-11T01-29-19-01a127ef-553a-7b60-9f6a-44b06f65dcd6.jsonl');
  assert.equal(selected.source.original_dispatch, 'dispatch-mv6qeery-c845642f-c8af-4b56-bb04-b0777b47b944');
  const producer = JSON.parse(read(marker.source_original_producer,
    '84b7042fe4feabf504cd0965c5374d22054e6915b314ec4b50dd896789bc643a'));
  assert.equal(producer.artifact_digest, selected.source.artifact_digest);
  assert.equal(producer.envelope.role, 'executor'); assert.equal(producer.envelope.ticket, 'T-49-18');
  const sourceCI = JSON.parse(read(marker.source_full_ci,
    '87d5a8d6b1236ca243086afba80e08f6198245eb71fd18d79d719d547d71272d'));
  inspectBatchCI(sourceCI, BATCH_HEAD);
  const result = historicalAccountingRepository(selected, originalRepository => {
    assert.deepEqual(withoutWrites(() => inventory(path.join(originalRepository, 'plugins/shipyard'))),
      selected.outputs.map(row => ({ path: row.path, sha256: row.sha256,
        bytes: row.bytes, mode: row.publication_mode })), 'original same-stage publication changed');
    return historicalAccountingRepository(JSON.parse(historicalBytes), historicalRepository =>
      withoutWrites(() => inspectBatchSuccessor(bytes,
        { selection_sha256: BATCH_SHA, head: BATCH_HEAD, tree: BATCH_TREE }, originalRepository,
        path.join(BATCH_ROOT, 'candidate'), historicalBytes,
        { selection_sha256: MODE_SHA, head: MODE_HEAD, tree: MODE_TREE }, historicalRepository)));
  });
  assert.deepEqual(result.changed_inputs, [...BATCH_INPUTS].sort());
  assert.deepEqual(result.changed_outputs, [...BATCH_OUTPUTS].sort());
  assert.equal(result.unchanged_inputs, 156); assert.equal(result.unchanged_outputs, 153);
  assert.equal(result.inspector_build_calls, 0); assert.equal(result.installed_acceptance, false);
  assert.equal(result.empirical_acceptance, false);
  assert.deepEqual(read(path.join(MODE_ROOT, 'selection.json'), MODE_SHA), historicalBytes);
  t.diagnostic('Original combined publication inspected. Supported actual isolated installation and exact publication17 CI remain separate; native11 empirical acceptance stays HOLD.');
});

function inspectBatchInstalledPhysical(identity, selected, proof) {
  assert.equal(identity.source_dirty, false, 'dirty installed source');
  for (const [reference, root] of [[proof.package_manifest, identity.package_root],
    [proof.bundle_manifest, identity.host_root]]) {
    assert(reference && typeof reference.path === 'string', 'original complete installed manifest missing');
    const manifest = JSON.parse(read(reference.path, reference.sha256));
    assert.equal(manifest.root, root, 'installed physical manifest root substitution');
    assert.deepEqual(manifest.files, inventory(root), 'complete installed physical manifest drift');
  }
  assert(proof.installer_log && typeof proof.installer_log.path === 'string', 'original installer log missing');
  assert.equal(read(proof.installer_log.path, proof.installer_log.sha256).length, proof.installer_log.bytes);
  assert(proof.gsd_version && typeof proof.gsd_version.path === 'string', 'actual isolated GSD version missing');
  assert(proof.gsd_version.path.startsWith(identity.runtime_root + path.sep), 'foreign isolated GSD version');
  assert.equal(read(proof.gsd_version.path, proof.gsd_version.sha256).toString('utf8').trim(), proof.gsd_version.version);
  assert.match(proof.gsd_version.version, /^\d+\.\d+\.\d+(?:[-+].*)?$/);
  const bundlePrefix = 'host/plugins/delivery-pipeline/';
  const bundleRows = selected.outputs.filter(row => row.path.startsWith(bundlePrefix)
    && (['scripts', 'references', 'templates', 'workflows'].some(directory =>
      row.path.startsWith(bundlePrefix + directory + '/'))
    || row.path.startsWith(bundlePrefix + 'skills/delivery-rules/'))).map(row => ({
    path: row.path.slice(bundlePrefix.length), sha256: row.sha256, bytes: row.bytes, mode: row.publication_mode }));
  const capabilities = read(identity.native_capabilities.path, identity.native_capabilities.sha256);
  bundleRows.push({ path: 'codex-capabilities.json', sha256: sha(capabilities), bytes: capabilities.length, mode: 0o644 });
  assert.deepEqual(inventory(identity.host_root), bundleRows.sort((a, b) => a.path.localeCompare(b.path)),
    'selected complete BUNDLE identity differs');
  assert(proof.native_deliver && typeof proof.native_deliver.path === 'string', 'actual converted native deliver workflow missing');
  assert(proof.native_deliver.path.startsWith(identity.runtime_root + path.sep), 'foreign installed native workflow');
  assert(proof.converter && typeof proof.converter.path === 'string', 'original installed converter missing');
  assert(proof.converter.path.startsWith(identity.runtime_root + path.sep), 'foreign installed converter');
  read(proof.converter.path, proof.converter.sha256);
  const converter = require(proof.converter.path);
  const originalCommand = read(path.join(identity.package_root, 'host/plugins/delivery-pipeline/commands/deliver.md'));
  const converted = require('../../scripts/gen-codex-shipyard.cjs').shipyardRewrites(
    converter.convertClaudeCommandToCodexSkill(originalCommand.toString('utf8'), 'shipyard-deliver'),
    identity.host_root).replace(/\$shipyard-(route|investigate|decompose|deliver|bench|delivery-rules)\b/g,
    '$shipyard:shipyard-$1');
  assert.equal(read(proof.native_deliver.path, proof.native_deliver.sha256).toString('utf8'), converted,
    'installed secure fixer native workflow drift');
  read(proof.converter.path, proof.converter.sha256);
  assert.match(converted, /build review-fix/);
  assert.match(converted, /complete paginated feedback/);
  assert.match(converted, /Exactly one original native completion/);
  assert.match(converted, /Feedback-only results require no commit/);
  return { package_files: selected.outputs.length, bundle_files: bundleRows.length,
    actual_isolated_gsd_version: proof.gsd_version.version, empirical_acceptance: false };
}

function inspectModeDelta(selected, historical) {
  assert.notEqual(selected.source.head, historical.source.head, 'old producer substituted');
  assert.notEqual(selected.source.tree, historical.source.tree, 'old source tree substituted');
  assert.notEqual(selected.stage, historical.stage, 'historical stage reused');
  assert.equal(selected.build_calls, 1);
  assert.equal(historical.build_calls, 1);
  assert.equal(selected.builder_sha256, historical.builder_sha256, 'builder changed');
  assert.deepEqual(selected.package, historical.package, 'mode-only metadata changed');
  for (const [field, count, mode, member] of [
    ['inputs', 162, 'mode', MODE_INPUT], ['outputs', 161, 'publication_mode', MODE_OUTPUT],
  ]) {
    const rows = selected[field], oldRows = historical[field];
    assert.equal(rows.length, count); assert.equal(oldRows.length, count);
    for (const list of [rows, oldRows]) {
      assert.equal(new Set(list.map(row => row.path)).size, count, 'duplicate inventory credit');
      list.forEach(row => safeRelative(row.path));
    }
    assert.deepEqual(rows.map(row => row.path).sort(), oldRows.map(row => row.path).sort(),
      'complete inventory paths changed');
    const changed = [];
    for (const row of rows) {
      const old = oldRows.find(previous => previous.path === row.path);
      assert.equal(row.sha256, old.sha256, 'mode-only bytes changed');
      assert.equal(row.bytes, old.bytes, 'mode-only lengths changed');
      if (row[mode] !== old[mode]) {
        assert.equal(old[mode], 0o644); assert.equal(row[mode], 0o755);
        changed.push(row.path);
      }
    }
    assert.deepEqual(changed, [member], 'unexpected mode delta requires ownership amendment');
  }
}

function inspectModeSuccessor(bytes, expected, repository, stage, historicalBytes, historicalExpected) {
  assert.equal(sha(historicalBytes), historicalExpected.selection_sha256, 'historical selection changed');
  const historical = JSON.parse(historicalBytes), selected = JSON.parse(bytes);
  assert.equal(historical.source.head, historicalExpected.head);
  assert.equal(historical.source.tree, historicalExpected.tree);
  assert.notEqual(expected.selection_sha256, historicalExpected.selection_sha256, 'old selection substituted');
  assert.equal(sha(bytes), expected.selection_sha256);
  inspectModeDelta(selected, historical);
  const oldInventory = inventory(historical.stage, '', true);
  assert.deepEqual(oldInventory, historical.outputs.map(row => ({ path: row.path, sha256: row.sha256,
    bytes: row.bytes, mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })));
  const result = inspect(bytes, expected, repository, stage);
  inspectAccountingAPIs(path.join(repository, 'plugins/shipyard/host/plugins/delivery-pipeline'));
  return { ...result, changed_modes: 1, unchanged_outputs: 160, unchanged_output_bytes: 161,
    installed_acceptance: false, empirical_acceptance: false };
}

function inspectModeInstalled(identity, authenticated, selectionBytes, expected, authenticate) {
  assert.equal(typeof authenticate, 'function', 'protected installed verifier missing');
  const proof = authenticate(expected);
  assert(proof && proof.authenticated === true, 'installed authority missing or forged');
  assert.deepEqual(proof.expected, expected, 'independent installed references differ');
  assert.deepEqual(proof.identity, identity, 'installed identity substitution');
  assert.deepEqual(proof.binding, authenticated, 'installed binding substitution');
  assert.equal(expected.source_head, MODE_HEAD); assert.equal(expected.source_tree, MODE_TREE);
  for (const field of ['publication_head', 'publication_tree'])
    assert.match(expected[field], /^[a-f0-9]{40}$/, 'missing exact installed publication subject');
  assert.equal(typeof expected.runtime_root, 'string');
  assert(path.isAbsolute(expected.runtime_root), 'missing isolated runtime reference');
  assert.equal(proof.ci.headSha, expected.publication_head, 'stale publication CI');
  assert.equal(proof.ci.status, 'completed'); assert.equal(proof.ci.conclusion, 'success');
  const job = proof.ci.jobs.find(row => row.name === 'test-fast');
  assert(job && job.status === 'completed' && job.conclusion === 'success');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success', 'incomplete publication CI');
  }
  const log = proof.ci.original_full_log;
  assert(log && typeof log.path === 'string', 'full publication CI log missing');
  assert.equal(read(log.path, log.sha256).length, log.bytes, 'full publication CI log changed');
  assert.equal(expected.selection_sha256, MODE_SHA, 'old or foreign mode selection');
  assert.equal(sha(selectionBytes), expected.selection_sha256, 'foreign installed selection');
  assert(![ACCOUNTING_SHA, CURRENT_SHA, SELECTION_SHA].includes(expected.selection_sha256), 'old installed selection');
  const signedBytes = authenticatePublicSelection(MODE_ROOT, MODE_SHA, 'public-key.asc');
  assert.deepEqual(selectionBytes, signedBytes, 'installed unsigned selection substitution');
  const historicalBytes = authenticatePublicSelection(ACCOUNTING_ROOT, ACCOUNTING_SHA, 'public-key.asc');
  inspectModeSuccessor(selectionBytes, { selection_sha256: MODE_SHA, head: MODE_HEAD, tree: MODE_TREE },
    ROOT, path.join(MODE_ROOT, 'candidate'), historicalBytes,
    { selection_sha256: ACCOUNTING_SHA, head: ACCOUNTING_HEAD, tree: ACCOUNTING_TREE });
  const selected = JSON.parse(selectionBytes);
  assert.equal(selected.source.head, MODE_HEAD); assert.equal(selected.source.tree, MODE_TREE);
  assert.equal(selected.source.head, expected.source_head); assert.equal(selected.source.tree, expected.source_tree);
  assert.equal(selected.stage, path.join(MODE_ROOT, 'candidate'));
  assert.equal(selected.build_calls, 1);
  assert.equal(selected.inputs.length, 162); assert.equal(selected.outputs.length, 161);
  assert.equal(selected.outputs.find(row => row.path === MODE_OUTPUT).publication_mode, 0o755);
  assert.deepEqual(authenticated.binding.outputs, selected.outputs, 'installed inventory differs');
  assert.equal(authenticated.binding.version, selected.package.version);
  assert.equal(authenticated.binding.package_sha256, selected.package.digest);
  equalInputs(selected.inputs, authenticated.binding.source.identities);
  assert.equal(identity.source_head, expected.publication_head, 'stale installed source');
  assert.equal(identity.source_tree, expected.publication_tree, 'foreign installed source tree');
  assert.equal(identity.runtime_root, expected.runtime_root, 'same-version cache substitution');
  assert.notEqual(identity.runtime_root, '/Users/serhii/.local/state/shipyard/dogfood/codex/3412ce7b163b2e7f',
    'original13 isolated cache reused');
  assert.equal(authenticated.identity.head, expected.publication_head);
  assert.equal(authenticated.identity.tree, expected.publication_tree);
  const acceptance = require('../smoke/phase47-runtime-acceptance.cjs');
  const observed = acceptance.inspectInstalled(identity, authenticated);
  inspectAccountingAPIs(identity.host_root);
  return { ...observed, empirical_acceptance: false };
}

function historicalAccountingRepository(selected, callback) {
  const repository = temporaryDirectory('phase49-historical-accounting-');
  try {
    const tree = execFileSync('git', ['-C', ROOT, 'rev-parse', selected.source.head + '^{tree}'],
      { encoding: 'utf8', timeout: 10000 }).trim();
    assert.equal(tree, selected.source.tree, 'historical producer tree drift');
    for (const input of selected.inputs) {
      safeRelative(input.path);
      const bytes = execFileSync('git', ['-C', ROOT, 'show', selected.source.head + ':' + input.path],
        { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(sha(bytes), input.sha256, 'historical committed input drift');
      const mode = execFileSync('git', ['-C', ROOT, 'ls-tree', selected.source.head, '--', input.path],
        { encoding: 'utf8', timeout: 10000 }).split(' ')[0];
      assert.equal(mode, input.mode === 0o755 ? '100755' : '100644');
      const target = path.join(repository, input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      fs.chmodSync(target, input.mode);
    }
    for (const output of selected.outputs) {
      const target = path.join(repository, 'plugins/shipyard', output.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read(path.join(selected.stage, output.path), output.sha256));
      fs.chmodSync(target, output.publication_mode);
    }
    return callback(repository);
  } finally { fs.rmSync(repository, { recursive: true, force: true }); }
}

function inspectAccountingAPIs(hostRoot) {
  const runtime = require(path.join(hostRoot, 'scripts/codex-runtime-host.cjs'));
  const authority = require(path.join(hostRoot, 'scripts/role-artifact.cjs'));
  assert.equal(typeof runtime.verifyCompletedReviewConsumption, 'function');
  assert.equal(typeof authority.authenticateCompletedReviewReferences, 'function');
  for (const serialized of [{}, { authenticated: true }, { progress: { state: { completed: true } } }]) {
    assert.throws(() => runtime.verifyCompletedReviewConsumption(serialized),
      error => error.code === 'REVIEW_PROGRESS_REQUIRED');
    assert.throws(() => runtime.validateReviewRestoration(serialized, {}),
      error => error.code === 'REVIEW_PROGRESS_INVALID');
    assert.throws(() => runtime.verifyFileConsumption(serialized, '', 'forged'),
      error => error.code === 'INVALID_ARCH_REVIEW_CONTEXT');
  }
}

function inspectAccountingInstalled(identity, authenticated, selectionBytes) {
  assert.equal(sha(selectionBytes), ACCOUNTING_SHA, 'foreign installed selection');
  const selected = JSON.parse(selectionBytes);
  assert.equal(selected.source.head, ACCOUNTING_HEAD);
  assert.equal(selected.source.tree, ACCOUNTING_TREE);
  assert.deepEqual(authenticated.binding.outputs, selected.outputs, 'installed binding inventory differs');
  assert.equal(authenticated.binding.version, selected.package.version, 'installed version differs');
  assert.equal(authenticated.binding.package_sha256, selected.package.digest, 'installed package digest differs');
  equalInputs(selected.inputs, authenticated.binding.source.identities);
  const acceptance = require('../smoke/phase47-runtime-acceptance.cjs');
  const observed = acceptance.inspectInstalled(identity, authenticated);
  inspectAccountingAPIs(identity.host_root);
  return { ...observed, empirical_acceptance: false };
}

test('mode-only successor rejects same-version old identity and complete inventory mutations', () => {
  const temporary = temporaryDirectory('phase49-mode-fixture-');
  const stage = path.join(temporary, 'candidate'), oldStage = path.join(temporary, 'historical');
  const repository = path.join(temporary, 'repository');
  try {
    build(stage);
    const inputs = canonicalInputs(ROOT);
    for (const input of inputs) {
      const target = path.join(repository, input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(ROOT, input.path), target);
      fs.chmodSync(target, input.mode);
    }
    const outputs = inventory(stage).map(row => ({ path: row.path, sha256: row.sha256,
      bytes: row.bytes, publication_mode: row.mode }));
    const selected = { schema: 'shipyard.phase49.selected-package.v1',
      source: { head: 'fixture-mode-head', tree: 'fixture-mode-tree' }, stage, build_calls: 1,
      builder_sha256: sha(read(path.join(ROOT, 'scripts/package-shipyard-codex.cjs'))), inputs, outputs,
      package: JSON.parse(read(path.join(stage, 'package-build.json'))) };
    const historical = structuredClone(selected);
    historical.source = { head: 'fixture-old-head', tree: 'fixture-old-tree' }; historical.stage = oldStage;
    historical.inputs.find(row => row.path === MODE_INPUT).mode = 0o644;
    historical.outputs.find(row => row.path === MODE_OUTPUT).publication_mode = 0o644;
    for (const output of outputs) {
      for (const [root, mode] of [[path.join(repository, 'plugins/shipyard'), output.publication_mode],
        [oldStage, historical.outputs.find(row => row.path === output.path).publication_mode === 0o755 ? 0o500 : 0o400]]) {
        const target = path.join(root, output.path);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(stage, output.path), target);
        fs.chmodSync(target, mode);
      }
      fs.chmodSync(path.join(stage, output.path), output.publication_mode === 0o755 ? 0o500 : 0o400);
    }
    fixtureDirectoryModes(stage, 0o500); fixtureDirectoryModes(oldStage, 0o500);
    const bytes = Buffer.from(JSON.stringify(selected)), oldBytes = Buffer.from(JSON.stringify(historical));
    const expected = { selection_sha256: sha(bytes), ...selected.source };
    const oldExpected = { selection_sha256: sha(oldBytes), ...historical.source };
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const signature = crypto.sign(null, bytes, privateKey);
    assert(crypto.verify(null, bytes, publicKey, signature));
    assert(!crypto.verify(null, oldBytes, publicKey, signature));
    const consume = (value = bytes, pins = expected) => withoutWrites(() =>
      inspectModeSuccessor(value, pins, repository, stage, oldBytes, oldExpected));
    assert.equal(consume().unchanged_outputs, 160);
    assert.equal(consume().unchanged_output_bytes, 161);
    assert.equal(consume().inspector_build_calls, 0);
    assert.throws(() => consume(oldBytes, oldExpected), /old selection substituted/);
    for (const mutate of [
      value => { value.source = historical.source; },
      value => { value.stage = historical.stage; },
      value => { value.build_calls = 2; },
      value => { value.inputs.pop(); },
      value => { value.outputs.pop(); },
      value => { value.inputs[0].path = value.inputs[1].path; },
      value => { value.outputs[0].sha256 = '0'.repeat(64); },
      value => { value.outputs[0].bytes++; },
      value => { value.inputs.find(row => row.path === MODE_INPUT).mode = 0o644; },
      value => { value.outputs.find(row => row.path === MODE_OUTPUT).publication_mode = 0o644; },
      value => { value.outputs.find(row => row.path !== MODE_OUTPUT).publication_mode ^= 0o100; },
      value => { value.package.digest = '0'.repeat(64); },
    ]) {
      const altered = structuredClone(selected); mutate(altered);
      const alteredBytes = Buffer.from(JSON.stringify(altered));
      assert.throws(() => consume(alteredBytes, { ...expected, selection_sha256: sha(alteredBytes) }));
    }
    const mirror = path.join(repository, 'plugins/shipyard', MODE_OUTPUT);
    fs.chmodSync(mirror, 0o644); assert.throws(() => consume(), /incomplete or mixed publication/);
    fs.chmodSync(mirror, 0o755);
    assert.throws(() => inspectModeInstalled({}, {}, bytes, expected, () => ({ authenticated: false })),
      /authority missing or forged/);
    assert.throws(() => inspectModeInstalled({}, {}, oldBytes, oldExpected, () =>
      ({ authenticated: true, expected: expected, identity: {}, binding: {} })), /independent installed references differ/);
    assert.deepEqual(inventory(oldStage, '', true), historical.outputs.map(row => ({ path: row.path,
      sha256: row.sha256, bytes: row.bytes, mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })));
  } finally {
    for (const root of [stage, oldStage]) if (fs.existsSync(root)) fixtureDirectoryModes(root, 0o700);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('installed mode admission refuses forged references and incomplete exact publication CI', () => {
  const expected = { selection_sha256: MODE_SHA, source_head: MODE_HEAD, source_tree: MODE_TREE,
    publication_head: 'a'.repeat(40), publication_tree: 'b'.repeat(40), runtime_root: '/fixture-only-runtime' };
  const identity = { source_head: expected.publication_head }, binding = { identity: {} };
  const proof = { authenticated: true, expected, identity, binding,
    ci: { headSha: expected.publication_head, status: 'completed', conclusion: 'success', jobs: [
      { name: 'test-fast', status: 'completed', conclusion: 'success', steps:
        ['publish gate', 'runtime digest trailer', 'make test-fast'].map(name =>
          ({ name, status: 'completed', conclusion: 'success' })) },
    ] } };
  for (const [mutate, refusal] of [
    [value => { value.authenticated = false; }, /authority missing or forged/],
    [value => { value.expected.publication_head = MODE_HEAD; }, /independent installed references differ/],
    [value => { value.identity.source_head = null; }, /installed identity substitution/],
    [value => { value.binding.identity = null; }, /installed binding substitution/],
    [value => { value.ci.headSha = MODE_HEAD; }, /stale publication CI/],
    [value => { value.ci.status = 'cancelled'; }, /strictly equal/],
    [value => { value.ci.conclusion = 'failure'; }, /strictly equal/],
    [value => { value.ci.jobs = []; }, /assertion|falsy/i],
    [value => { value.ci.jobs[0].steps[2].conclusion = 'skipped'; }, /incomplete publication CI/],
    [value => { value.ci.jobs[0].steps.pop(); }, /incomplete publication CI/],
    [() => {}, /full publication CI log missing/],
  ]) {
    const altered = structuredClone(proof); mutate(altered);
    assert.throws(() => inspectModeInstalled(identity, binding, Buffer.from('{}'), expected, () => altered), refusal);
  }
});

test('distinct signed mode successor independently inspects full162/all161 without production builds', t => {
  const markerPath = '/Users/serhii/.local/state/shipyard/phase49-T49-15-installed-mode-selected-copies.json';
  if (!fs.existsSync(markerPath) || !fs.existsSync(path.join(MODE_ROOT, 'selection.json'))) {
    t.skip('HOLD: coordinator mode selection/copy evidence unavailable; no installed or empirical acceptance');
    return;
  }
  const marker = JSON.parse(read(markerPath));
  const digest = MODE_SHA;
  assert.equal(marker.selection_sha256, digest);
  assert.equal(marker.source_head, MODE_HEAD); assert.equal(marker.build_calls, 1);
  assert.deepEqual(marker.published, ['plugins/shipyard/' + MODE_OUTPUT]);
  assert(![ACCOUNTING_SHA, CURRENT_SHA, SELECTION_SHA].includes(digest));
  const bytes = authenticatePublicSelection(MODE_ROOT, digest, 'public-key.asc');
  const historicalBytes = authenticatePublicSelection(ACCOUNTING_ROOT, ACCOUNTING_SHA, 'public-key.asc');
  const expected = { selection_sha256: digest, head: MODE_HEAD, tree: MODE_TREE };
  const result = historicalAccountingRepository(JSON.parse(bytes), repository => withoutWrites(() =>
    inspectModeSuccessor(bytes, expected, repository, path.join(MODE_ROOT, 'candidate'),
      historicalBytes, { selection_sha256: ACCOUNTING_SHA, head: ACCOUNTING_HEAD, tree: ACCOUNTING_TREE })));
  assert.equal(result.unchanged_outputs, 160); assert.equal(result.inspector_build_calls, 0);
  const accountingBaseline = JSON.parse(authenticatePublicSelection(CURRENT_ROOT, CURRENT_SHA, 'public-key.asc'));
  const historical = JSON.parse(historicalBytes);
  const byteChanges = historical.outputs.filter(row => {
    const old = accountingBaseline.outputs.find(previous => previous.path === row.path);
    assert(old, 'cumulative output path missing');
    return row.sha256 !== old.sha256 || row.bytes !== old.bytes;
  }).map(row => row.path).sort();
  assert.deepEqual(byteChanges, [...ACCOUNTING_OWNED].sort(), 'historical four accounting byte changes');
  const selected = JSON.parse(bytes);
  const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
  const verified = coverage.verify({ commit: MODE_HEAD, repo: coverage.repoSlug(ROOT), worktree: ROOT });
  assert.equal(verified.covered, true, 'protected final14 source authority: ' + verified.reason);
  assert.equal(verified.record.tree, MODE_TREE);
  const original = JSON.parse(read(selected.source.original_result, selected.source.original_result_sha256));
  assert.equal(original.ticket, 'T-49-14'); assert.equal(original.dispatch_id, selected.source.original_dispatch);
  assert.deepEqual(coverage.validateFinalizationEvidence(verified.record).receipt, original.receipt);
  const stream = original.receipt.runtime_evidence.transcript;
  assert.equal(read(stream.path, stream.sha256).length, stream.bytes);
  const ci = JSON.parse(read('/Users/serhii/.local/state/shipyard/phase49-T49-14-installed-mode-ci-admission.json'));
  assert.equal(ci.headSha, MODE_HEAD); assert.equal(ci.status, 'completed'); assert.equal(ci.conclusion, 'success');
  const job = ci.jobs.find(row => row.name === 'test-fast');
  assert(job && job.status === 'completed' && job.conclusion === 'success');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success');
  }
  read('/Users/serhii/.local/state/shipyard/phase49-T49-14-full-ci-success.log',
    'ab76711cf608025ce0f8b03909893b7255be46dc1c71907c40d0cd6b60b29ee1');
  inspectRuntimeConsumers(ROOT);
  assert.deepEqual(read(path.join(ACCOUNTING_ROOT, 'selection.json'), ACCOUNTING_SHA), historicalBytes);
  t.diagnostic('Mode distribution only: exact15-head full CI and actual supported isolated package/bundle admission remain separate trusted-host gates. Original13 failed installation remains historical; no empirical acceptance.');
});

test('fresh completed-accounting selection independently inspects full162/all161 and unchanged157', t => {
  try { fs.accessSync(path.join(ACCOUNTING_ROOT, 'selection.json')); }
  catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    t.skip('HOLD: coordinator fresh selection pending; no build, installation or empirical acceptance');
    return;
  }
  const digest = ACCOUNTING_SHA;
  assert(![CURRENT_SHA, SELECTION_SHA].includes(digest));
  const bytes = authenticatePublicSelection(ACCOUNTING_ROOT, digest, 'public-key.asc');
  const historicalBytes = authenticatePublicSelection(CURRENT_ROOT, CURRENT_SHA, 'public-key.asc');
  const historical = JSON.parse(historicalBytes), selected = JSON.parse(bytes);
  const expected = { selection_sha256: digest, head: ACCOUNTING_HEAD, tree: ACCOUNTING_TREE };
  const result = historicalAccountingRepository(selected, repository => withoutWrites(() =>
    inspectAccountingSuccessor(bytes, expected, repository, path.join(ACCOUNTING_ROOT, 'candidate'), historical)));
  assert.equal(result.unchanged_outputs, 157);
  assert.equal(result.inspector_build_calls, 0);
  assert.equal(result.installed_acceptance, false);
  const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
  const verified = coverage.verify({ commit: ACCOUNTING_HEAD, repo: coverage.repoSlug(ROOT), worktree: ROOT });
  assert.equal(verified.covered, true, 'protected final12 source authority: ' + verified.reason);
  assert.equal(verified.record.tree, ACCOUNTING_TREE);
  const stored = coverage.validateFinalizationEvidence(verified.record);
  const original = JSON.parse(read(selected.source.original_result, selected.source.original_result_sha256));
  assert.equal(original.ticket, 'T-49-12');
  assert.equal(original.dispatch_id, selected.source.original_dispatch);
  assert.deepEqual(stored.receipt, original.receipt, 'original recorder equality');
  const stream = original.receipt.runtime_evidence.transcript;
  assert.equal(read(stream.path, stream.sha256).length, stream.bytes);
  const ci = JSON.parse(read('/Users/serhii/.local/state/shipyard/phase49-T49-12-completed-accounting-ci-admission.json'));
  assert.equal(ci.headSha, ACCOUNTING_HEAD);
  assert.equal(ci.status, 'completed'); assert.equal(ci.conclusion, 'success');
  const job = ci.jobs.find(row => row.name === 'test-fast');
  assert(job && job.status === 'completed' && job.conclusion === 'success');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success');
  }
  read('/Users/serhii/.local/state/shipyard/phase49-T49-12-completed-accounting-ci-success.log',
    'cb89005421c2c770ac4acc2ee1a10fbce9d0d0493a88c6bd0ec85847fef23ca7');
  assert.deepEqual(read(path.join(CURRENT_ROOT, 'selection.json'), CURRENT_SHA), historicalBytes);
  inspectRuntimeConsumers(ROOT);
  t.diagnostic('Fresh distribution inspected; actual supported installation and exact13-head full CI remain separate host gates. No empirical acceptance.');
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
    const originalStat = fs.fstatSync;
    let statCalls = 0;
    try {
      fs.fstatSync = function(...args) {
        const stat = originalStat.apply(this, args);
        if (++statCalls === 2) stat.mtimeMs += 1;
        return stat;
      };
      assert.throws(consume, /input changed during inspection/);
    } finally { fs.fstatSync = originalStat; }


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
    for (const relative of COMPLETE_OWNED.slice(8)) {
      const altered = Buffer.from(JSON.stringify({ ...selection,
        outputs: outputs.filter(row => row.path !== relative) }));
      assert.throws(() => inspect(altered, { ...expected, selection_sha256: sha(altered) }, repository, stage),
        /candidate inventory drift/);
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
    const publicationRoot = path.join(repository, 'plugins/shipyard');
    for (const relative of [...COMPLETE_OWNED.slice(8), 'hooks/hooks.json']) {
      const file = path.join(publicationRoot, relative), original = read(file);
      const publicationMode = physical(file).mode & 0o7777;
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from('mixed generation')]));
      assert.throws(consume, /drift|digest mismatch|incomplete or mixed publication/);
      fs.writeFileSync(file, original);
      fs.chmodSync(file, publicationMode ^ 0o100);
      assert.throws(consume, /drift|incomplete or mixed publication/);
      fs.chmodSync(file, publicationMode);
      fs.renameSync(file, file + '.missing');
      assert.throws(consume);
      fs.renameSync(file + '.missing', file);
    }
    for (const relative of COMPLETE_OWNED.slice(8, 11)) {
      const source = path.join(repository, relative.slice('host/'.length)), original = read(source);
      fs.writeFileSync(source, Buffer.concat([original, Buffer.from('stale canonical input')]));
      assert.throws(consume, /complete canonical inputs changed/);
      fs.writeFileSync(source, original);
    }
    const unselectedOutput = path.join(publicationRoot, 'unselected-output');
    fs.writeFileSync(unselectedOutput, 'not part of the candidate');
    assert.throws(consume, /incomplete or mixed publication/);
    fs.unlinkSync(unselectedOutput);
    const gate = require(path.join(publicationRoot, COMPLETE_OWNED[8]));
    for (const consumer of [gate.verifyCurrentReviews,
      require(path.join(publicationRoot, COMPLETE_OWNED[9])).currentReviewAdmission,
      require(path.join(publicationRoot, COMPLETE_OWNED[10])).currentReviewAdmission]) {
      assert.throws(() => consumer({ pr: 1, getPullRequest: () => ({ number: 1, state: 'OPEN' }) }),
        /live current review PR identity is incomplete/);
    }
    const codex = require(path.join(publicationRoot, OWNED[2]));
    assert.throws(() => codex.validateIntegrationCoverage({ input: {} }, {}),
      error => error.code === 'INVALID_INPUT');
    const claude = require(path.join(publicationRoot, OWNED[5]));
    const request = { schema: claude.REQUEST_SCHEMA, role: 'integrator', worktree: repository, phase: '49' };
    for (const review_contract of ['shipyard.integration-review.v1', 'shipyard.integration-review.v2'])
      assert.equal(claude.parseRequest({ ...request, review_contract }).review_contract, review_contract);
    assert.throws(() => claude.parseRequest({ ...request, review_contract: 'shipyard.integration-review.v999' }),
      error => error.code === 'INVALID_INPUT');
    assert.equal(claude.isPreparedIntegratorContext({}), false);
    inspectRuntimeConsumers(repository);

    const originalStageInventory = inventory(stage, '', true);
    for (const relative of ACCOUNTING_OWNED.slice(0, 2))
      fs.appendFileSync(path.join(repository, relative.slice('host/'.length)), '\n');
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
      const admitted = withoutWrites(() => inspectAccountingSuccessor(distinctBytes, { selection_sha256: sha(distinctBytes),
        head: distinctSelection.source.head, tree: distinctSelection.source.tree }, repository, distinct, selection));
      assert.equal(admitted.unchanged_outputs, 157);
      for (const mutate of [
        value => { value.source = selection.source; },
        value => { value.stage = selection.stage; },
        value => { value.inputs.pop(); },
        value => { value.outputs.pop(); },
        value => { value.outputs.find(row => !ACCOUNTING_OWNED.includes(row.path)).publication_mode ^= 0o100; },
        value => { value.package.digest = selection.package.digest; },
      ]) {
        const altered = structuredClone(distinctSelection); mutate(altered);
        const alteredBytes = Buffer.from(JSON.stringify(altered));
        assert.throws(() => withoutWrites(() => inspectAccountingSuccessor(alteredBytes,
          { selection_sha256: sha(alteredBytes), head: distinctSelection.source.head,
            tree: distinctSelection.source.tree }, repository, distinct, selection)));
      }
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


function packagedRoleFixtures(repository, hostRoot = path.join(repository, 'plugins/shipyard/host/plugins/delivery-pipeline')) {
  const Module = require('node:module');
  const file = path.join(ROOT, 'tests/unit/phase49-current-review-admission.test.cjs');
  const fixtureModule = new Module(file, module);
  fixtureModule.filename = file;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(file));
  const registered = new Map();
  const originalRequire = fixtureModule.require.bind(fixtureModule);
  fixtureModule.require = request => {
    if (request === 'node:test') return { test(name, callback) { registered.set(name, callback); } };
    const prefix = '../../plugins/delivery-pipeline/';
    if (request.startsWith(prefix)) return require(path.join(hostRoot, request.slice(prefix.length)));
    return originalRequire(request);
  };
  const canonicalProducerRoot = "path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts')";
  const packagedProducerRoot = path.join(hostRoot, 'scripts');
  const source = read(file).toString('utf8');
  assert.equal(source.split(canonicalProducerRoot).length, 2, 'original integration producer pin seam changed');
  const packagedSource = source.replace(canonicalProducerRoot, JSON.stringify(packagedProducerRoot));
  fixtureModule._compile(packagedSource +
    '\nmodule.exports = { fixture, successfulReview, currentSubject, consumers };\n', file);
  return { registered, ...fixtureModule.exports };
}

test('packaged role APIs authenticate full and v2 current reviews with original isolated authority', async () => {
  const fixtures = packagedRoleFixtures(ROOT);
  for (const name of [
    'fresh native architecture delta reaches sealer, exact-current lookup and all consumers',
    'fresh integration admission retains its independent role authority',
    'genuine finalized Claude receipts admit full architecture and inline integration at all current consumers',
  ]) {
    const exercise = fixtures.registered.get(name);
    assert.equal(typeof exercise, 'function', 'missing original real-role fixture: ' + name);
    await exercise();
  }
  for (const role of ['arch-review', 'integrator']) await fixtures.fixture(async f => {
    const original = await fixtures.successfulReview(f, role);
    assert.deepEqual(read(original.artifact), original.original);
    assert.equal(original.dispatched.receipt.runtime, 'codex');
    for (const consume of fixtures.consumers) {
      const result = consume(fixtures.currentSubject(f));
      if (role === 'arch-review') assert.equal(result.architecture.ready, true);
      else assert.equal(result.integration.authenticated, true);
    }
  });
});

function packagedBatchFixtures(repository) {
  const Module = require('node:module');
  const file = path.join(ROOT, 'tests/unit/phase49-review-continuation.test.cjs');
  const fixtureModule = new Module(file, module);
  fixtureModule.filename = file; fixtureModule.paths = Module._nodeModulePaths(path.dirname(file));
  const registered = new Map(), originalRequire = fixtureModule.require.bind(fixtureModule);
  fixtureModule.require = request => {
    if (request === 'node:test') return { test(name, callback) { registered.set(name, callback); } };
    const prefix = '../../plugins/delivery-pipeline/';
    if (request.startsWith(prefix)) return require(path.join(repository,
      'plugins/shipyard/host/plugins/delivery-pipeline', request.slice(prefix.length)));
    return originalRequire(request);
  };
  const origin = '0724e437d8ca42d87adb8d3421a15a13edd1ead2';
  const relative = 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs';
  const originalReader = execFileSync('git', ['-C', ROOT, 'show', origin + ':' + relative],
    { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(sha(originalReader), 'beee1e2e6ea746687414b0c05ff87487c66f595ed1e732b33f63098644d4eb2f');
  const historicalPath = 'plugins/shipyard/host/' + relative;
  const historicalOutput = execFileSync('git', ['-C', ROOT, 'show', origin + ':' + historicalPath],
    { maxBuffer: 16 * 1024 * 1024 });
  const historicalMode = execFileSync('git', ['-C', ROOT, 'ls-tree', origin, '--', historicalPath],
    { encoding: 'utf8' });
  assert.match(historicalMode, /^100644 blob [0-9a-f]+\t/,
    'original packaged producer must be a regular non-executable Git blob');
  assert.equal(sha(historicalOutput), 'beee1e2e6ea746687414b0c05ff87487c66f595ed1e732b33f63098644d4eb2f');
  assert.deepEqual(originalReader, historicalOutput,
    'original producer history changed');
  const originalPath = path.join(repository, 'plugins/shipyard/host', relative);
  assert.deepEqual(read(originalPath), read(path.join(repository, relative)),
    'legacy fixture candidate must pin the current packaged producer');
  const resolver = "require.resolve('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs')";
  const originalSource = read(file).toString('utf8');
  assert.ok(originalSource.includes(resolver), 'original candidate source resolver seam is required');
  const source = originalSource.replaceAll(resolver, JSON.stringify(originalPath));
  const seam = 'if (require.main === module) {';
  assert.equal(source.split(seam).length, 2, 'original continuation registration seam changed');
  fixtureModule._compile(source.replace(seam, 'if (true) {'), file);
  return { registered, completedSourceFixture: fixtureModule.exports.completedSourceFixture };
}

test('packaged v3 framed producer and protected continuation preserve original refusal and legacy contracts', async () => {
  const { registered, completedSourceFixture } = packagedBatchFixtures(ROOT);
  for (const name of [
    'v3 one physical output atomically credits two frames and resumes the original UUID',
    'v3 uncredited truncated batch remains in original history and is retried without rereading durable frames',
    'legacy one-turn full read succeeds and unrelated extra turns remain refused',
    'a bare serialized descriptor or observation cannot publish protected authority',
    'v3 typed reviewer resumes the original child UUID with its installed instruction identity',
    'v3 protected arch-review continuation reauthenticates the separate probe association',
    'v3 protected integrator continuation reauthenticates the separate probe association',
    ...['nested truncation', 'outer truncation', 'pending shell', 'surplus nested operation', 'omitted terminal',
      'wrong profile', 'duplicate frame', 'reordered frames', 'overlapping range', 'trailer digest']
      .map(name => 'v3 ' + name + ' grants zero batch credit'),
  ]) {
    const exercise = registered.get(name);
    assert.equal(typeof exercise, 'function', 'missing original batch fixture: ' + name);
    await exercise();
  }
  assert.equal(typeof completedSourceFixture, 'function');
  for (const role of ['arch-review', 'integrator']) {
    await completedSourceFixture(role, false, null, null, true);
    for (const mutation of ['subject-kind', 'source', 'profile', 'roster', 'base'])
      await completedSourceFixture(role, true, mutation);
  }
});

test('packaged secure fixer retains action-only parser and refuses caller launch fields', () => {
  const host = require('../../plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const dispatch = require('../../plugins/shipyard/host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const id = 'dispatch-mv4c0jmr-b408925c-a4b3-439e-9509-1f8b34c00850';
  assert.deepEqual(host.parseRepairActionResumeArguments(['--resume-repair-actions', id,
    '--scope-file', '/tmp/original-scope.json']), { dispatchId: id, scopeFile: '/tmp/original-scope.json' });
  for (const args of [[], ['--resume-repair-actions', '../foreign', '--scope-file', '/tmp/scope.json'],
    ['--resume-repair-actions', id, '--args-file', '/tmp/scope.json'],
    ['--resume-repair-actions', id, '--scope-file', '/tmp/scope.json', '--force-first'],
    ['--resume-repair-actions', 'x'.repeat(161), '--scope-file', '/tmp/scope.json']])
    assert.throws(() => host.parseRepairActionResumeArguments(args), { code: 'INVALID_INPUT' });
  for (const args of [['review-fix', 'T-49-17', '--prompt', 'forged'],
    ['review-fix', 'T-49-17', '--prepared', '{}'], ['review-fix', 'T-49-17', '--model', 'gpt-6.1-sol']])
    assert.throws(() => dispatch.parseBuildArgs(args));
});

test('same-generation packaged fixer authenticates source publication and complete feedback-only actions', () => {
  const names = [
    ...['source', 'no-op', 'escalate'].map(outcome =>
      'canonical builder through original static fixer seals ' + outcome + ' with host custody with four original native progress messages'),
    ...['evidence-symlink', 'evidence-bytes', 'caller-rung', 'self-commit', 'duplicate-completion', 'foreign-native-final']
      .map(mutation => 'original fixer custody refuses ' + mutation),
    'signed fixer publication recovers a lost response without replaying its confirmed push',
    'original feedback action recovers resolve-response-loss without reply replay',
    ...['issue-repost', 'issue-oscillation', 'issue-unknown', 'issue-ambiguous', 'issue-shift'].map(mutation =>
      'known issue history uses the original applied predecessor across reposts: ' + mutation),
    ...[false, true].flatMap(full => ['progress', 'duplicate-contract', 'duplicate-item', 'corrupt-terminal',
      'incomplete-turn', 'failed-turn', 'foreign-session'].map(mutation =>
      'original integration boundary completes and retains one terminal contract: ' + mutation + ' full=' + full)),
  ];
  const exercise = `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const file = path.join(process.argv[1], 'tests/unit', process.argv[3] || 'codex-delivery-host.test.cjs');
    const entry = new Module(file); entry.filename = file;
    entry.paths = Module._nodeModulePaths(path.dirname(file));
    const registered = new Map(), originalRequire = entry.require.bind(entry);
    entry.require = request => request === './assert-harness.cjs'
      ? { assert: require('node:assert'), suite() {}, done() {}, test(name, callback) { registered.set(name, callback); } }
      : originalRequire(request);
    const load = Module._load;
    const canonical = path.join(process.argv[1], 'plugins/delivery-pipeline');
    const packaged = path.join(process.argv[1], 'plugins/shipyard/host/plugins/delivery-pipeline');
    Module._load = function(request, parent, main) {
      const resolved = Module._resolveFilename(request, parent, main);
      return load.call(this, typeof resolved === 'string' && resolved.startsWith(canonical + path.sep)
        ? packaged + resolved.slice(canonical.length) : request, parent, main);
    };
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(target, ...args) {
      const value = originalRead.call(this, target, ...args);
      if (String(target).endsWith('/phase49-incremental-integration.test.cjs') && typeof value === 'string')
        return value.split('../../plugins/delivery-pipeline/').join('../../plugins/shipyard/host/plugins/delivery-pipeline/');
      return value;
    };
    const source = fs.readFileSync(file, 'utf8');
    const prefix = '../../plugins/delivery-pipeline/';
    if (!source.includes(prefix)) throw new Error('original fixer package import seam changed');
    entry._compile(source.split(prefix).join('../../plugins/shipyard/host/plugins/delivery-pipeline/'), file);
    (async () => {
      for (const name of JSON.parse(process.argv[2])) {
        const callback = registered.get(name);
        if (typeof callback !== 'function') throw new Error('missing original fixer fixture: ' + name);
        await callback();
      }
      process.stdout.write('packaged-original-fixer-contracts-pass\\n');
    })().catch(error => { process.stderr.write(error.stack + '\\n'); process.exitCode = 1; });
  `;
  const observed = execFileSync(process.execPath, ['-e', exercise, ROOT, JSON.stringify(names)],
    { timeout: 420000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: 'pipe' });
  assert.match(observed, /packaged-original-fixer-contracts-pass/);
  const roleNames = [
    ...['progress', 'duplicate-contract', 'duplicate-item', 'corrupt-terminal', 'failed-turn',
      'incomplete-turn', 'foreign-session'].map(mutation =>
      'original focused CLI retains progress and rejects invalid terminal results: ' + mutation),
    ...[false, true].map(corrupt => 'current integration excludes foreign catalogue before authority reads: ' + corrupt),
    ...['codex', 'claude'].map(runtime => 'aggregate original subject reconciles retained and legacy ' + runtime),
  ];
  const roleObserved = execFileSync(process.execPath,
    ['-e', exercise, ROOT, JSON.stringify(roleNames), 'role-artifact.test.cjs'],
    { timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: 'pipe' });
  assert.match(roleObserved, /packaged-original-fixer-contracts-pass/);
});

module.exports = { inspectBatchNative, inspectBatchInstalledPhysical, BATCH_ROOT, BATCH_SHA, BATCH_HEAD, BATCH_TREE, authenticateBatchSource, inspectBatchCI, inspectBatchDelta, inspectBatchSuccessor, inspectBatchInstalled, inspectBatchAPIs, BATCH_INPUTS, BATCH_OUTPUTS, inspect, inspectAccountingSuccessor, inspectAccountingInstalled, inspectModeSuccessor, inspectModeInstalled, inventory, read, canonicalInputs, admitSuccessor, OWNED: COMPLETE_OWNED };

const FOCUSED_ROOT = '/Users/serhii/.local/state/shipyard/phase49-selected-package-focused-b51406f524f5';
const FOCUSED_SHA = 'a807ba249697875b7fd94981133044a80a850b5f91640264f3646abe262bbe59';
const FOCUSED_HEAD = 'b51406f524f576178296aee74f602e0805077ee7';
const FOCUSED_TREE = '2ab50ef18f495d4d1b52f4976cce736594f6b781';
const FOCUSED_BASE = '2fda4e9451bd6c34cd1aa5034223540c45b83495';
const FOCUSED_INPUTS = ['codex-arch-review-context', 'codex-delivery-host', 'codex-runtime-host',
  'role-artifact', 'claude-role-host'].map(name => 'plugins/delivery-pipeline/scripts/' + name + '.cjs')
  .concat('plugins/delivery-pipeline/references/arch-review.md');
const FOCUSED_OUTPUTS = FOCUSED_INPUTS.map(relative => 'host/' + relative)
  .concat('.codex-plugin/plugin.json', 'package-build.json');

function inspectFocusedDelta(selected, historical, inputs = FOCUSED_INPUTS, outputs = FOCUSED_OUTPUTS) {
  assert.equal(selected.build_calls, 1); assert.equal(historical.build_calls, 1);
  assert.notEqual(selected.stage, historical.stage, 'historical stage substituted');
  assert.notEqual(selected.source.head, historical.source.head, 'historical source substituted');
  assert.equal(selected.builder_sha256, historical.builder_sha256, 'builder changed');
  const result = {};
  for (const [field, mode, allowed] of [['inputs', 'mode', inputs],
    ['outputs', 'publication_mode', outputs]]) {
    const rows = selected[field], oldRows = historical[field];
    for (const list of [rows, oldRows]) {
      assert(Array.isArray(list) && list.length > 0 && list.length <= 1000);
      assert.equal(new Set(list.map(row => row.path)).size, list.length, 'duplicate inventory credit');
      list.forEach(row => safeRelative(row.path));
    }
    assert.deepEqual(rows.map(row => row.path).sort(), oldRows.map(row => row.path).sort(),
      'complete focused inventory membership changed');
    const previous = new Map(oldRows.map(row => [row.path, row]));
    const changed = [];
    for (const row of rows) {
      const old = previous.get(row.path);
      assert.equal(row[mode], old[mode], 'focused generation mode drift');
      if (row.sha256 !== old.sha256 || row.bytes !== old.bytes) changed.push(row.path);
    }
    assert.deepEqual(changed.filter(relative => !allowed.includes(relative)), [], 'unassigned focused delta');
    result['changed_' + field] = changed.sort();
    result['unchanged_' + field] = rows.length - changed.length;
  }
  assert.deepEqual(result.changed_outputs.filter(relative => relative.startsWith('host/')),
    result.changed_inputs.map(relative => 'host/' + relative).sort(), 'mixed focused generation');
  for (const relative of inputs) {
    const input = selected.inputs.find(row => row.path === relative);
    const output = selected.outputs.find(row => row.path === 'host/' + relative);
    assert(input && output, 'missing focused union member');
    assert.equal(output.sha256, input.sha256); assert.equal(output.publication_mode, input.mode);
    if (input.bytes !== undefined) assert.equal(output.bytes, input.bytes);
  }
  assert.equal(selected.inputs.find(row => row.path === MODE_INPUT).mode, 0o755);
  assert.equal(selected.outputs.find(row => row.path === MODE_OUTPUT).publication_mode, 0o755);
  return result;
}

function inspectFocusedPublication(bytes, repository = ROOT) {
  assert.equal(sha(bytes), FOCUSED_SHA, 'foreign focused selection');
  const selected = JSON.parse(bytes);
  assert.equal(selected.source.head, FOCUSED_HEAD); assert.equal(selected.source.tree, FOCUSED_TREE);
  assert.equal(selected.stage, path.join(FOCUSED_ROOT, 'candidate'));
  const historicalBytes = read(path.join(BATCH_ROOT, 'selection.json'), BATCH_SHA);
  const historical = JSON.parse(historicalBytes);
  assert.deepEqual(inventory(historical.stage, '', true), historical.outputs.map(row => ({
    path: row.path, sha256: row.sha256, bytes: row.bytes,
    mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })), 'immutable original17 drift');
  const delta = inspectFocusedDelta(selected, historical);
  const observed = inspect(bytes, { selection_sha256: FOCUSED_SHA, head: FOCUSED_HEAD,
    tree: FOCUSED_TREE }, repository, selected.stage, FOCUSED_OUTPUTS);
  return { ...observed, ...delta, installed_acceptance: false, empirical_acceptance: false };
}

async function inspectFocusedConsumers(hostRoot) {
  const fixtures = packagedRoleFixtures(ROOT, hostRoot);
  const names = [
    'focused original inline judgment reaches finish, archive lookup and the existing live gate without reads',
    'focused incomplete original review retains limitations and findings but cannot grant current conformance',
    'codex focused overflow reaches original finish, archive and live gate without read proof',
    'claude focused overflow reaches original finish, archive and live gate without read proof',
    'Claude original incomplete focused judgment is archived without granting conformance',
    ...['forged contract', 'wrong repository', 'wrong membership', 'wrong base', 'wrong launch',
      'malformed completeness', 'contradictory complete'].map(name => 'focused original completion refuses ' + name),
    'fresh integration admission retains its independent role authority',
  ];
  for (const name of names) {
    const exercise = fixtures.registered.get(name);
    assert.equal(typeof exercise, 'function', 'missing focused production fixture: ' + name);
    await exercise();
  }
  return { fixture_cases: names.length, empirical_acceptance: false };
}

function inspectFocusedInstalled(identity, authenticated, bytes, expected, authenticate) {
  return inspectFocusedInstalledGeneration(identity, authenticated, bytes, expected, authenticate, false);
}

function inspectFocusedInstalledGeneration(identity, authenticated, bytes, expected, authenticate, current) {
  const generation = current ? CURRENT_REVIEW : { root: FOCUSED_ROOT, sha256: FOCUSED_SHA, head: FOCUSED_HEAD, tree: FOCUSED_TREE };
  assert.equal(typeof authenticate, 'function', 'protected focused installed verifier missing');
  const proof = authenticate(expected);
  assert(proof && proof.authenticated === true, 'focused installed authority missing');
  assert.deepEqual(proof.expected, expected); assert.deepEqual(proof.identity, identity);
  assert.deepEqual(proof.binding, authenticated);
  assert.equal(expected.selection_sha256, generation.sha256); assert.equal(expected.selection_root, generation.root);
  assert.equal(expected.source_head, generation.head); assert.equal(expected.source_tree, generation.tree);
  assert.equal(expected.runtime_root, identity.runtime_root, 'same-version cache substitution');
  if (current) {
    assert.equal(typeof expected.runtime_root, 'string'); assert(path.isAbsolute(expected.runtime_root));
    for (const field of ['publication_head', 'publication_tree']) assert.match(expected[field], /^[a-f0-9]{40}$/);
    assert.notEqual(expected.publication_head, generation.head, 'source/publication identity collapsed');
    assert.match(proof.publication_dispatch, /^dispatch-[a-zA-Z0-9-]+$/);
    for (const field of ['source_native', 'publication_native', 'publication_result']) {
      assert(proof[field] && typeof proof[field].path === 'string', 'missing original ' + field);
      if (field === 'publication_result') assert.match(proof[field].sha256, /^[a-f0-9]{64}$/);
    }
    inspectBatchCI(proof.source_ci, generation.head);
    inspectBatchCI(proof.ci, expected.publication_head);
  }
  const signed = authenticatePublicSelection(generation.root, generation.sha256, 'public-key.asc');
  assert.deepEqual(bytes, signed);
  const selected = JSON.parse(bytes);
  authenticateBatchSource(selected, current ? 'T-49-22' : 'T-49-20', generation.head, generation.tree);
  inspectBatchCI(proof.source_ci, generation.head); inspectBatchCI(proof.ci, expected.publication_head);
  assert.match(expected.publication_head, /^[a-f0-9]{40}$/);
  assert.match(expected.publication_tree, /^[a-f0-9]{40}$/);
  const publicationReceipt = authenticateBatchSource({ ...selected, source: { ...selected.source,
    head: expected.publication_head, tree: expected.publication_tree,
    original_result: proof.publication_result.path, original_result_sha256: proof.publication_result.sha256,
    original_dispatch: proof.publication_dispatch } }, current ? 'T-49-23' : 'T-49-21', expected.publication_head, expected.publication_tree);
  inspectBatchNative(publicationReceipt, proof.publication_native.path);
  if (current) {
    assert.equal(proof.publication_worktree, inspectCurrentReviewCustody(bytes).publication_worktree,
      'foreign publication worktree');
    assert.notEqual(expected.publication_head, generation.head, 'source/publication identity collapsed');
    const sourceReceipt = authenticateBatchSource(selected, 'T-49-22', generation.head, generation.tree);
    inspectBatchNative(sourceReceipt, proof.source_native.path);
    assert.equal(publicationReceipt.policy_hash, sourceReceipt.policy_hash);
  }
  assert.equal(identity.source_head, expected.publication_head); assert.equal(identity.source_tree, expected.publication_tree);
  assert.equal(authenticated.identity.head, expected.publication_head);
  assert.equal(authenticated.identity.tree, expected.publication_tree);
  assert.deepEqual(authenticated.binding.outputs, selected.outputs);
  assert.equal(authenticated.binding.version, selected.package.version);
  assert.equal(authenticated.binding.package_sha256, selected.package.digest);
  equalInputs(selected.inputs, authenticated.binding.source.identities);
  const published = current ? inspectCurrentReviewPublication(bytes, proof.publication_worktree) : inspectFocusedPublication(bytes,
    path.join(path.dirname(selected.source.worktree), 'T-49-21'));
  const observed = require('../smoke/phase47-runtime-acceptance.cjs').inspectInstalled(identity, authenticated);
  const physicalIdentity = inspectBatchInstalledPhysical(identity, selected, proof);
  const generator = require('../../scripts/gen-codex-shipyard.cjs');
  const converter = require(proof.converter.path);
  const raw = read(path.join(identity.host_root, 'references/arch-review.md')).toString('utf8');
  const body = generator.shipyardRewrites(converter.convertClaudeToCodexMarkdown(raw), identity.host_root);
  const variants = generator.codexStaticVariants(proof.phase).filter(variant => variant.role === 'arch-review');
  assert(variants.length > 0, 'architecture variants missing');
  assert.equal(proof.architecture_agents.length, variants.length, 'incomplete architecture variant inventory');
  const toml = value => JSON.stringify(String(value));
  const multiline = value => {
    if (value.includes("'''")) return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    return "'''\n" + value + "\n'''";
  };
  const policy = require(path.join(identity.host_root, 'scripts/model-policy.cjs'));
  for (const variant of variants) {
    const reference = proof.architecture_agents.find(row => path.basename(row.path) === variant.file);
    assert(reference && reference.path.startsWith(identity.runtime_root + path.sep), 'foreign architecture agent');
    assert.equal(physical(reference.path).mode & 0o7777, 0o644, 'installed architecture agent mode drift');
    const heading = raw.match(/^#\s+(.+)$/m);
    const description = (heading ? heading[1].trim() : raw.split('\n').map(line => line.trim())
      .find(Boolean).replace(/[`*_#>]/g, '').slice(0, 160)) + ' (' + variant.rung + ')';
    const pins = { id: policy.POLICY.id, version: policy.POLICY_VERSION, hash: policy.POLICY_HASH,
      runtime: 'codex', role: variant.role, rung: variant.rung };
    const content = Object.entries(pins).map(([key, value]) => '# shipyard-policy-' + key + ' = ' + toml(value) + '\n').join('')
      + 'name = ' + toml(variant.file.replace(/\.toml$/, '')) + '\n'
      + 'description = ' + toml(description) + '\n' + 'sandbox_mode = ' + toml(variant.sandbox) + '\n'
      + 'model = ' + toml(variant.model) + '\n' + 'model_reasoning_effort = ' + toml(variant.effort) + '\n'
      + 'developer_instructions = ' + multiline(body) + '\n';
    assert.equal(read(reference.path, reference.sha256).toString('utf8'), content, 'installed focused role drift');
  }
  read(proof.converter.path, proof.converter.sha256);
  return { ...published, ...observed, ...physicalIdentity, installed_acceptance: true, empirical_acceptance: false };
}

module.exports = { ...module.exports, inspectFocusedDelta, inspectFocusedPublication, inspectFocusedConsumers,
  inspectFocusedInstalled, FOCUSED_ROOT, FOCUSED_SHA, FOCUSED_HEAD, FOCUSED_TREE, FOCUSED_INPUTS, FOCUSED_OUTPUTS };

if (require.main === module) {
  test('focused generation admits only the complete source/reference union and derived metadata', () => {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'focused-publication-fixture-')));
    try {
    const selectedRoot = path.join(temporary, 'selected');
    const historicalRoot = path.join(temporary, 'historical');
    for (const root of [selectedRoot, historicalRoot]) {
      for (const directory of CANONICAL_ROOTS)
        fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
      fs.cpSync(path.join(ROOT, 'plugins/shipyard'), path.join(root, 'package'), { recursive: true });
      for (const relative of FOCUSED_INPUTS) {
        const input = path.join(root, relative), output = path.join(root, 'package/host', relative);
        if (root === historicalRoot) fs.appendFileSync(input, '\nfixture predecessor: ' + relative);
        fs.copyFileSync(input, output);
        fs.chmodSync(output, fs.statSync(input).mode & 0o7777);
      }
      if (root === historicalRoot)
        for (const relative of ['.codex-plugin/plugin.json', 'package-build.json'])
          fs.appendFileSync(path.join(root, 'package', relative), '\nfixture predecessor');
    }
    const selection = root => ({ source: { head: path.basename(root) }, stage: root,
      build_calls: 1, builder_sha256: sha(read(path.join(ROOT, 'scripts/package-shipyard-codex.cjs'))),
      inputs: CANONICAL_ROOTS.flatMap(directory => inventory(path.join(root, directory))
        .map(row => ({ ...row, path: directory + '/' + row.path })))
        .sort((a, b) => a.path.localeCompare(b.path)),
      outputs: inventory(path.join(root, 'package')).map(row => ({ ...row, publication_mode: row.mode })) });
    const selected = selection(selectedRoot), historical = selection(historicalRoot);
    const observed = inspectFocusedDelta(selected, historical);
    assert.equal(observed.unchanged_inputs, selected.inputs.length - observed.changed_inputs.length);
    assert.equal(observed.unchanged_outputs, selected.outputs.length - observed.changed_outputs.length);
    for (const mutate of [value => { value.inputs.pop(); }, value => { value.outputs.pop(); },
      value => { value.outputs[0].publication_mode ^= 0o100; },
      value => { value.outputs.find(row => !FOCUSED_OUTPUTS.includes(row.path)).sha256 = '0'.repeat(64); },
      value => { value.outputs.find(row => !FOCUSED_OUTPUTS.includes(row.path)).bytes++; },
      value => { value.inputs.push({ ...value.inputs[0], path: 'unassigned-input' }); },
      value => { value.outputs.push({ ...value.outputs[0], path: 'unassigned-output' }); },
      value => { value.inputs.push(value.inputs[0]); },
      value => { value.outputs.push(value.outputs[0]); },
      value => { value.inputs[0].mode ^= 0o100; }, value => { value.stage = historical.stage; },
      value => { value.build_calls = 2; }, value => { value.builder_sha256 = '0'.repeat(64); },
      value => { value.outputs.find(row => row.path === 'host/' + FOCUSED_INPUTS[0]).sha256 = '0'.repeat(64); }]) {
      const altered = structuredClone(selected); mutate(altered);
      assert.throws(() => inspectFocusedDelta(altered, historical));
    }
    for (const relative of [FOCUSED_INPUTS[0], 'package/host/' + FOCUSED_INPUTS[0]])
      fs.copyFileSync(path.join(historicalRoot, relative), path.join(selectedRoot, relative));
    const unchanged = selection(selectedRoot);
    assert.doesNotThrow(() => inspectFocusedDelta(unchanged, historical));
    assert.deepEqual(observed.changed_inputs, [...FOCUSED_INPUTS].sort());
    assert.deepEqual(observed.changed_outputs, [...FOCUSED_OUTPUTS].sort());
    // macOS may expose /tmp as an alias for /private/tmp. Resolve only our new
    // fixture root; inventory must still reject symlinks in inspected payloads.
      const fixturePackage = path.join(temporary, 'package');
      fs.cpSync(path.join(ROOT, 'plugins/shipyard'), fixturePackage, { recursive: true });
      const expected = inventory(fixturePackage);
      const unchangedPhysical = () => assert.deepEqual(inventory(fixturePackage), expected);
      unchangedPhysical();
      const member = path.join(fixturePackage, FOCUSED_OUTPUTS[0]);
      const original = fs.readFileSync(member), mode = fs.statSync(member).mode & 0o7777;
      fs.appendFileSync(member, '\nfixture tamper');
      assert.throws(unchangedPhysical); fs.writeFileSync(member, original);
      fs.chmodSync(member, mode ^ 0o100);
      assert.throws(unchangedPhysical); fs.chmodSync(member, mode);
      const extra = path.join(fixturePackage, 'unassigned-output');
      fs.writeFileSync(extra, 'fixture'); assert.throws(unchangedPhysical); fs.unlinkSync(extra);
      fs.unlinkSync(member); assert.throws(unchangedPhysical);
      fs.symlinkSync(path.join(ROOT, 'plugins/shipyard', FOCUSED_OUTPUTS[0]), member);
      assert.throws(unchangedPhysical);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  test('focused original signed source and stage remain distinct from publication and installation', async t => {
    try { fs.accessSync(path.join(FOCUSED_ROOT, 'selection.json')); }
    catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      t.skip('HOLD: original focused host custody unavailable; no native or installed acceptance');
      return;
    }
    const bytes = authenticatePublicSelection(FOCUSED_ROOT, FOCUSED_SHA, 'public-key.asc');
    const selected = JSON.parse(bytes);
    const receipt = authenticateBatchSource(selected, 'T-49-20', FOCUSED_HEAD, FOCUSED_TREE);
    inspectBatchNative(receipt, '/Users/serhii/.codex/sessions/2026/10/14/' + receipt.runtime_evidence.native_session_evidence.file);
    const state = '/Users/serhii/.local/state/shipyard/';
    const launch = JSON.parse(read(state + 'phase49-focused-review-T49-21-actual-clean-native-before-stage.json',
      'd0de77d8adf11120e9f2e236fc3f6b9e4fc73658a81c488b31227617a86fbdc7'));
    assert.equal(launch.ticket, 'T-49-21'); assert.equal(launch.role, 'executor');
    assert.equal(path.basename(selected.source.worktree), 'T-49-20');
    const publicationWorktree = path.join(path.dirname(selected.source.worktree), launch.ticket);
    assert.equal(launch.worktree, publicationWorktree);
    const commonRepository = worktree => fs.realpathSync(execFileSync('git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: 10000 }).trim());
    assert.equal(commonRepository(publicationWorktree), commonRepository(selected.source.worktree));
    assert.equal(commonRepository(publicationWorktree), commonRepository(ROOT));
    assert.equal(launch.source_head, FOCUSED_HEAD);
    assert.equal(launch.baseline_head, FOCUSED_BASE); assert.equal(launch.baseline_tree, FOCUSED_TREE);
    assert.equal(launch.tracked_clean, true); assert(Number.isSafeInteger(launch.native_process_id));
    assert.equal(sha(Buffer.from(launch.observed_command)), launch.observed_command_sha256);
    const built = JSON.parse(read(state + 'phase49-focused-review-T49-21-once-build-result.json',
      '5a6d671540cabd978990cc71b9ffc782485c333b664c180de155cd15f2a85c99'));
    assert.equal(built.root, FOCUSED_ROOT); assert.equal(built.selection_sha256, FOCUSED_SHA);
    assert.equal(built.build_calls, 1); assert.equal(built.published, 0);
    assert.equal(built.source_head, FOCUSED_HEAD); assert.equal(built.source_tree, FOCUSED_TREE);
    assert.equal(built.outputs, selected.outputs.length);

    const ci = JSON.parse(read(state + 'phase49-focused-review-T49-20-b51406f-current-green-ci-admission.json'));
    const custody = JSON.parse(read(state + 'phase49-focused-review-T49-20-b51406f-original-success-ci-custody.json'));
    ci.original_full_log = { path: state + 'phase49-focused-review-T49-20-b51406f-original-success-full-ci.log',
      sha256: custody.log_sha256, bytes: custody.log_bytes };
    inspectBatchCI(ci, FOCUSED_HEAD);
    const merge = JSON.parse(read(state + 'phase49-focused-review-T49-20-474-approved-actual-merge-proof.json'));
    assert.equal(merge.state, 'MERGED'); assert.equal(merge.headRefOid, FOCUSED_HEAD);
    assert.equal(merge.mergeCommit.oid, FOCUSED_BASE);
    assert.equal(execFileSync('git', ['-C', ROOT, 'rev-parse', FOCUSED_BASE + '^{tree}'], { encoding: 'utf8' }).trim(), FOCUSED_TREE);
    assert.equal(inspectFocusedPublication(bytes, publicationWorktree).empirical_acceptance, false);
    await inspectFocusedConsumers(path.join(FOCUSED_ROOT, 'candidate/host/plugins/delivery-pipeline'));
  });

  test('packaged focused producers reach original complete/incomplete and current consumers without read proof', async () => {
    await inspectFocusedConsumers(path.join(ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline'));
  });

  test('focused installed admission refuses absent, forged and foreign-generation authority', () => {
    // Rejected before external custody access; these bytes confer no selection authority.
    const bytes = Buffer.from('{}');
    const expected = { selection_sha256: FOCUSED_SHA, selection_root: FOCUSED_ROOT,
      source_head: FOCUSED_HEAD, source_tree: FOCUSED_TREE, runtime_root: '/private/tmp/focused-isolated' };
    assert.throws(() => inspectFocusedInstalled({}, {}, bytes, expected), /protected focused installed verifier/);
    assert.throws(() => inspectFocusedInstalled({}, {}, bytes, expected, () => ({ authenticated: false })), /authority missing/);
    const stale = { ...expected, selection_sha256: BATCH_SHA };
    assert.throws(() => inspectFocusedInstalled({}, {}, bytes, stale,
      () => ({ authenticated: true, expected: stale, identity: {}, binding: {} })));
  });
}

// A separately pinned correctness successor; historical focused identities stay immutable.
const CURRENT_REVIEW = Object.freeze({
  root: '/Users/serhii/.local/state/shipyard/phase49-selected-package-current-review-1b106e733931',
  sha256: '15994b3dd54929d627f0fcf9c10c3757dc04f96be6e60d8639eb0eb485f6702a',
  head: '1b106e7339319f7dd31a1d3412ab6fd6002b195b',
  tree: '74a2fe91561810eeb0e74001f8889768eb8c6189',
  squash: '92e263f69fdb60450a1cfad2e97d33cb87f33f05',
});
const CURRENT_REVIEW_INPUTS = ['role-artifact', 'codex-delivery-host']
  .map(name => 'plugins/delivery-pipeline/scripts/' + name + '.cjs');
const CURRENT_REVIEW_OUTPUTS = CURRENT_REVIEW_INPUTS.map(relative => 'host/' + relative)
  .concat(['.codex-plugin/plugin.json', 'package-build.json']);

function inspectCurrentReviewDelta(selected, historical) {
  assert.equal(selected.source.head, CURRENT_REVIEW.head);
  assert.equal(selected.source.tree, CURRENT_REVIEW.tree);
  assert.equal(historical.source.head, FOCUSED_HEAD);
  assert.equal(historical.source.tree, FOCUSED_TREE);
  return inspectFocusedDelta(selected, historical, CURRENT_REVIEW_INPUTS, CURRENT_REVIEW_OUTPUTS);
}

function inspectCurrentReviewPublication(bytes, repository) {
  assert.equal(sha(bytes), CURRENT_REVIEW.sha256, 'foreign current-review selection');
  assert.equal(typeof repository, 'string', 'authenticated original publication checkout required');
  const selected = JSON.parse(bytes);
  assert.equal(repository, path.join(path.dirname(selected.source.worktree), 'T-49-23'),
    'foreign original publication checkout');
  assert.equal(selected.stage, path.join(CURRENT_REVIEW.root, 'candidate'));
  const historical = JSON.parse(read(path.join(FOCUSED_ROOT, 'selection.json'), FOCUSED_SHA));
  for (const [root, digest] of [[FOCUSED_ROOT, FOCUSED_SHA], [BATCH_ROOT, BATCH_SHA]]) {
    const original = JSON.parse(read(path.join(root, 'selection.json'), digest));
    assert.deepEqual(inventory(original.stage, '', true), original.outputs.map(row => ({
      path: row.path, sha256: row.sha256, bytes: row.bytes,
      mode: row.publication_mode === 0o755 ? 0o500 : 0o400 })), 'immutable historical stage drift');
  }
  const delta = inspectCurrentReviewDelta(selected, historical);
  const observed = inspect(bytes, { selection_sha256: CURRENT_REVIEW.sha256,
    head: CURRENT_REVIEW.head, tree: CURRENT_REVIEW.tree }, repository, selected.stage, CURRENT_REVIEW_OUTPUTS);
  return { ...observed, ...delta, installed_acceptance: false, empirical_acceptance: false };
}

function inspectCurrentReviewCustody(bytes) {
  assert.equal(sha(bytes), CURRENT_REVIEW.sha256);
  const selected = JSON.parse(bytes), state = '/Users/serhii/.local/state/shipyard/';
  const receipt = authenticateBatchSource(selected, 'T-49-22', CURRENT_REVIEW.head, CURRENT_REVIEW.tree);
  inspectBatchNative(receipt, '/Users/serhii/.codex/sessions/2026/10/15/'
    + receipt.runtime_evidence.native_session_evidence.file);
  inspectBatchCI(JSON.parse(read(state + 'phase49-T22-1b106e7-current-green-ci-admission.json',
    'b67d0648c18e1c553f8cdec58c4488ec8328c634f70ce06d6be4b0972c7dbdb5')), CURRENT_REVIEW.head);
  const squash = selected.original_squash;
  const original = JSON.parse(read(squash.proof_path, squash.proof_sha256));
  assert.equal(original.state, 'MERGED'); assert.equal(original.headRefOid, CURRENT_REVIEW.head);
  assert.equal(original.mergeCommit.oid, CURRENT_REVIEW.squash);
  assert.equal(execFileSync('git', ['-C', ROOT, 'rev-parse', CURRENT_REVIEW.squash + '^{tree}'],
    { encoding: 'utf8' }).trim(), CURRENT_REVIEW.tree);
  const launch = JSON.parse(read(state + 'phase49-T23-actual-clean-native-before-stage.json',
    'fa3c92b0d5e94900eaf84c9b38d0645b4ab5a91dc5b2b205a177947dda317729'));
  assert.equal(launch.ticket, 'T-49-23'); assert.equal(launch.role, 'executor');
  assert.equal(path.basename(selected.source.worktree), 'T-49-22');
  const publicationWorktree = path.join(path.dirname(selected.source.worktree), launch.ticket);
  assert.equal(launch.worktree, publicationWorktree);
  const commonRepository = worktree => fs.realpathSync(execFileSync('git',
    ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10000 }).trim());
  assert.equal(commonRepository(publicationWorktree), commonRepository(selected.source.worktree));
  assert.equal(commonRepository(publicationWorktree), commonRepository(ROOT));
  assert.equal(launch.tracked_clean, true);
  assert.equal(launch.source_head, CURRENT_REVIEW.head);
  assert.equal(launch.baseline_head, CURRENT_REVIEW.squash); assert.equal(launch.baseline_tree, CURRENT_REVIEW.tree);
  assert(Number.isSafeInteger(launch.native_process_id));
  assert.equal(sha(Buffer.from(launch.observed_command + '\n')), launch.observed_command_sha256);
  const built = JSON.parse(read(state + 'phase49-T23-original-once-stage-result.json',
    'aac187b5f628e36d0a84eb375e09ea2c8900018904973678b4465e1aef25122a'));
  assert.equal(built.root, CURRENT_REVIEW.root); assert.equal(built.selection_sha256, CURRENT_REVIEW.sha256);
  assert.equal(built.source_head, CURRENT_REVIEW.head); assert.equal(built.source_tree, CURRENT_REVIEW.tree);
  assert.equal(built.build_calls, 1); assert.equal(built.published, 0);
  assert.equal(built.outputs, selected.outputs.length);
  return { publication_worktree: publicationWorktree, installed_acceptance: false, empirical_acceptance: false };
}

function inspectCurrentReviewInstalled(identity, authenticated, bytes, expected, authenticate) {
  // Authenticate the original generation and clean launch independently of Source23.
  assert.equal(typeof authenticate, 'function', 'protected current-review installed verifier missing');
  assert.equal(expected.selection_sha256, CURRENT_REVIEW.sha256, 'old installed generation');
  assert.equal(expected.selection_root, CURRENT_REVIEW.root, 'foreign installed generation');
  const result = inspectFocusedInstalledGeneration(identity, authenticated, bytes, expected, authenticate, true);
  inspectCurrentReviewCustody(bytes);
  return { ...result, installed_acceptance: true, empirical_acceptance: false,
    native_experiment_counters: null, counters_reason: 'Deferred experiments were not performed.' };
}

module.exports = { ...module.exports, CURRENT_REVIEW, CURRENT_REVIEW_INPUTS, CURRENT_REVIEW_OUTPUTS,
  inspectCurrentReviewDelta, inspectCurrentReviewPublication, inspectCurrentReviewCustody, inspectCurrentReviewInstalled };

if (require.main === module) {
  test('current-review successor rejects old installed proof and unavailable authority before physical admission', () => {
    const expected = { selection_sha256: CURRENT_REVIEW.sha256, selection_root: CURRENT_REVIEW.root,
      source_head: CURRENT_REVIEW.head, source_tree: CURRENT_REVIEW.tree };
    assert.throws(() => inspectCurrentReviewInstalled({}, {}, Buffer.from('{}'), expected), /protected/);
    for (const proof of [null, { authenticated: false }])
      assert.throws(() => inspectCurrentReviewInstalled({}, {}, Buffer.from('{}'), expected, () => proof), /authority/);
    for (const key of ['selection_sha256', 'selection_root', 'source_head', 'source_tree']) {
      const stale = { ...expected, [key]: key.endsWith('root') ? FOCUSED_ROOT : FOCUSED_SHA };
      assert.throws(() => inspectCurrentReviewInstalled({}, {}, Buffer.from('{}'), stale,
        () => ({ authenticated: true, expected: stale, identity: {}, binding: {} })));
    }
  });

  test('current-review original stage and complete candidate retain separate source and publication custody', t => {
    try { fs.accessSync(path.join(CURRENT_REVIEW.root, 'selection.json')); }
    catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      t.skip('HOLD: actual current-review custody unavailable; fixtures grant no installed acceptance'); return;
    }
    const bytes = authenticatePublicSelection(CURRENT_REVIEW.root, CURRENT_REVIEW.sha256, 'public-key.asc');
    const custody = inspectCurrentReviewCustody(bytes);
    assert.notEqual(custody.publication_worktree, ROOT);
    const observed = inspectCurrentReviewPublication(bytes, custody.publication_worktree);
    assert.throws(() => inspectCurrentReviewPublication(bytes, ROOT), /publication checkout/);
    assert.deepEqual(observed.changed_inputs, [...CURRENT_REVIEW_INPUTS].sort());
    assert.deepEqual(observed.changed_outputs, [...CURRENT_REVIEW_OUTPUTS].sort());
    assert.equal(observed.installed_acceptance, false);
    const selected = JSON.parse(bytes);
    const historical = JSON.parse(read(path.join(FOCUSED_ROOT, 'selection.json'), FOCUSED_SHA));
    for (const mutate of [
      value => value.inputs.pop(), value => value.outputs.push(value.outputs[0]),
      value => value.build_calls++, value => { value.stage = historical.stage; },
      value => { value.outputs.find(row => !CURRENT_REVIEW_OUTPUTS.includes(row.path)).sha256 = '0'.repeat(64); },
      value => { value.inputs.find(row => !CURRENT_REVIEW_INPUTS.includes(row.path)).mode ^= 0o111; },
      value => { value.outputs.find(row => row.path === 'host/' + CURRENT_REVIEW_INPUTS[0]).sha256 = '0'.repeat(64); },
    ]) {
      const altered = structuredClone(selected); mutate(altered);
      assert.throws(() => inspectCurrentReviewDelta(altered, historical));
    }
  });
}

if (require.main === module) test('portable correctness successor bounds complete physical inventories without production custody', () => {
  const temporary = temporaryDirectory('current-review-delta-fixture-');
  try {
    const roots = ['current', 'previous'].map(name => path.join(temporary, name));
    for (const root of roots) {
      for (const directory of CANONICAL_ROOTS)
        fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
      fs.cpSync(path.join(ROOT, 'plugins/shipyard'), path.join(root, 'package'), { recursive: true });
      for (const relative of CURRENT_REVIEW_INPUTS) {
        const input = path.join(root, relative), output = path.join(root, 'package/host', relative);
        if (root === roots[1]) fs.appendFileSync(input, '\n// fixture-only predecessor\n');
        fs.copyFileSync(input, output); fs.chmodSync(output, physical(input).mode & 0o7777);
      }
      if (root === roots[1]) for (const relative of ['.codex-plugin/plugin.json', 'package-build.json'])
        fs.appendFileSync(path.join(root, 'package', relative), '\nfixture-only predecessor');
    }
    const selection = (root, head, tree) => ({ source: { head, tree }, stage: root, build_calls: 1,
      builder_sha256: sha(read(path.join(ROOT, 'scripts/package-shipyard-codex.cjs'))),
      inputs: CANONICAL_ROOTS.flatMap(directory => inventory(path.join(root, directory))
        .map(row => ({ ...row, path: directory + '/' + row.path }))),
      outputs: inventory(path.join(root, 'package')).map(row => ({ ...row, publication_mode: row.mode })) });
    const selected = selection(roots[0], CURRENT_REVIEW.head, CURRENT_REVIEW.tree);
    const historical = selection(roots[1], FOCUSED_HEAD, FOCUSED_TREE);
    const result = inspectCurrentReviewDelta(selected, historical);
    assert.deepEqual(result.changed_inputs, [...CURRENT_REVIEW_INPUTS].sort());
    assert.deepEqual(result.changed_outputs, [...CURRENT_REVIEW_OUTPUTS].sort());
    assert.equal(result.unchanged_inputs, selected.inputs.length - 2);
    assert.equal(result.unchanged_outputs, selected.outputs.length - 4);
    for (const mutate of [value => value.inputs.pop(), value => value.outputs.pop(),
      value => value.outputs.push(value.outputs[0]), value => { value.build_calls = 2; },
      value => { value.outputs[0].publication_mode ^= 0o111; },
      value => { value.inputs.find(row => !CURRENT_REVIEW_INPUTS.includes(row.path)).sha256 = '0'.repeat(64); },
      value => { value.outputs.find(row => !CURRENT_REVIEW_OUTPUTS.includes(row.path)).bytes++; },
      value => { value.outputs.find(row => row.path === 'host/' + CURRENT_REVIEW_INPUTS[0]).bytes++; },
    ]) {
      const altered = structuredClone(selected); mutate(altered);
      assert.throws(() => inspectCurrentReviewDelta(altered, historical));
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

if (require.main === module) test('successor installed contract refuses changed roots and missing original native or current CI custody', () => {
  const temporary = temporaryDirectory('current-review-installed-refusals-');
  try {
    const file = path.join(temporary, 'fixture-ci.log'), raw = Buffer.from('fixture only; no actual installed acceptance\n');
    fs.writeFileSync(file, raw);
    const expected = { selection_sha256: CURRENT_REVIEW.sha256, selection_root: CURRENT_REVIEW.root,
      source_head: CURRENT_REVIEW.head, source_tree: CURRENT_REVIEW.tree,
      publication_head: 'a'.repeat(40), publication_tree: 'b'.repeat(40), runtime_root: temporary };
    const identity = { runtime_root: temporary }, binding = {};
    const ci = head => ({ headSha: head, status: 'completed', conclusion: 'success',
      original_full_log: { path: file, sha256: sha(raw), bytes: raw.length }, jobs: [{ name: 'test-fast',
        status: 'completed', conclusion: 'success', steps: ['publish gate', 'runtime digest trailer', 'make test-fast']
          .map(name => ({ name, status: 'completed', conclusion: 'success' })) }] });
    const original = { authenticated: true, expected, identity, binding,
      publication_dispatch: 'dispatch-fixture-only', source_native: { path: '/fixture-source' },
      publication_native: { path: '/fixture-publication' }, publication_result: { path: '/fixture-result', sha256: 'c'.repeat(64) },
      source_ci: ci(expected.source_head), ci: ci(expected.publication_head) };
    for (const mutate of [proof => { delete proof.source_native; }, proof => { delete proof.publication_native; },
      proof => { delete proof.publication_result; }, proof => { delete proof.source_ci; }, proof => { delete proof.ci; },
      proof => { proof.source_ci.headSha = FOCUSED_HEAD; }, proof => { proof.ci.status = 'in_progress'; },
      proof => { proof.ci.jobs[0].steps[2].conclusion = 'skipped'; },
      proof => { proof.source_ci.original_full_log.sha256 = '0'.repeat(64); },
    ]) {
      const proof = structuredClone(original); mutate(proof);
      assert.throws(() => inspectCurrentReviewInstalled(identity, binding, Buffer.from('{}'), expected, () => proof));
    }
    const changed = { ...expected, runtime_root: path.join(temporary, 'same-version-cache') };
    assert.throws(() => inspectCurrentReviewInstalled(identity, binding, Buffer.from('{}'), changed,
      () => ({ ...original, expected: changed })), /cache substitution/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
