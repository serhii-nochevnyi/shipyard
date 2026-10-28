'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { admit, run, evidence, readEvidence } = require('../../plugins/delivery-pipeline/scripts/host-verification.cjs');

function fixtures(name, names, end) {
  const filename = path.join(__dirname, name), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  const original = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === 'node:test' ? { test() {}, describe() {} } : original.call(this, name, ...args);
    };
    const source = fs.readFileSync(filename, 'utf8');
    loaded._compile((end ? source.slice(0, source.indexOf(end)) : source)
      + '\nmodule.exports = { ' + names + ' };', filename);
  } finally { Module._load = original; }
  return loaded.exports;
}

const codex = fixtures('phase53-codex-integration.test.cjs',
  'publicIntegrationFixture, semanticFixture, supportedPartitionCaller, coldCurrent, contract');
const claude = fixtures('phase53-claude-review.test.cjs', 'nativeFixture, ordinary, current',
  "for (const role of ['integrator'");
const artifactPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const authority = require(artifactPath);

function privateFacts() {
  const loaded = new Module(artifactPath, module);
  loaded.filename = artifactPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(artifactPath));
  loaded._compile(fs.readFileSync(artifactPath, 'utf8')
    + '\nmodule.exports = { immutableVerificationFacts, immutableFileFact };', artifactPath);
  return loaded.exports;
}

function countedConsumer() {
  const loaded = new Module(artifactPath, module);
  loaded.filename = artifactPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(artifactPath));
  const source = fs.readFileSync(artifactPath, 'utf8');
  const seam = 'function partitionInventory(packet) {';
  assert.ok(source.includes(seam));
  loaded._compile(source.replace("'use strict';", "'use strict';\nlet inventoryReconstructions = 0;")
    .replace(seam, seam + '\n  inventoryReconstructions++;')
    + '\nmodule.exports = { ...module.exports, inventoryReconstructions: () => inventoryReconstructions };', artifactPath);
  return loaded.exports;
}

test('immutable facts require exact bytes, physical identity, receipt and governing pins in one operation', () => {
  const { immutableVerificationFacts, immutableFileFact } = privateFacts();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-facts-')));
  try {
    const file = path.join(root, 'input.json'), other = path.join(root, 'other.json');
    const raw = Buffer.from('{"value":1}');
    fs.writeFileSync(file, raw); fs.writeFileSync(other, raw);
    const facts = immutableVerificationFacts();
    let count = 0;
    const reconstruct = () => { count++; return { value: 1 }; };
    const binding = { receipt: { dispatch_id: 'original' }, pins: ['original'], validated: true };
    const read = (name = file, bytes = raw, bindings = binding, operation = facts) =>
      immutableFileFact(operation, 'json', name, bytes, bindings, reconstruct);
    const first = read();
    assert.equal(read(), first);
    assert.equal(count, 1);
    assert.ok(Object.isFrozen(first));
    read(other);
    read(file, Buffer.from('{"value":2}'));
    read(file, raw, { ...binding, receipt: { dispatch_id: 'replacement' } });
    read(file, raw, { ...binding, pins: ['replacement'] });
    fs.renameSync(file, file + '.old'); fs.writeFileSync(file, raw);
    read();
    read(file, raw, binding, immutableVerificationFacts());
    assert.equal(count, 7);
    assert.throws(() => immutableFileFact({ validated: true }, 'json', file, raw, binding, reconstruct), TypeError);
    assert.equal(authority.immutableVerificationFacts, undefined);
    assert.equal(authority.immutableFileFact, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const runtime of ['codex', 'claude']) test(runtime + ' original consumer shares stream reconstruction only inside one operation', async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = runtime === 'codex' ? codex.semanticFixture(f, { native(rows) {
      const index = rows.findIndex(row => row.payload?.type === 'token_count');
      if (index >= 0) rows.splice(index, 1);
    } }) : claude.nativeFixture(f, 'integrator');
    const completed = runtime === 'codex'
      ? await codex.supportedPartitionCaller(f, runtime, prepared.options)
      : await claude.ordinary(f, 'integrator', prepared);
    assert.equal(completed.result.review_contract, codex.contract);
    const counted = countedConsumer();
    const currentInput = { worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, validated: true };
    assert.ok(counted.currentIntegrationVerdict(currentInput)?.authenticated);
    assert.equal(counted.inventoryReconstructions(), 1, 'repeated semantic checks share complete material reconstruction');
    assert.ok(counted.currentIntegrationVerdict(currentInput)?.authenticated);
    assert.equal(counted.inventoryReconstructions(), 2, 'independent current lookup reconstructs the material again');
    const worker = prepared.launches[0];
    const input = { worktreePath: f.worktree, snapshot_sha256: worker.payload.snapshot_sha256,
      assignment_id: worker.payload.assignment.id, validated: true };
    assert.throws(() => authority.readSemanticOriginal({ ...input, snapshot_sha256: '0'.repeat(64) }));
    const native = require('../../plugins/delivery-pipeline/scripts/' + runtime + '-runtime-host.cjs');
    const parser = runtime === 'codex' ? 'parseCodexStream' : 'parseClaudeStream';
    const originalParser = native[parser], originalLoad = Module._load;
    let count = 0;
    const observed = { ...native, [parser](...args) {
      if (args[0].includes(worker.session)) count++;
      return originalParser.apply(this, args);
    } };
    Module._load = function(name, ...args) {
      return name.endsWith('/' + runtime + '-runtime-host.cjs') ? observed : originalLoad.call(this, name, ...args);
    };
    let original;
    try {
      original = authority.readSemanticOriginal(input);
      assert.equal(count, 1, 'adjacent original/native consumers decode an unchanged stream once');
      assert.deepEqual(authority.readSemanticOriginal(input), original);
      assert.equal(count, 2, 'a later independent operation must decode again');
    } finally { Module._load = originalLoad; }
    assert.equal(original.native.accounting.status, 'unknown');
    assert.equal(original.native.resource_failure, null);
    const output = original.native.output_pin.path, outputBytes = fs.readFileSync(output);
    const nativeBytes = fs.readFileSync(original.native.native_pin.path);
    const createHash = crypto.createHash;
    const hashes = { output: 0, native: 0 };
    crypto.createHash = function(...args) {
      const hash = createHash.apply(this, args), update = hash.update;
      hash.update = function(value, ...rest) {
        if (Buffer.isBuffer(value)) {
          if (value.equals(outputBytes)) hashes.output++;
          if (value.equals(nativeBytes)) hashes.native++;
        }
        return update.call(this, value, ...rest);
      };
      return hash;
    };
    try {
      authority.readSemanticOriginal(input);
      assert.deepEqual(hashes, { output: 1, native: 1 });
    } finally { crypto.createHash = createHash; }
    let mutated = false;
    Module._load = function(name, ...args) {
      if (!name.endsWith('/' + runtime + '-runtime-host.cjs')) return originalLoad.call(this, name, ...args);
      return { ...native, [parser](raw, ...rest) {
        const parsed = originalParser.call(this, raw, ...rest);
        if (!mutated && raw.includes(worker.session)) {
          mutated = true;
          fs.appendFileSync(output, 'changed');
        }
        return parsed;
      } };
    };
    try {
      assert.throws(() => authority.readSemanticOriginal(input), /changed/);
      assert.equal(mutated, true, 'mutate between adjacent consumers inside the same operation');
    } finally { Module._load = originalLoad; fs.writeFileSync(output, outputBytes); }
    const current = () => runtime === 'codex' ? codex.coldCurrent(f) : claude.current(f, 'integrator');
    assert.ok(current()?.authenticated);
    const protectedFiles = authority.authenticatedArchivePins(f.worktree).map(pin => path.join(f.worktree, pin.path));
    const recorded = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id);
    const receipt = path.join(prepared.recorder.storeDir, 'record-' + require('node:crypto')
      .createHash('sha256').update(original.reference.dispatch_id).digest('hex') + '.json');
    protectedFiles.push(receipt);
    const before = protectedFiles.map(file => [file, fs.readFileSync(file)]);
    const finalReceipt = prepared.recorder.getLatestReceipt(runtime, 'integrator');
    const finalRuntime = runtime === 'codex' ? finalReceipt.receipt.runtime_evidence : finalReceipt.receipt;
    const finalOutput = finalRuntime.transcript.path;
    const finalNative = runtime === 'codex' ? prepared.launches.at(-1).nativePath
      : path.join(path.dirname(finalOutput), 'projects', finalRuntime.selection_evidence.transcript.path);
    const finalNativePin = runtime === 'codex' ? finalRuntime.native_session_evidence
      : finalRuntime.selection_evidence.transcript;
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(finalNative)).digest('hex'), finalNativePin.sha256);
    const targets = [original.native.output_pin.path, original.native.native_pin.path,
      path.join(f.worktree, original.reference.artifact_ref), receipt,
      prepared.launches.at(-1).payload.material[0].read_path,
      finalOutput, finalNative];
    for (const file of targets) {
      const bytes = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('changed')]));
        let refused = false;
        try { refused = current() === null; } catch (error) {
          assert.notEqual(error.code, 'ERR_ASSERTION');
          refused = true;
        }
        assert.equal(refused, true, 'changed original material must refuse cold authority: ' + file);
      } finally { fs.writeFileSync(file, bytes); }
      assert.ok(current()?.authenticated);
    }
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(prepared.recorder.getVerifiedRecord(original.reference.dispatch_id), recorded);
  });
});

test('retention publication re-reads the archive and refuses changed manifest bytes', async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = codex.semanticFixture(f);
    const link = fs.linkSync;
    let changed = false;
    fs.linkSync = function(source, destination, ...args) {
      const result = link.call(this, source, destination, ...args);
      if (!changed && String(destination).endsWith('/.shipyard-role-artifact.json')) {
        changed = true;
        fs.appendFileSync(destination, 'changed');
      }
      return result;
    };
    try {
      await assert.rejects(codex.supportedPartitionCaller(f, 'codex', prepared.options));
      assert.equal(changed, true, 'exercise actual archive publication');
      assert.equal(codex.coldCurrent(f), null);
    } finally { fs.linkSync = link; }
  });
});

test('real scoped source mutation fails admission, skips later commands and retains independent observations', () => {
  const { execFileSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-command-mutation-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Verification Fixture');
    git('config', 'user.email', 'verification@example.test');
    const source = path.join(root, 'source.cjs');
    fs.writeFileSync(source, 'module.exports = 1;\n');
    git('add', 'source.cjs');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const head = git('rev-parse', 'HEAD'), calls = [];
    const commands = [['node', 'first.cjs'], ['node', 'second.cjs']];
    const results = run(admit(commands, commands.map(argv => ({ argv, profile: 'host' }))), {
      worktree: root, expectedHead: head, files_modified: ['source.cjs'],
      hostRunner: { run(spec) {
        calls.push(spec.argv);
        fs.writeFileSync(source, 'module.exports = 2;\n');
        return { status: 0 };
      } },
    });
    assert.deepEqual(calls, [['first.cjs']]);
    assert.equal(results[0].outcome, 'failed');
    assert.notEqual(results[0].tree_before, results[0].tree_after);
    assert.equal(results[1].outcome, 'skipped');
    const sealed = evidence(results, { stateRoot: path.join(root, 'state'), ticket: 'T-53-07' });
    const retained = readEvidence(sealed.path, sealed.digest);
    assert.equal(sealed.outcome, 'failed');
    assert.deepEqual(retained.results, results);
    assert.equal(git('rev-parse', 'HEAD'), head);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const finalizerFile = path.join(__dirname, 'delivery-commit-finalizer.test.cjs');
const finalizerFixtures = new Module(finalizerFile, module);
finalizerFixtures.filename = finalizerFile;
finalizerFixtures.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { before, after, test(title, run) {
      if (title === 'rejects an ordinary index change made while the host signer runs')
        test('finalizer still refuses index CAS movement during signing', run);
    } };
    return originalLoad.call(this, name, ...args);
  };
  finalizerFixtures._compile(fs.readFileSync(finalizerFile, 'utf8')
    + '\nmodule.exports = { makeRepo, git, command, temporary: () => temporary };', finalizerFile);
} finally { Module._load = originalLoad; }

test('finalizer still refuses HEAD CAS movement during signing', () => {
  const { makeRepo, git, command, temporary } = finalizerFixtures.exports;
  const { repo, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src/owned.txt'), 'changed\n');
  const moved = command('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit-tree',
    git(repo, 'rev-parse', 'HEAD^{tree}')], { input: 'concurrent head\n' });
  const wrapper = path.join(temporary(), 'head-cas-signer.cjs');
  const gpg = command('which', ['gpg']);
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('node:child_process');",
    `const moved = spawnSync('git', ['-C', ${JSON.stringify(repo)}, 'update-ref', 'HEAD', ${JSON.stringify(moved)}]);`,
    'if (moved.status !== 0) process.exit(90);',
    `const signed = spawnSync(${JSON.stringify(gpg)}, process.argv.slice(2), { env: process.env, stdio: 'inherit' });`,
    'process.exit(signed.status === null ? 91 : signed.status);',
    '',
  ].join('\n'), { mode: 0o755 });
  git(repo, 'config', 'gpg.program', wrapper);
  const index = path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'index'));
  const beforeIndex = fs.readFileSync(index);
  assert.throws(() => require('../../plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs')
    .finalizeDeliveryCommit(options), /branch moved during signing/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), moved);
  assert.deepEqual(fs.readFileSync(index), beforeIndex);
});
