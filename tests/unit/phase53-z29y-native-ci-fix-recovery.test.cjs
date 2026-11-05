'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { root, scripts, hash, git, historicalCiScripts, signingFixture, ciFixture, assertCurrent, fixtureController, bounded } = require('./phase53-z29x-native-ci-fix-contract.test.cjs');
const host = require(path.join(scripts, 'codex-delivery-host.cjs'));
const boundary = require(path.join(scripts, 'dispatch-boundary.cjs'));
const identities = ['.codex-plugin/plugin.json', 'package-build.json'];
function inventory(directory) {
  const entries = [];
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), relative = prefix + name;
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 }); visit(file, relative + '/'); }
      else { assert.equal(stat.isFile(), true); entries.push({ path: relative, type: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: hash(fs.readFileSync(file)) }); }
    }
  };
  visit(directory, ''); return entries;
}
function custodySnapshot(directory) {
  const entries = [];
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), relative = prefix + name;
      const entry = { path: relative, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
      if (stat.isSymbolicLink()) entries.push({ ...entry, type: 'symlink', target: fs.readlinkSync(file) });
      else if (stat.isDirectory()) { entries.push({ ...entry, type: 'directory' }); visit(file, relative + '/'); }
      else { assert.equal(stat.isFile(), true); entries.push({ ...entry, type: 'file', bytes: stat.size, sha256: hash(fs.readFileSync(file)) }); }
    }
  };
  visit(directory, ''); return entries;
}
function verifyPackage(directory) {
  const entries = inventory(directory), crypto = require('node:crypto'), digest = crypto.createHash('sha256');
  for (const entry of entries) if (entry.type === 'file' && !identities.includes(entry.path)) {
    digest.update(entry.path + '\0'); digest.update(fs.readFileSync(path.join(directory, entry.path)));
  }
  const source = digest.digest('hex'), plugin = JSON.parse(fs.readFileSync(path.join(directory, identities[0])));
  const build = JSON.parse(fs.readFileSync(path.join(directory, identities[1])));
  assert.ok(plugin.version.endsWith('+codex.' + source.slice(0, 16)));
  assert.equal(build.version, plugin.version);
  assert.equal(build.digest, crypto.createHash('sha256').update(source).update('\0').update(fs.readFileSync(path.join(directory, identities[0]))).digest('hex'));
  return entries;
}
function verifySourceMirrors(source, destination) {
  for (const entry of inventory(destination)) {
    if (entry.type !== 'file' || !entry.path.startsWith('host/')) continue;
    const original = path.join(source, entry.path.slice(5));
    assert.equal(fs.lstatSync(original).isFile(), true);
    assert.equal(hash(fs.readFileSync(original)), entry.sha256, 'whole mirrored source entry: ' + entry.path);
    if (!entry.path.startsWith('host/scripts/')) assert.equal(fs.statSync(original).mode & 0o777, entry.mode);
  }
}
function packageSource(directory) {
  for (const relative of ['scripts', 'plugins/delivery-pipeline', 'capabilities/delivery-pipeline']) {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.cpSync(path.join(root, relative), path.join(directory, relative), { recursive: true });
  }
  const build = spawnSync(process.execPath, [path.join(directory, 'scripts/package-shipyard-codex.cjs')],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr);
  return path.join(directory, 'plugins/shipyard');
}
function originalOperation(f) {
  const directory = path.join(f.stateRoot, 'ci-originals');
  const operations = fs.readdirSync(directory).map(name => {
    const file = path.join(directory, name); return { file, envelope: JSON.parse(fs.readFileSync(file)) };
  }).filter(({ envelope }) => ['plan_sha256', 'pr', 'evidence_path', 'evidence_sha256']
    .every(key => envelope.payload.selectors[key] === f.request.context[key]));
  assert.equal(operations.length, 1); return operations[0];
}
function coldOriginal(f, installed, expectedError, expectedPushes = 1) {
  if (f.options.controller) {
    f.options.controller.release(f.scope.run_id, 'fixture cold original host handoff');
    delete f.options.controller;
  }
  const child = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).coldRecovery(JSON.parse(process.argv[2]),process.argv[3]).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{process.stdout.write(JSON.stringify({error:e.code,launches:e.physical_launches,pushes:e.publication_calls}));console.error(e);process.exitCode=1;});',
    path.join(__dirname, 'phase53-z29x-native-ci-fix-contract.test.cjs'), JSON.stringify(f.coldSpec()), path.join(installed, 'host/plugins/delivery-pipeline/scripts')],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, expectedError ? 1 : 0, child.stderr + child.stdout);
  const recovered = JSON.parse(child.stdout);
  if (expectedError) {
    assert.deepEqual(recovered, { error: expectedError, launches: 0, pushes: 0 }); return null;
  }
  assert.equal(recovered.launches, 0); assert.equal(recovered.pushes, expectedPushes);
  f.publish(recovered.result.artifact.commit);
  return recovered.result;
}
if (require.main === module) {
  test('original CI recording completes actual host handoff before the next reservation', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing); f.control.source = false; f.output.status = 'no-op';
      const { createSessionHandoff, withSessionHandoff } = require(path.join(scripts, 'session-handoff.cjs'));
      const handoff = createSessionHandoff({ cwd: f.worktree, storeDir: path.join(signing.directory, 'handoff-store') });
      const owner = handoff.begin({ phase: '53', tickets: ['T-53-31'], runtime: 'codex', runId: f.scope.run_id, sessionId: 'original-ci-session' });
      const result = await withSessionHandoff(owner, () => f.run());
      assert.equal(result.receipt.compliance, 'verified'); assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
      assert.equal(handoff.inspect(owner.scope_id).scopes[0].pending_launch, null);
      const next = handoff.reserveLaunch(owner, { dispatch_id: 'after-original-ci', role: 'ci-fix', runtime: 'codex' });
      handoff.completeLaunch(next, { recorded: true, aborted: true });
      assert.equal(handoff.inspect(owner.scope_id).scopes[0].pending_launch, null); assert.equal(f.launches, 1);
    } finally { signing.close(); }
  });

  test('repair remote boundaries renew only the original live controller across serial work beyond TTL', bounded, () => {
    const Module = require('node:module');
    const filename = path.join(scripts, 'codex-delivery-host.cjs');
    const loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(fs.readFileSync(filename, 'utf8')
      + '\nmodule.exports = { ...module.exports, ownerTest: { repairOwnerRenewal, repairCommand, REPAIR_OWNER } };\n', filename);
    const { repairOwnerRenewal, repairCommand, REPAIR_OWNER } = loaded.exports.ownerTest;
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-owner-')));
    try {
      let clock = 1000, calls = 0;
      const { createRunController } = require(path.join(scripts, 'run-controller.cjs'));
      const { createRunScope } = require(path.join(scripts, 'run-scope.cjs'));
      const controller = createRunController({ storeDir: path.join(directory, 'runs'), now: () => clock });
      const scope = { run_id: 'original-recovery', worktree: directory, phase: '53', ticket: 'T-53-31',
        runtime: 'codex', provider: 'openai' };
      const run = createRunScope({ ...scope, repository_id: 'fixture/repository', owner_id: controller.owner_id,
        dispatch: { dispatch_id: 'original-recovery-dispatch', role: 'review-fix', model: 'gpt-6.1-sol', effort: 'low' } });
      controller.begin(run);
      const initial = controller.status(scope.run_id).owner;
      const ttl = initial.expires_at - clock;
      const options = { [REPAIR_OWNER]: repairOwnerRenewal(controller, scope), execFileSync() {
        calls++; clock += Math.floor(ttl / 3); return '{"authenticated_step":true}';
      } };
      for (let i = 0; i < 8; i++) assert.equal(repairCommand(options, directory, ['api', 'graphql']).authenticated_step, true);
      assert.ok(clock > initial.expires_at);
      assert.equal(calls, 8); controller.assertOwner(scope.run_id);
      const owner = controller.status(scope.run_id).owner;
      assert.equal(owner.owner_id, initial.owner_id);
      assert.equal(owner.epoch, initial.epoch);
      clock += ttl + 1;
      assert.throws(() => repairCommand(options, directory, ['api', 'graphql']), { code: 'LEASE_EXPIRED' });
      assert.equal(calls, 8);
      controller.recoverExpired();
      const contender = createRunController({ storeDir: path.join(directory, 'runs'), now: () => clock });
      contender.begin(run);
      assert.throws(() => repairCommand(options, directory, ['api', 'graphql']));
      assert.equal(calls, 8);
      contender.release(scope.run_id);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('one remote step exceeding its original live lease refuses without a second effect', bounded, () => {
    const Module = require('node:module'), filename = path.join(scripts, 'codex-delivery-host.cjs');
    const loaded = new Module(filename, module); loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(fs.readFileSync(filename, 'utf8')
      + '\nmodule.exports = { ...module.exports, ownerTest: { repairOwnerRenewal, repairCommand, REPAIR_OWNER } };\n', filename);
    const { repairOwnerRenewal, repairCommand, REPAIR_OWNER } = loaded.exports.ownerTest;
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-expiry-')));
    try {
      let clock = 1000, effects = 0;
      const controller = require(path.join(scripts, 'run-controller.cjs')).createRunController({
        storeDir: path.join(directory, 'runs'), now: () => clock });
      const scope = { run_id: 'long-original-step', worktree: directory, phase: '53', ticket: 'T-53-31', runtime: 'codex' };
      controller.begin(require(path.join(scripts, 'run-scope.cjs')).createRunScope({ ...scope,
        repository_id: 'fixture/repository', owner_id: controller.owner_id,
        dispatch: { dispatch_id: 'long-original-dispatch', role: 'review-fix', model: 'gpt-6.1-sol', effort: 'low' } }));
      const ttl = controller.status(scope.run_id).owner.expires_at - clock;
      const options = { [REPAIR_OWNER]: repairOwnerRenewal(controller, scope), execFileSync() {
        effects++; clock += ttl + 1; return '{}';
      } };
      assert.throws(() => repairCommand(options, directory, ['api', 'graphql']), { code: 'LEASE_EXPIRED' });
      assert.throws(() => repairCommand(options, directory, ['api', 'graphql']), { code: 'LEASE_EXPIRED' });
      assert.equal(effects, 1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('shared coverage aliases retain historical native CI evidence and refuse corrupt direct records and foreign custody', bounded, async t => {
    const signing = signingFixture();
    try {
      const producerScripts = historicalCiScripts(path.join(signing.directory, 'historical-coverage-producer'));
      const f = ciFixture(signing, { declaredRepo: null, producerScripts });
      git(f.worktree, 'remote', 'add', 'origin', 'https://github.com/fixture/repository.git');
      const result = await f.run(), authority = require(path.join(scripts, 'conveyor-coverage.cjs'));
      const commit = result.artifact.commit, repository = authority.repositoryIdentity(f.worktree);
      const coverageRoot = process.env.SHIPYARD_COVERAGE_ROOT;
      const remoteFile = path.join(coverageRoot, 'coverage', encodeURIComponent('fixture/repository'), commit + '.json');
      const directFile = path.join(coverageRoot, 'coverage', encodeURIComponent(repository), commit + '.json');
      const remoteBytes = fs.readFileSync(remoteFile);
      const operation = originalOperation(f).envelope.payload;
      const receiptFile = path.join(operation.receipt_store, 'record-' + hash(result.receipt.dispatch_id) + '.json');
      const receiptBytes = fs.readFileSync(receiptFile);
      const read = (covered, repo, worktree = f.worktree) => {
        const beforeCoverage = custodySnapshot(coverageRoot), beforeReceipts = custodySnapshot(operation.receipt_store);
        const checked = authority.verify({ commit, repo, worktree });
        assert.equal(checked.covered, covered, checked.reason);
        const chain = authority.chain({ repo, worktreeOrCheckout: worktree, base: f.originalHead, head: commit });
        assert.equal(chain.covered, covered, chain.reason);
        if (covered) {
          assert.equal(checked.record.repo, 'fixture/repository'); assert.equal(checked.record.repository_id, repository);
          assert.equal(checked.record.ticket, f.scope.ticket); assert.equal(checked.record.dispatch_id, result.receipt.dispatch_id);
          assert.deepEqual(chain.links, ['fixer']);
        }
        assert.deepEqual(custodySnapshot(coverageRoot), beforeCoverage); assert.deepEqual(custodySnapshot(operation.receipt_store), beforeReceipts);
      };
      for (const repo of [undefined, repository, 'fixture/repository']) read(true, repo);
      f.options.controller.release(f.scope.run_id, 'fixture current host custody handoff'); delete f.options.controller;
      fixtureController(f.options);
      const resumed = await host.createCodexDeliveryHost(f.options).run({ role: f.request.role, context: f.request.context });
      assert.equal(resumed.receipt.dispatch_id, result.receipt.dispatch_id);
      assert.equal(resumed.receipt.runtime_evidence.session_id, result.receipt.runtime_evidence.session_id);
      assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
      for (const mutation of ['missing-coverage', 'corrupt-coverage', 'foreign-coverage', 'missing-receipt', 'corrupt-receipt',
        'foreign-receipt', 'corrupt-direct', 'conflicting-direct', 'symlink-direct', 'foreign-repo', 'foreign-origin', 'missing-origin', 'local-origin', 'foreign-checkout'])
        await t.test(mutation, bounded, () => {
          let repo, worktree = f.worktree, clone;
          try {
            if (mutation === 'missing-coverage') fs.unlinkSync(remoteFile);
            if (['corrupt-coverage', 'foreign-coverage'].includes(mutation)) {
              const changed = JSON.parse(remoteBytes);
              if (mutation === 'foreign-coverage') changed.payload.repository_id = 'git-common:' + 'f'.repeat(64);
              else changed.integrity.mac = '0'.repeat(64);
              fs.writeFileSync(remoteFile, JSON.stringify(changed));
            }
            if (mutation === 'missing-receipt') fs.unlinkSync(receiptFile);
            if (['corrupt-receipt', 'foreign-receipt'].includes(mutation)) {
              const changed = JSON.parse(receiptBytes);
              if (mutation === 'foreign-receipt') changed.payload.ticket = 'T-53-30';
              else changed.integrity.mac = '0'.repeat(64);
              fs.writeFileSync(receiptFile, JSON.stringify(changed));
            }
            if (mutation.endsWith('-direct')) {
              fs.mkdirSync(path.dirname(directFile), { recursive: true, mode: 0o700 });
              if (mutation === 'symlink-direct') fs.symlinkSync(path.join(signing.directory, 'absent-record'), directFile);
              else fs.writeFileSync(directFile, mutation === 'conflicting-direct' ? remoteBytes : '{invalid', { mode: 0o600 });
            }
            if (mutation === 'foreign-repo') repo = 'foreign/repository';
            if (mutation === 'foreign-origin') git(f.worktree, 'remote', 'set-url', 'origin', 'https://github.com/foreign/repository.git');
            if (mutation === 'missing-origin') git(f.worktree, 'remote', 'remove', 'origin');
            if (mutation === 'local-origin') git(f.worktree, 'remote', 'set-url', 'origin', signing.directory);
            if (mutation === 'foreign-checkout') {
              clone = path.join(signing.directory, 'foreign-checkout');
              git(signing.directory, 'clone', '-q', '--no-hardlinks', f.worktree, clone);
              git(clone, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repository.git'); worktree = clone;
            }
            read(false, repo, worktree);
          } finally {
            fs.rmSync(directFile, { force: true });
            if (mutation.endsWith('-direct')) fs.rmdirSync(path.dirname(directFile));
            fs.writeFileSync(remoteFile, remoteBytes, { mode: 0o600 }); fs.writeFileSync(receiptFile, receiptBytes, { mode: 0o600 });
            if (mutation === 'missing-origin') git(f.worktree, 'remote', 'add', 'origin', 'https://github.com/fixture/repository.git');
            else git(f.worktree, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repository.git');
            if (clone) fs.rmSync(clone, { recursive: true, force: true });
          }
          read(true);
          assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
        });
      assert.deepEqual(fs.readFileSync(remoteFile), remoteBytes);
      assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes);
    } finally { signing.close(); }
  });
  test('old module-written private CI markers stay read-only with valid, missing and corrupt original reservations', bounded, async t => {
    const signing = signingFixture();
    try {
      const producerScripts = historicalCiScripts(path.join(signing.directory, 'legacy-private-producer'));
      for (const rung of [2, 3]) for (const custody of ['valid', 'missing', 'corrupt']) await t.test(`${rung}:${custody}`, bounded, async () => {
        const f = ciFixture(signing, { producerScripts }); f.control.source = false; f.output.status = 'no-op';
        let result;
        for (let attempt = 1; attempt <= rung; attempt++) {
          if (f.options.controller) { f.options.controller.release(f.scope.run_id, 'fixture original CI handoff'); delete f.options.controller; }
          f.scope.run_id = 'legacy-original-' + require('node:crypto').randomUUID(); f.control.runAttempt = attempt;
          result = await f.run();
        }
        const original = originalOperation(f).envelope.payload, store = original.receipt_store;
        const predecessor = original.predecessor_dispatch_id;
        assert.ok(predecessor); assert.equal(result.receipt.applied_effort, rung === 2 ? 'high' : 'xhigh');
        const markerFile = path.join(store, 'repair-commit-' + hash(predecessor) + '.json');
        const marker = JSON.parse(fs.readFileSync(markerFile)).payload;
        assert.equal(marker.original_kind, undefined); assert.equal(marker.successor_dispatch_id, result.receipt.dispatch_id);
        assert.equal(marker.record_input.receipt.runtime_evidence.session_id, result.receipt.runtime_evidence.session_id);
        const reservation = path.join(store, 'reservation-' + hash(result.receipt.dispatch_id) + '.json');
        assert.equal(JSON.parse(fs.readFileSync(reservation)).payload.original_kind, 'ci-fix');
        if (custody === 'missing') fs.unlinkSync(reservation);
        if (custody === 'corrupt') { const changed = JSON.parse(fs.readFileSync(reservation));
          changed.integrity.mac = '0'.repeat(64); fs.writeFileSync(reservation, JSON.stringify(changed)); }
        for (const file of ['record-' + hash(result.receipt.dispatch_id), 'latest-' + hash('codex:ci-fix'), 'consumed-' + hash(predecessor)])
          fs.rmSync(path.join(store, file + '.json'), { force: true });
        const before = inventory(store);
        const child = spawnSync(process.execPath, ['-e', `const assert=require('node:assert/strict');
          const r=require(process.argv[1]).createDurableRecorder(process.argv[2]);
          assert.equal(r.isConsumed(process.argv[3]),true);
          assert.deepEqual(r.claim(process.argv[3],'foreign-reader'),{claimed:false});
          assert.equal(r.getVerifiedRecord(process.argv[4]),null);
          assert.equal(r.getLatestReceipt('codex','ci-fix'),null);`,
          path.join(scripts, 'dispatch-boundary.cjs'), store, predecessor, result.receipt.dispatch_id],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr); assert.deepEqual(inventory(store), before);
        assert.equal(f.launches, rung); assert.equal(f.pushes, 0);
      });
    } finally { signing.close(); }
  });
  test('old generic native CI markers recover only with their valid unsigned legacy reservation', bounded, async t => {
    const signing = signingFixture();
    try {
      const producerScripts = historicalCiScripts(path.join(signing.directory, 'legacy-generic-producer'));
      const producer = require(path.join(producerScripts, 'dispatch-boundary.cjs'));
      for (const custody of ['valid', 'missing', 'corrupt', 'foreign-legacy', 'bad-HMAC']) await t.test(custody, bounded, async () => {
        const f = ciFixture(signing, { producerScripts }); f.control.source = false; f.output.status = 'no-op';
        const store = path.join(signing.directory, 'generic-receipts-' + custody);
        const recorder = producer.createDurableRecorder(store);
        const runtime = require(path.join(producerScripts, 'codex-runtime-host.cjs')).createCodexRuntimeHost({
          ...f.options, recorder, transcriptDir: path.join(signing.directory, 'generic-transcripts-' + custody) });
        const adapter = require(path.join(producerScripts, 'codex-dispatch-adapter.cjs')).createCodexDispatchAdapter({
          agentsDir: f.options.agentDir, agentManifest: f.options.agentManifest, capabilities: f.options.capabilities, host: runtime });
        const dispatch = producer.createDispatchBoundary({ adapters: { codex: adapter }, recorder, cwd: f.worktree });
        const context = { ticket: f.scope.ticket, run_id: f.scope.run_id, phase: f.scope.phase,
          worktree: f.worktree, prompt: 'Retain the original generic CI native receipt.' };
        const first = await dispatch.dispatch({ runtime: 'codex', role: 'ci-fix', dispatch_id: 'generic-first-' + custody }, context);
        const second = await dispatch.dispatch({ runtime: 'codex', role: 'ci-fix', dispatch_id: 'generic-repeat-' + custody,
          previous_dispatch_id: first.dispatch_id, signals: { signatureState: 'repeat', priorApplied: first.receipt } }, context);
        assert.equal(second.receipt.applied_effort, 'high'); assert.equal(f.launches, 2); assert.equal(f.pushes, 0);
        const reservation = path.join(store, 'reservation-' + hash(second.dispatch_id) + '.json');
        const legacy = JSON.parse(fs.readFileSync(reservation));
        assert.equal(legacy.dispatch_id, second.dispatch_id); assert.equal(legacy.format, undefined);
        assert.equal(legacy.original_kind, undefined);
        assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'repair-commit-' + hash(first.dispatch_id) + '.json'))).payload.original_kind, undefined);
        if (custody === 'missing') fs.unlinkSync(reservation);
        if (custody === 'corrupt') fs.writeFileSync(reservation, '{invalid');
        if (custody === 'bad-HMAC') fs.writeFileSync(reservation, JSON.stringify({ format: 'adr-014.durable-boundary.v1',
          payload: legacy, integrity: { algorithm: 'hmac-sha256', mac: '0'.repeat(64) } }));
        if (custody === 'foreign-legacy') fs.writeFileSync(reservation, JSON.stringify({ ...legacy, dispatch_id: first.dispatch_id }));
        for (const file of ['record-' + hash(second.dispatch_id), 'latest-' + hash('codex:ci-fix'), 'consumed-' + hash(first.dispatch_id)])
          fs.rmSync(path.join(store, file + '.json'), { force: true });
        const before = inventory(store);
        const child = spawnSync(process.execPath, ['-e', `const assert=require('node:assert/strict');
          const r=require(process.argv[1]).createDurableRecorder(process.argv[2]);
          assert.equal(r.isConsumed(process.argv[3]),true);
          assert.deepEqual(r.claim(process.argv[3],'foreign-reader'),{claimed:false});
          const expected=JSON.parse(process.argv[5]);
          assert.deepEqual(r.getVerifiedRecord(process.argv[4])?.receipt||null,expected);
          assert.equal(r.getLatestReceipt('codex','ci-fix')?.dispatch_id||null,expected?process.argv[4]:null);`,
          path.join(scripts, 'dispatch-boundary.cjs'), store, first.dispatch_id, second.dispatch_id,
          JSON.stringify(custody === 'valid' ? second.receipt : null)],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr);
        if (custody !== 'valid') assert.deepEqual(inventory(store), before);
        else {
          const recovered = boundary.createDurableRecorder(store).getVerifiedRecord(second.dispatch_id);
          assert.deepEqual(recovered.receipt, second.receipt);
          assert.equal(recovered.predecessor_dispatch_id, first.dispatch_id);
          assert.equal(recovered.receipt.runtime_evidence.session_id, second.receipt.runtime_evidence.session_id);
          assert.equal(fs.existsSync(path.join(store, 'consumed-' + hash(first.dispatch_id) + '.json')), false);
        }
      });
    } finally { signing.close(); }
  });
  test('CI candidate association recovers admission and finalization crashes through the original cold operation', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'candidate-crash-package'));
      verifyPackage(installed);
      for (const point of ['admitted', 'finalized', 'signed-result', 'cli', 'candidate-only', 'tampered-candidate', 'tampered-association', 'tampered-coverage']) await t.test(point, bounded, async () => {
        const f = ciFixture(signing), rename = fs.renameSync, link = fs.linkSync;
        let interrupted = false;
        fs.renameSync = (source, destination, ...args) => {
          if (!interrupted && point === 'signed-result' && destination.includes('ci-originals')
              && JSON.parse(fs.readFileSync(source)).payload.signed_result) {
            interrupted = true; throw new Error('fixture candidate crash');
          }
          const value = rename(source, destination, ...args);
          if (!interrupted && (((['finalized', 'cli', 'candidate-only'].includes(point) || point.startsWith('tampered-')) && destination.includes(path.sep + 'finalized' + path.sep))
              || (point === 'admitted' && destination.includes('ci-originals')
                && JSON.parse(fs.readFileSync(destination)).payload.candidate_result))) {
            interrupted = true; throw new Error('fixture candidate crash');
          }
          return value;
        };
        fs.linkSync = (source, destination, ...args) => {
          const value = link(source, destination, ...args);
          if (!interrupted && point !== 'signed-result' && point !== 'admitted'
              && destination.includes(path.sep + 'finalized' + path.sep)) {
            interrupted = true; throw new Error('fixture candidate crash');
          }
          return value;
        };
        try { await assert.rejects(f.run, /fixture candidate crash/); }
        finally { fs.renameSync = rename; fs.linkSync = link; }
        assert.equal(interrupted, true);
        const original = originalOperation(f).envelope.payload;
        assert.ok(original.candidate_result.candidate_id);
        assert.equal(original.signed_result, undefined);
        assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        if (point.startsWith('tampered-')) {
          const files = {
            'tampered-candidate': path.join(f.stateRoot, 'candidates', original.candidate_result.candidate_id + '.json'),
            'tampered-association': originalOperation(f).file,
            'tampered-coverage': path.join(process.env.SHIPYARD_COVERAGE_ROOT, 'coverage', encodeURIComponent('fixture/repository'),
              git(f.worktree, 'rev-parse', 'HEAD') + '.json'),
          };
          fs.appendFileSync(files[point], '\nforeign state');
          f.options.controller.release(f.scope.run_id, 'candidate tamper cold handoff');
          const child = spawnSync(process.execPath, ['-e',
            'require(process.argv[1]).coldRecovery(JSON.parse(process.argv[2]),process.argv[3]).then(()=>process.exitCode=2).catch(e=>process.stdout.write(JSON.stringify({launches:e.physical_launches,pushes:e.publication_calls})));',
            path.join(__dirname, 'phase53-z29x-native-ci-fix-contract.test.cjs'), JSON.stringify(f.coldSpec()),
            path.join(installed, 'host/plugins/delivery-pipeline/scripts')],
            { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
          assert.equal(child.status, 0, child.stderr + child.stdout);
          assert.deepEqual(JSON.parse(child.stdout), { launches: 0, pushes: 0 });
          assert.equal(git(f.worktree, 'rev-list', '--count', `${f.originalHead}..HEAD`), '1');
          return;
        }
        let recovered;
        if (point === 'cli') recovered = await f.cliRun();
        else if (point === 'candidate-only') {
          await host.createFinalizationRecoveryHost(f.options).resumeFinalization(original.candidate_result.candidate_id, f.scope);
          recovered = originalOperation(f).envelope.payload.result;
        } else recovered = coldOriginal(f, installed);
        const finished = originalOperation(f).envelope.payload;
        assert.equal(finished.state, 'finished');
        assert.equal(finished.dispatch_id, original.dispatch_id);
        assert.equal(finished.completed.session_id, original.completed.session_id);
        assert.equal(finished.signed_result.artifact.candidate_id, original.candidate_result.candidate_id);
        assert.equal(git(f.worktree, 'rev-list', '--count', `${f.originalHead}..HEAD`), '1');
        assertCurrent(f, recovered);
        assert.deepEqual(coldOriginal(f, installed, undefined, 0), recovered);
      });
    } finally { signing.close(); }
  });
  test('finished signed CI originals return under green, pending and lost successful return with no fresh work', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'finished-original-package')); verifyPackage(installed);
      for (const phase of ['green', 'pending', 'lost-return']) await t.test(phase, bounded, async () => {
        const f = ciFixture(signing), rename = fs.renameSync;
        let lost = false, result;
        if (phase === 'lost-return') fs.renameSync = (source, destination, ...args) => {
          const value = rename(source, destination, ...args);
          if (!lost && destination.includes('ci-originals') && destination.endsWith('.json')
              && JSON.parse(fs.readFileSync(destination)).payload.state === 'finished') {
            lost = true; throw new Error('fixture lost successful original return');
          }
          return value;
        };
        try {
          if (phase === 'lost-return') await assert.rejects(f.run, /lost successful original return/);
          else result = await f.run();
        } finally { fs.renameSync = rename; }
        const retained = originalOperation(f).envelope.payload;
        assert.equal(retained.state, 'finished'); result ||= retained.result;
        f.control.mutateResponse = (endpoint, rows) => {
          if (endpoint.includes('/check-runs?')) Object.assign(rows[0].check_runs[0], {
            status: phase === 'pending' ? 'in_progress' : 'completed', conclusion: phase === 'pending' ? null : 'success' });
        };
        const requests = f.requests.length, head = git(f.worktree, 'rev-parse', 'HEAD');
        const warm = await f.run();
        assert.deepEqual(warm, JSON.parse(JSON.stringify(result))); assert.equal(f.requests.length, requests);
        const recovered = coldOriginal(f, installed, undefined, 0);
        assert.deepEqual(recovered, JSON.parse(JSON.stringify(result)));
        assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), head);
        assert.equal(git(f.worktree, 'rev-list', '--count', `${f.originalHead}..HEAD`), '1');
        assertCurrent(f, recovered);
      });
    } finally { signing.close(); }
  });
  test('finished unsigned CI results acknowledge green and pending checks through the terminal CLI', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const status of ['no-op', 'escalate']) for (const observation of ['green', 'pending', 'invalid'])
        await t.test(`${status}:${observation}`, bounded, async () => {
          const f = ciFixture(signing);
          f.control.source = false; f.output.status = status;
          const result = await f.cliRun();
          const retained = originalOperation(f).envelope.payload;
          assert.equal(retained.state, 'finished'); assert.equal(retained.signed_result, undefined);
          f.control.mutateResponse = (endpoint, rows) => {
            if (endpoint.includes('/check-runs?')) {
              Object.assign(rows[0].check_runs[0], { status: observation === 'pending' ? 'in_progress' : 'completed',
                conclusion: observation === 'pending' ? null : 'success' });
              if (observation === 'invalid') rows[0].check_runs[0].head_sha = '0'.repeat(40);
            }
          };
          if (observation === 'invalid') await assert.rejects(f.cliRun);
          else {
            assert.deepEqual(await f.cliRun(), JSON.parse(JSON.stringify(result)));
            const request = JSON.parse(fs.readFileSync(f.requestFile));
            request.scope.run_id = 'fresh-ack-' + require('node:crypto').randomUUID();
            fs.writeFileSync(f.requestFile, JSON.stringify(request));
            assert.deepEqual(await f.cliRun(), JSON.parse(JSON.stringify(result)));
          }
          assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
          assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
          assert.equal(originalOperation(f).envelope.payload.dispatch_id, retained.dispatch_id);
        });
    } finally { signing.close(); }
  });
  test('signed low and high source transitions admit the authenticated xhigh successor', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing), dispatches = [], heads = [f.originalHead];
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (f.options.controller) {
          f.options.controller.release(f.scope.run_id, 'fixture signed predecessor handoff'); delete f.options.controller;
        }
        if (attempt > 1) {
          const failureFile = path.join(signing.directory, 'successor-' + require('node:crypto').randomUUID() + '.log');
          fs.writeFileSync(failureFile, f.failureBytes, { mode: 0o600 });
          const request = require(path.join(scripts, 'deliver-dispatch.cjs')).build(['ci-fix', f.scope.ticket,
            '--runtime', 'codex', '--pr', '501', '--failure-file', failureFile], { cwd: f.worktree, graphDir: f.graphDir });
          Object.assign(f.scope, request.scope); Object.assign(f.request, request);
          fs.writeFileSync(f.requestFile, JSON.stringify(request));
        }
        f.control.runAttempt = attempt;
        f.control.mutateNative = () => fs.chmodSync(path.join(f.worktree, 'src/owned.txt'), attempt === 2 ? 0o755 : 0o644);
        const result = await f.run();
        assert.equal(result.receipt.applied_effort, ['low', 'high', 'xhigh'][attempt - 1]);
        const original = originalOperation(f).envelope.payload;
        assert.equal(original.predecessor_dispatch_id, dispatches.at(-1) || null);
        assert.equal(git(f.worktree, 'show', '-s', '--format=%P', result.artifact.commit), heads.at(-1));
        dispatches.push(result.receipt.dispatch_id); heads.push(result.artifact.commit);
        assertCurrent(f, result);
      }
      assert.equal(new Set(dispatches).size, 3); assert.equal(new Set(heads).size, 4);
      assert.equal(f.launches, 3); assert.equal(f.pushes, 3);
    } finally { signing.close(); }
  });
  test('finished CI originals refuse changed signed head, receipt, coverage, graph, signer, publication and source without replay', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'finished-refusal-package'));
      for (const mutation of ['head', 'receipt', 'coverage', 'graph', 'signer', 'publication', 'source', 'HOST']) await t.test(mutation, bounded, async () => {
        const f = ciFixture(signing), result = await f.run(), op = originalOperation(f).envelope.payload;
        const artifact = result.artifact, candidateFile = path.join(f.stateRoot, 'candidates', artifact.candidate_id + '.json');
        const candidate = JSON.parse(fs.readFileSync(candidateFile)).payload;
        const files = {
          receipt: path.join(op.receipt_store, 'record-' + hash(op.dispatch_id) + '.json'),
          coverage: path.join(process.env.SHIPYARD_COVERAGE_ROOT, 'coverage', encodeURIComponent('fixture/repository'), artifact.commit + '.json'),
          graph: path.join(f.graphDir, 'tickets.json'),
          publication: path.join(f.stateRoot, 'repair-publications', artifact.candidate_id + '.json'),
          source: path.join(f.worktree, 'src/owned.txt'),
          HOST: path.join(f.stateRoot, 'verification', candidate.verification.evidence_digest + '.json'),
        };
        if (mutation === 'head') f.publish(f.originalHead);
        else if (mutation === 'signer') git(f.worktree, 'config', 'user.signingkey', '0'.repeat(40));
        else fs.appendFileSync(files[mutation], '\nforeign state');
        f.options.controller.release(f.scope.run_id, 'finished original refusal handoff');
        const child = spawnSync(process.execPath, ['-e',
          'require(process.argv[1]).coldRecovery(JSON.parse(process.argv[2]),process.argv[3]).then(()=>process.exitCode=2).catch(e=>{process.stdout.write(JSON.stringify({launches:e.physical_launches,pushes:e.publication_calls}));});',
          path.join(__dirname, 'phase53-z29x-native-ci-fix-contract.test.cjs'), JSON.stringify(f.coldSpec()), path.join(installed, 'host/plugins/delivery-pipeline/scripts')],
          { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr + child.stdout);
        assert.deepEqual(JSON.parse(child.stdout), { launches: 0, pushes: 0 });
        assert.equal(f.launches, 1); assert.equal(f.pushes, 1); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), artifact.commit);
      });
    } finally { signing.close(); }
  });
  test('public review repair preserves complete prepublication operational history without predecessor or effort credit', bounded, async t => {
    const signing = signingFixture();
    try {
      const { createDeliveryFixture } = require('./helpers/phase53-delivery-fixture.cjs');
      const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');
      for (const variant of ['current', 'prepublication', 'both', 'foreign-pr', 'foreign-negative', 'attempt', 'fix_round', 'unknown-role',
        'missing-reason', 'empty-reason', 'malformed-ts', 'foreign-by', 'unsigned-native', 'extra-field']) await t.test(variant, bounded, async () => {
        const context = createDeliveryFixture({ temporary: signing.directory, signer: signing.signer });
        const valid = ['current', 'prepublication', 'both'].includes(variant);
        let journal, bytes, launches = 0, completed = 0;
        const preparedContext = { ...context, fixture(...args) {
          const f = context.fixture(...args);
          const row = { ts: '2026-11-01T22:33:28.625Z', event: 'escalation', ticket: f.scope.ticket, pr: null,
            reason: 'Environment blocked: original operation parked before publication', by: 'escalation-record' };
          if (variant === 'current') row.pr = 501;
          if (variant === 'foreign-pr') row.pr = 502;
          if (variant === 'foreign-negative') row.pr = -1;
          if (['attempt', 'fix_round'].includes(variant)) row.event = variant;
          if (variant === 'unknown-role') row.role = 'unknown-repair-role';
          if (variant === 'missing-reason') delete row.reason;
          if (variant === 'empty-reason') row.reason = ' ';
          if (variant === 'malformed-ts') row.ts = '2026-11-01';
          if (variant === 'foreign-by') row.by = 'native-agent';
          if (variant === 'unsigned-native') Object.assign(row, { role: 'review-fix', native_status: 'completed' });
          if (variant === 'extra-field') row.model = 'gpt-6.1-sol';
          journal = path.join(f.graphDir, 'delivery-log.jsonl');
          bytes = Buffer.from([row, ...(variant === 'both' ? [{ ...row, pr: 501 }] : [])].map(JSON.stringify).join('\n') + '\n');
          fs.writeFileSync(journal, bytes); return f;
        }, createCodexDeliveryHost(options) {
          const originalSpawn = options.spawn;
          const actual = context.createCodexDeliveryHost({ ...options, spawn(...args) { launches++; return originalSpawn(...args); } });
          return { ...actual, async run(request) {
            const result = await actual.run(request); completed++;
            assert.equal(result.receipt.applied_effort, 'low');
            assert.equal(result.resolution.signals.signatureState, 'first');
            assert.equal(result.resolution.prior_applied, undefined);
            assert.deepEqual(fs.readFileSync(journal), bytes);
            return result;
          } };
        }, clean(f) {
          assert.deepEqual(fs.readFileSync(journal), bytes); context.clean(f);
        } };
        const run = () => context.withGraphDirEnv(undefined, () => createOriginalFixerFixture(preparedContext)('no-op'));
        if (valid) { await run(); assert.equal(launches, 1); assert.equal(completed, 1); }
        else { await assert.rejects(run, { code: 'REPAIR_PREDECESSOR_INVALID' }); assert.equal(launches, 0); assert.equal(completed, 0); }
      });
    } finally { signing.close(); }
  });
  test('CI independently refuses foreign selectors, physical failure substitutions and incompatible checked jobs before launch', bounded, async t => {
    const signing = signingFixture();
    try {
      const cases = [
        ['wrong plan', f => { f.request.context.plan_sha256 = '0'.repeat(64); }],
        ['wrong PR', f => { f.request.context.pr = 502; }],
        ['caller rung', f => { f.request.signals = { signatureState: 'repeat' }; }],
        ['caller prompt', f => { f.request.context.prompt = 'Forged authority'; }],
        ['same length', f => fs.writeFileSync(f.failureFile, Buffer.alloc(f.failureBytes.length, 120))],
        ['growth', f => fs.appendFileSync(f.failureFile, 'x')],
        ['truncation', f => fs.truncateSync(f.failureFile, 1)],
        ['empty', f => fs.truncateSync(f.failureFile, 0)],
        ['missing', f => fs.unlinkSync(f.failureFile)],
        ['directory', f => { fs.unlinkSync(f.failureFile); fs.mkdirSync(f.failureFile); }],
        ['symlink', f => { fs.unlinkSync(f.failureFile); fs.symlinkSync(f.plan, f.failureFile); }],
        ['overflow', f => fs.writeFileSync(f.failureFile, Buffer.alloc(8 * 1024 * 1024 + 1))],
        ['foreign head', f => { f.options.getPullRequest = () => ({ number: 501, state: 'OPEN', headRefOid: '0'.repeat(40) }); }],
        ['closed PR', f => { const live = f.options.getPullRequest; f.options.getPullRequest = () => ({ ...live(), state: 'CLOSED' }); }],
        ['foreign remote checked head', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.endsWith('/pulls/501')) value.head.sha = '0'.repeat(40); }; }],
        ['foreign run head', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/actions/runs/')) value.head_sha = '0'.repeat(40); }; }],
        ['unavailable job', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/actions/runs/')) value.workflow_id = null; }; }],
        ['pending check', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/check-runs?')) value[0].check_runs[0].status = 'in_progress'; }; }],
        ['cancelled check', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/check-runs?')) value[0].check_runs[0].conclusion = 'cancelled'; }; }],
        ['empty checks', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/check-runs?')) { value[0].total_count = 0; value[0].check_runs = []; } }; }],
      ];
      for (const [name, mutate] of cases) await t.test(name, bounded, async () => {
        const f = ciFixture(signing); mutate(f);
        await assert.rejects(() => host.createCodexDeliveryHost(f.options).run({ role: 'ci-fix', context: f.request.context, signals: f.request.signals }));
        assert.equal(f.launches, 0); assert.equal(f.pushes, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
      });
      const f = ciFixture(signing), prepared = host.prepareCiRepair(f.options, f.scope, f.request.context);
      for (const mutation of ['bytes', 'mode', 'attempt', 'job']) {
        const mode = fs.statSync(f.failureFile).mode & 0o777;
        if (mutation === 'bytes') fs.writeFileSync(f.failureFile, Buffer.alloc(f.failureBytes.length, 120));
        if (mutation === 'mode') fs.chmodSync(f.failureFile, 0o644);
        if (mutation === 'attempt') f.control.runAttempt++;
        if (mutation === 'job') f.control.jobId = '99';
        assert.throws(() => host.recheckRepair(prepared, f.options));
        fs.writeFileSync(f.failureFile, f.failureBytes); fs.chmodSync(f.failureFile, mode);
        f.control.runAttempt = 1; f.control.jobId = '43';
        host.recheckRepair(prepared, f.options);
      }
      for (const handle of [{}, Object.freeze(Object.create(null)), JSON.parse(JSON.stringify(originalOperation(f).envelope.payload))])
        assert.throws(() => host.validateOriginalCiOperation(handle, 'recover', { dispatch_id: 'copied', ticket: 'T-53-31', runtime: 'codex', role: 'ci-fix' }), { code: 'CI_ORIGINAL_INVALID' });
    } finally { signing.close(); }
  });
  test('original CI record/index/finalize recovery retains one native session and reaches signed current consumption', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['native-completed', 'record', 'index', 'finalized-index', 'acknowledged', 'ack']) await t.test(phase, bounded, async () => {
        const f = ciFixture(signing), originalRename = fs.renameSync, originalLink = fs.linkSync;
        let injected = false;
        const inject = destination => {
          const name = path.basename(destination);
          const target = phase === 'record' ? name.startsWith('record-') : phase === 'index' ? name.startsWith('latest-')
            : phase === 'finalized-index' ? name.startsWith('latest-') && fs.existsSync(destination) : false;
          if (!injected && target) { injected = true; throw new Error('original fixture interruption at ' + phase); }
        };
        fs.linkSync = (source, destination, ...args) => { inject(destination); return originalLink(source, destination, ...args); };
        fs.renameSync = (source, destination, ...args) => {
          inject(destination);
          const result = originalRename(source, destination, ...args);
          if (!injected && destination.includes('ci-originals') && destination.endsWith('.json')) {
            const operation = JSON.parse(fs.readFileSync(destination)).payload;
            if ((phase === 'native-completed' && operation.completed && operation.output)
                || (phase === 'acknowledged' && operation.state === 'acknowledged')) {
              injected = true; throw new Error('original fixture interruption at ' + phase);
            }
          }
          return result;
        };
        try {
          if (phase === 'ack') {
            f.control.failPush = true;
            await assert.rejects(f.run, { code: 'REPAIR_PUBLICATION_PENDING' });
          } else await assert.rejects(f.run);
        } finally { fs.renameSync = originalRename; fs.linkSync = originalLink; }
        const before = originalOperation(f).envelope.payload;
        assert.equal(f.launches, 1); assert.ok(before.completed.session_id);
        if (phase === 'native-completed') {
          assert.equal(injected, true);
          const recorder = boundary.createDurableRecorder(before.receipt_store);
          assert.equal(recorder.getOriginalDispatch(before.dispatch_id).record, undefined);
          assert.equal(recorder.getVerifiedRecord(before.dispatch_id), null);
        }
        if (phase === 'ack') {
          await assert.rejects(f.run, { code: 'REPAIR_PUBLICATION_PENDING' }); assert.equal(f.pushes, 1);
          f.publish(git(f.worktree, 'rev-parse', 'HEAD'));
        }
        let result;
        if (phase !== 'ack') {
          const installed = packageSource(path.join(signing.directory, 'cold-original-package')); verifyPackage(installed);
          result = coldOriginal(f, installed);
          assert.equal(f.pushes, 0);
        } else { result = await f.run(); assert.equal(f.pushes, 1); }
        assert.equal(f.launches, 1);
        assert.equal(result.receipt.dispatch_id, before.dispatch_id);
        assert.equal(result.receipt.runtime_evidence.session_id, before.completed.session_id);
        assertCurrent(f, result);
        const retained = boundary.createDurableRecorder(before.receipt_store).getVerifiedRecord(before.dispatch_id);
        assert.equal(retained.receipt.receipt_type, 'adr-014.application');
        assert.equal(retained.receipt.policy_hash, before.resolution.policy_hash);
        assert.equal(retained.receipt.agent_file_digest, before.native_custody.agent_file_digest);
        assert.ok(retained.trace.some(row => row.stage === 'receipt' && row.status === 'passed'));
        assert.equal(originalOperation(f).envelope.payload.state, 'finished');
      });
    } finally { signing.close(); }
  });
  test('completed operation authentication refuses changed native, policy and subject bytes before cold recovery', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing), link = fs.linkSync;
      fs.linkSync = (source, destination, ...args) => {
        if (path.basename(destination).startsWith('record-')) throw new Error('fixture before original record');
        return link(source, destination, ...args);
      };
      try { await assert.rejects(f.run); } finally { fs.linkSync = link; }
      const { file, envelope } = originalOperation(f), bytes = fs.readFileSync(file);
      assert.ok(envelope.payload.completed.runtime_evidence.native_session_evidence.sha256);
      assert.equal(envelope.payload.completed.session_id, envelope.payload.completed.runtime_evidence.session_id);
      for (const mutate of [
        value => { value.completed.last_agent_message = 'foreign completion'; },
        value => { value.completed.runtime_evidence.session_id = 'foreign session'; },
        value => { value.resolution.effort = 'xhigh'; },
        value => { value.preparation.commit.ticket = 'T-53-30'; },
        value => { value.dispatch_id = 'copied-original'; },
      ]) {
        const changed = structuredClone(envelope); mutate(changed.payload);
        fs.writeFileSync(file, JSON.stringify(changed));
        await assert.rejects(f.run, { code: 'STATE_RECORD_INVALID' });
        assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        fs.writeFileSync(file, bytes);
      }
      const installed = packageSource(path.join(signing.directory, 'authenticated-original-package'));
      const result = coldOriginal(f, installed);
      assert.equal(result.receipt.dispatch_id, envelope.payload.dispatch_id);
      assert.equal(result.receipt.runtime_evidence.session_id, envelope.payload.completed.session_id);
      assert.equal(f.launches, 1); assertCurrent(f, result);
    } finally { signing.close(); }
  });
  test('original record, index and rollback authentication failures remain intact and cannot be overwritten by recovery', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing), rename = fs.renameSync;
      let interrupted = false;
      fs.renameSync = (source, destination, ...args) => {
        const result = rename(source, destination, ...args);
        if (!interrupted && path.basename(destination).startsWith('latest-')) {
          interrupted = true; throw new Error('fixture after original provisional index');
        }
        return result;
      };
      try { await assert.rejects(f.run); } finally { fs.renameSync = rename; }
      assert.equal(interrupted, true);
      const original = originalOperation(f).envelope.payload;
      for (const prefix of ['record-', 'latest-', 'rollback-history-']) {
        const file = path.join(original.receipt_store, fs.readdirSync(original.receipt_store).find(name => name.startsWith(prefix)));
        const bytes = fs.readFileSync(file), changed = JSON.parse(bytes);
        changed.payload.dispatch_id = 'foreign-record';
        const foreign = Buffer.from(JSON.stringify(changed)); fs.writeFileSync(file, foreign);
        await assert.rejects(f.run, { code: 'RECORD_FAILED' });
        assert.deepEqual(fs.readFileSync(file), foreign); assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        fs.writeFileSync(file, bytes);
      }
      const result = await f.run(); assert.equal(result.receipt.dispatch_id, original.dispatch_id);
      assert.equal(result.receipt.runtime_evidence.session_id, original.completed.session_id);
      assert.equal(f.launches, 1); assert.equal(f.pushes, 1); assertCurrent(f, result);
    } finally { signing.close(); }
  });
  test('cold high and xhigh originals retain their exact predecessor fence across completion and record transactions', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'cold-policy-package')); verifyPackage(installed);
      for (const rung of [2, 3]) for (const phase of ['native-completed', 'foreign-fence', 'marker', 'retained', 'index', 'consumed']) await t.test(`${rung}:${phase}`, bounded, async () => {
        const f = ciFixture(signing);
        f.control.source = false; f.output.status = 'no-op';
        for (let attempt = 1; attempt < rung; attempt++) {
          if (f.options.controller) {
            f.options.controller.release(f.scope.run_id, 'fixture completed predecessor handoff'); delete f.options.controller;
          }
          f.scope.run_id = 'fixture-predecessor-' + require('node:crypto').randomUUID();
          f.control.runAttempt = attempt;
          const result = await f.run(); assert.equal(result.receipt.applied_effort, ['low', 'high'][attempt - 1]);
        }
        f.options.controller.release(f.scope.run_id, 'fixture new original policy rung'); delete f.options.controller;
        f.scope.run_id = 'fixture-original-' + require('node:crypto').randomUUID();
        f.control.runAttempt = rung; f.control.source = true; f.output.status = 'fixed';
        const rename = fs.renameSync, link = fs.linkSync;
        let interrupted = false;
        const stop = destination => {
          if (interrupted || !destination.endsWith('.json')) return;
          const name = path.basename(destination), value = JSON.parse(fs.readFileSync(destination)).payload;
          const hit = ['native-completed', 'foreign-fence'].includes(phase) ? destination.includes('ci-originals') && value?.completed && value.output
            : phase === 'marker' ? name.startsWith('repair-commit-')
              : phase === 'retained' ? name.startsWith('reservation-') && value?.original_record
                : phase === 'index' ? name.startsWith('latest-') : name.startsWith('consumed-');
          if (hit) { interrupted = true; throw new Error('fixture original predecessor interruption at ' + phase); }
        };
        fs.renameSync = (source, destination, ...args) => { const result = rename(source, destination, ...args); stop(destination); return result; };
        fs.linkSync = (source, destination, ...args) => { const result = link(source, destination, ...args); stop(destination); return result; };
        try { await assert.rejects(f.run); } finally { fs.renameSync = rename; fs.linkSync = link; }
        assert.equal(interrupted, true); assert.equal(f.launches, rung); assert.equal(f.pushes, 0);
        const before = originalOperation(f).envelope.payload;
        assert.ok(before.predecessor_dispatch_id); assert.equal(before.resolution.prior_applied.dispatch_id, before.predecessor_dispatch_id);
        if (phase === 'marker') {
          const recorder = boundary.createDurableRecorder(before.receipt_store);
          const retained = inventory(before.receipt_store);
          assert.equal(recorder.isConsumed(before.predecessor_dispatch_id), true);
          assert.equal(recorder.claim(before.predecessor_dispatch_id, 'foreign-marker-reader').claimed, false);
          assert.deepEqual(inventory(before.receipt_store), retained);
        }
        if (['native-completed', 'foreign-fence'].includes(phase)) {
          const claim = path.join(before.receipt_store, 'claim-' + hash(before.predecessor_dispatch_id) + '.json');
          const retained = JSON.parse(fs.readFileSync(claim)); retained.lease_expires_at = '2000-01-01T00:00:00.000Z';
          fs.writeFileSync(claim, JSON.stringify(retained));
        }
        if (phase === 'foreign-fence') {
          const recorder = boundary.createDurableRecorder(before.receipt_store);
          const claim = recorder.claim(before.predecessor_dispatch_id, 'foreign-' + require('node:crypto').randomUUID());
          assert.equal(claim.claimed, true);
          const retained = inventory(before.receipt_store);
          coldOriginal(f, installed, 'RECORD_FAILED');
          assert.deepEqual(inventory(before.receipt_store), retained);
          assert.equal(f.launches, rung); assert.equal(f.pushes, 0); return;
        }
        const result = coldOriginal(f, installed);
        assert.equal(result.receipt.dispatch_id, before.dispatch_id);
        assert.equal(result.receipt.runtime_evidence.session_id, before.completed.session_id);
        assert.equal(result.receipt.applied_effort, rung === 2 ? 'high' : 'xhigh');
        const recorder = boundary.createDurableRecorder(before.receipt_store), record = recorder.getVerifiedRecord(before.dispatch_id);
        assert.equal(record.predecessor_dispatch_id, before.predecessor_dispatch_id);
        assert.equal(recorder.getLatestReceipt('codex', 'ci-fix').dispatch_id, before.dispatch_id);
        const consumed = JSON.parse(fs.readFileSync(path.join(before.receipt_store, 'consumed-' + hash(before.predecessor_dispatch_id) + '.json'))).payload;
        assert.equal(consumed.consumer_id, before.dispatch_id);
        const reservation = JSON.parse(fs.readFileSync(path.join(before.receipt_store, 'reservation-' + hash(before.dispatch_id) + '.json'))).payload;
        assert.equal(consumed.claim_token, reservation.original_subject.claim.claim_token);
        assert.equal(consumed.claim_generation, reservation.original_subject.claim.generation);
        assert.equal(f.launches, rung); assertCurrent(f, result);
      });
    } finally { signing.close(); }
  });
  test('native CI launch exposes exact bounded failure bytes through an external read-only input view', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing);
      f.control.source = false; f.output.status = 'no-op';
      const prepared = host.prepareCiRepair(f.options, f.scope, f.request.context);
      const view = prepared.repair.evidence.model_input;
      assert.equal(view.mode & 0o777, 0o400);
      assert.equal(view.sha256, hash(f.failureBytes)); assert.equal(view.bytes, f.failureBytes.length);
      assert.equal(view.path.startsWith(prepared.stateRoot + path.sep), false);
      assert.equal(view.path.startsWith(f.worktree + path.sep), false);
      let reads = 0;
      f.control.inspectInput = (prompt, args) => {
        const quoted = prompt.split('Read the complete authenticated read-only failure input: ')[1].split('\n')[0];
        assert.equal(JSON.parse(quoted), view.path);
        assert.ok(args.some(arg => /^permissions\.[^.]+\.extends=":workspace"$/.test(arg)));
        const filesystem = args.find(arg => /^permissions\.[^.]+\.filesystem=/.test(arg));
        assert.ok(filesystem);
        const denied = [...filesystem.matchAll(/("(?:[^"\\]|\\.)*")="deny"/g)].map(match => JSON.parse(match[1]));
        assert.ok(denied.includes(prepared.stateRoot));
        assert.equal(denied.some(file => view.path === file || view.path.startsWith(file + path.sep)), false);
        assert.equal(filesystem.includes('="write"'), false);
        const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]));', view.path],
          { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(child.status, 0, String(child.stderr)); assert.deepEqual(child.stdout, f.failureBytes); reads++;
      };
      await f.run(); assert.equal(reads, 1); assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
    } finally { signing.close(); }
  });
  test('CI input-view and original substitutions refuse before launch or after original completion without publication', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['view-bytes', 'view-replacement', 'view-symlink', 'original', 'private-copy', 'late-view']) await t.test(mutation, bounded, async () => {
        const f = ciFixture(signing), prepared = host.prepareCiRepair(f.options, f.scope, f.request.context);
        const evidence = prepared.repair.evidence, view = evidence.model_input.path;
        const change = () => {
          if (mutation === 'view-replacement') {
            fs.renameSync(view, view + '.original'); fs.writeFileSync(view, f.failureBytes, { mode: 0o400 });
          } else if (mutation === 'view-symlink') { fs.unlinkSync(view); fs.symlinkSync(f.failureFile, view); }
          else {
            const target = mutation === 'original' ? f.failureFile : mutation === 'private-copy' ? evidence.path : view;
            if (target === view) fs.chmodSync(target, 0o600);
            fs.writeFileSync(target, Buffer.alloc(f.failureBytes.length, 120));
          }
        };
        if (mutation === 'late-view') f.control.inspectInput = change;
        else change();
        const run = () => f.run();
        if (mutation === 'late-view') await assert.rejects(run);
        else await assert.rejects(run, { code: 'CI_EVIDENCE_CHANGED' });
        assert.throws(() => host.prepareCiRepair(f.options, f.scope, f.request.context), { code: 'CI_EVIDENCE_CHANGED' });
        assert.equal(f.launches, mutation === 'late-view' ? 1 : 0); assert.equal(f.pushes, 0);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
      });
    } finally { signing.close(); }
  });
  test('late failure, scope and native-result changes retain the original completion and refuse signing or publication', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['failure', 'plan', 'graph', 'native-final']) await t.test(mutation, bounded, async () => {
        const f = ciFixture(signing), graphFile = path.join(f.graphDir, 'tickets.json');
        const planBytes = fs.readFileSync(f.plan), graphBytes = fs.readFileSync(graphFile);
        f.control.mutateNative = (rows, cli) => {
          if (mutation === 'failure') fs.appendFileSync(f.failureFile, 'late bytes');
          if (mutation === 'plan') fs.appendFileSync(f.plan, '\nlate plan');
          if (mutation === 'graph') fs.appendFileSync(graphFile, '\n');
          if (mutation === 'native-final') rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text = 'foreign original result';
        };
        await assert.rejects(f.run); assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
        fs.writeFileSync(f.failureFile, f.failureBytes); fs.writeFileSync(f.plan, planBytes); fs.writeFileSync(graphFile, graphBytes);
        if (mutation !== 'native-final') {
          f.control.mutateNative = null;
          const retained = originalOperation(f).envelope.payload; assert.ok(retained.completed.session_id);
          const result = await f.run(); assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
          assert.equal(result.receipt.runtime_evidence.session_id, retained.completed.session_id); assertCurrent(f, result);
        }
      });
    } finally { signing.close(); }
  });
  test('CI uses genuine low/high/xhigh predecessors and refuses the exhausted ceiling without relaunch', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing); f.control.source = false; f.output.status = 'no-op';
      f.failureBytes.fill(32); f.failureBytes.write('TypeError tests/alpha.test.cjs\n');
      fs.writeFileSync(f.failureFile, f.failureBytes);
      f.request.context.evidence_sha256 = hash(f.failureBytes);
      for (let attempt = 1; attempt <= 3; attempt++) {
        f.control.runAttempt = attempt;
        const result = await f.run(); assert.equal(result.receipt.role, 'ci-fix');
        assert.equal(result.receipt.applied_effort, ['low', 'high', 'xhigh'][attempt - 1]);
        const original = originalOperation(f).envelope.payload;
        assert.equal(original.resolution.prior_applied?.dispatch_id || null, attempt === 1 ? null : original.predecessor_dispatch_id);
      }
      f.control.runAttempt = 4; await assert.rejects(f.run, { code: 'REPAIR_POLICY_EXHAUSTED' });
      assert.equal(f.launches, 3); assert.equal(f.pushes, 0);
      assert.deepEqual(f.selections.map(item => item.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol']);
      f.failureBytes.fill(32); f.failureBytes.write('TypeError tests/bravo.test.cjs\n');
      const progressed = path.join(signing.directory, 'new-current-progress.log'); fs.writeFileSync(progressed, f.failureBytes, { mode: 0o600 });
      f.request.context.evidence_path = progressed; f.request.context.evidence_sha256 = hash(f.failureBytes);
      const reset = await f.run(); assert.equal(reset.receipt.applied_effort, 'low'); assert.equal(f.launches, 4);
      const directory = path.join(f.stateRoot, 'ci-originals');
      const op = fs.readdirSync(directory).map(name => JSON.parse(fs.readFileSync(path.join(directory, name))).payload)
        .find(value => value.dispatch_id === reset.receipt.dispatch_id);
      assert.equal(op.predecessor_dispatch_id, null); assert.equal(op.resolution.signals.signatureState, 'first');
      const recorder = boundary.createDurableRecorder(op.receipt_store), before = JSON.stringify(recorder.getVerifiedRecord(op.dispatch_id));
      for (const forged of [{}, { ...op }, JSON.parse(JSON.stringify(op))]) {
        assert.throws(() => boundary.createDispatchBoundary({ recorder, originalCiOperation: forged })
          .reconcileOriginal(op.dispatch_id, { ticket: f.scope.ticket }), { code: 'CI_ORIGINAL_INVALID' });
        assert.equal(JSON.stringify(recorder.getVerifiedRecord(op.dispatch_id)), before);
      }
    } finally { signing.close(); }
  });
  test('whole supported package has complete independent inventory, two content identities and separate physical tamper refusals', bounded, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-package-')));
    try {
      const staged = packageSource(path.join(directory, 'source')), entries = verifyPackage(staged);
      verifySourceMirrors(path.join(directory, 'source'), staged);
      assert.deepEqual(entries, inventory(path.join(root, 'plugins/shipyard')));
      for (const relative of ['host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs', 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs',
        'host/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs', 'host/plugins/delivery-pipeline/scripts/base-merge.cjs', ...identities]) {
        const file = path.join(staged, relative), original = fs.readFileSync(file);
        fs.appendFileSync(file, 'tamper'); assert.throws(() => verifyPackage(staged)); fs.writeFileSync(file, original); verifyPackage(staged);
      }
      const canonical = path.join(directory, 'source/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
      const bytes = fs.readFileSync(canonical); fs.appendFileSync(canonical, '\nvoid "canonical mutation";\n');
      assert.throws(() => verifySourceMirrors(path.join(directory, 'source'), staged));
      fs.writeFileSync(canonical, bytes); verifySourceMirrors(path.join(directory, 'source'), staged);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('actual z29x/y/z append once after first51 and preserve first50 and dynamic future denominators', bounded, () => {
    const shards = require('./shard-files.cjs'), frozen = shards.readManifest();
    const names = ['phase53-z29x-native-ci-fix-contract.test.cjs', 'phase53-z29y-native-ci-fix-recovery.test.cjs', 'phase53-z29z-generated-base-merge.test.cjs'];
    const prerequisites = ['phase53-z29a-fixer-original-custody.test.cjs', 'phase53-z29b-fixer-source-history.test.cjs',
      'phase53-z29c-historical-direct.test.cjs', 'phase53-z29d-historical-admitted.test.cjs', 'phase53-z29e-historical-pending.test.cjs',
      'phase53-z29f-historical-action-repeat.test.cjs', 'phase53-z29g-historical-action-covered.test.cjs',
      'phase53-z29h-publication-unsent-recovery.test.cjs', 'phase53-z29i-recorded-integration-compatibility.test.cjs',
      'phase53-z29t-role-architecture-archives.test.cjs', 'phase53-z29u-role-containment.test.cjs',
      'phase53-z29v-role-code-review.test.cjs', 'phase53-z29w-role-integration.test.cjs'];
    const baseline = require('./phase53-z29g-historical-action-covered.test.cjs').original.shards;
    const historicalFiles = [...new Set([...baseline.flat().map(task => shards.parseTask(task).file), ...names])];
    assert.ok(historicalFiles.every(name => !prerequisites.includes(name)));
    const tasks = shards.unitTasks(historicalFiles);
    const delivered = shards.appendShard(frozen, tasks.filter(task => !names.includes(task)));
    assert.equal(delivered.shards.length, 51);
    assert.equal(hash(JSON.stringify(delivered.shards.slice(0, 50))), 'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
    const next = shards.appendShard(delivered, tasks); assert.equal(next.shards.length, 54);
    assert.deepEqual(next.shards.slice(0, 51), delivered.shards); assert.deepEqual(next.shards.slice(51), names.map(name => [name]));
    assert.deepEqual(shards.appendShard(next, tasks), next); assert.deepEqual(next.shards.slice(0, 16), frozen.shards.slice(0, 16));
    for (const name of names) assert.ok(name > 'phase53-z29-semantic-final-catalog-duplication.test.cjs' && name < 'phase53-z30-semantic-material-retention.test.cjs');
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-shards-')));
    try {
      for (const name of historicalFiles) fs.writeFileSync(path.join(directory, name), '');
      fs.writeFileSync(path.join(directory, 'phase53-z99-future.test.cjs'), '');
      const future = shards.appendShard(next, shards.unitTasks(shards.unitFiles(directory)));
      assert.equal(future.shards.length, next.shards.length + 1);
      assert.deepEqual(future.shards.slice(0, next.shards.length), next.shards);
      assert.deepEqual(shards.selectTaskShard(`${future.shards.length}/${future.shards.length}`, directory, next), ['phase53-z99-future.test.cjs']);
      assert.throws(() => shards.selectTaskShard(`${next.shards.length}/${next.shards.length}`, directory, next));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('complete physical discovery retains first58 and first60 prefixes and current64 to67 plus every future selector', bounded, () => {
    const shards = require('./shard-files.cjs'), frozen = shards.readManifest();
    const baseline = require('./phase53-z29g-historical-action-covered.test.cjs').original.shards;
    const files = shards.unitFiles(), tasks = shards.unitTasks(files);
    const seven = ['phase53-z29a-fixer-original-custody.test.cjs', 'phase53-z29b-fixer-source-history.test.cjs',
      'phase53-z29c-historical-direct.test.cjs', 'phase53-z29d-historical-admitted.test.cjs', 'phase53-z29e-historical-pending.test.cjs',
      'phase53-z29f-historical-action-repeat.test.cjs', 'phase53-z29g-historical-action-covered.test.cjs'];
    const two = ['phase53-z29h-publication-unsent-recovery.test.cjs', 'phase53-z29i-recorded-integration-compatibility.test.cjs'];
    const four = ['phase53-z29t-role-architecture-archives.test.cjs', 'phase53-z29u-role-containment.test.cjs',
      'phase53-z29v-role-code-review.test.cjs', 'phase53-z29w-role-integration.test.cjs'];
    const three = ['phase53-z29x-native-ci-fix-contract.test.cjs', 'phase53-z29y-native-ci-fix-recovery.test.cjs', 'phase53-z29z-generated-base-merge.test.cjs'];
    const historicalTasks = shards.unitTasks([...new Set([...baseline.flat().map(task => shards.parseTask(task).file), ...seven, ...two, ...four])]);
    const before = shards.appendShard(frozen, historicalTasks);
    assert.equal(before.shards.length, 64); assert.equal(before.shards.length + 3, 67);
    assert.deepEqual(before.shards.slice(0, 51), baseline);
    assert.deepEqual(before.shards.slice(51, 58), seven.map(file => [file]));
    assert.deepEqual(before.shards.slice(58, 60), two.map(file => [file]));
    assert.deepEqual(before.shards.slice(60), four.map(file => [file]));
    const actual = shards.appendShard(frozen, tasks);
    assert.equal(actual.shards.length, 64 + tasks.filter(task => !historicalTasks.includes(task)).length);
    assert.deepEqual(actual.shards.slice(0, 64), before.shards);
    assert.deepEqual(actual.shards.slice(64), tasks.filter(task => !historicalTasks.includes(task)).map(file => [file]));
    for (const name of three) assert.equal(actual.shards.flat().filter(task => task === name).length, 1);
    assert.deepEqual(actual.shards.slice(0, 16), frozen.shards.slice(0, 16));
    assert.equal(hash(JSON.stringify(actual.shards.slice(0, 50))), 'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
    assert.deepEqual([...actual.shards.flat()].sort(), tasks); assert.equal(new Set(actual.shards.flat()).size, tasks.length);
    for (let index = 0; index < actual.shards.length; index++)
      assert.deepEqual(shards.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-full-prefix-')));
    try {
      for (const name of files) fs.writeFileSync(path.join(directory, name), '');
      const future = ['phase53-z30-semantic-material-retention.test.cjs', 'phase53-z30b-semantic-material-retention.test.cjs',
        'phase53-z30c-semantic-material-retention.test.cjs', 'phase53-z30d-semantic-material-retention.test.cjs',
        'phase53-z30e-semantic-material-retention.test.cjs', 'phase53-z30f-semantic-material-retention.test.cjs'];
      for (const name of future) fs.writeFileSync(path.join(directory, name), '');
      const discovered = shards.unitTasks(shards.unitFiles(directory)), next = shards.appendShard(actual, discovered);
      const additions = future.filter(name => !files.includes(name));
      assert.equal(next.shards.length, actual.shards.length + additions.length);
      assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards);
      assert.deepEqual(next.shards.slice(actual.shards.length), additions.map(file => [file]));
      assert.deepEqual([...next.shards.flat()].sort(), discovered); assert.equal(new Set(next.shards.flat()).size, discovered.length);
      for (let index = 0; index < next.shards.length; index++)
        assert.deepEqual(shards.selectTaskShard(`${index + 1}/${next.shards.length}`, directory, actual), next.shards[index]);
      if (additions.length) assert.throws(() => shards.selectTaskShard(`1/${actual.shards.length}`, directory, actual));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

}
module.exports = { inventory, verifyPackage, verifySourceMirrors, packageSource, originalOperation };
