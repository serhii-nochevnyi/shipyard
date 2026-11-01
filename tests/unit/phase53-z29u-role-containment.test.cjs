'use strict';

const { createRoleArtifactFixture, createRoleArtifactLifecycle } = require('./helpers/phase53-role-artifact-fixture.cjs');

function registerRoleArtifacts(test, context) {
  const {
    require, module, unitDir: __dirname, assert, suite, fs, path, os, execFileSync, spawnSync,
    testAuthorityArgs, ROLE_ARTIFACT, roleArtifact, git, fixture, runFixture, clean, phaseScopeFixture, cleanPhaseScope,
  } = context;

function containmentAuthorityFixture(value = fixture(), leaseEpoch = 1) {
  const crypto = require('node:crypto');
  const root = fs.realpathSync(value.root);
  const binding = { launch: { scope: { worktree: root, run_id: 'original-run', ticket: value.ticket, phase: 47, runtime: 'codex', provider: 'openai' },
    dispatch_id: 'original-dispatch', gsd_role: 'gsd-planner', role: 'decomposition',
    request_sha256: '1'.repeat(64), policy_hash: '2'.repeat(64), policy_version: 'original-policy',
    model: 'gpt-6.1-sol', effort: 'low', rung: 'base',
    agent: { file: path.join(root, 'agent.toml'), sha256: '3'.repeat(64), instructions_sha256: '6'.repeat(64) } },
    launched_at: '2026-10-08T00:00:00.000Z', reservation: { dispatch_id: 'original-dispatch', reserved_at: 'original-reservation' },
    source_revision: git(root, ['rev-parse', 'HEAD']), writer_lease_file: path.join(root, 'lease.json'),
    lease_epoch: leaseEpoch, lease_identity_sha256: '4'.repeat(64), tree_snapshot_sha256: '5'.repeat(64) };
  const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
  const token = sealer.captureContainmentBaseline({ worktree: root });
  const reference = sealer.persistContainmentBaseline({ worktree: root, baseline: token, binding });
  const directory = roleArtifact.archiveAuthorityDirectory(root);
  const file = path.join(directory, reference.reference);
  const read = (overrides = {}) => roleArtifact.readPlanningContainmentBaseline({ worktree: root, binding, reference, ...overrides });
  const snapshot = read();
  const register = (overrides = {}) => roleArtifact.registerPlanningContainmentBaseline({ worktree: root, binding, snapshot, ...overrides });
  return { value, root, binding, sealer, token, reference, directory, file, read, register, snapshot, crypto };
}

suite('original protected planning containment');

test('phase47 original containment recovery preserves a pre-existing deleted tracked parent directory', () => {
  const value = fixture();
  try {
    const directory = path.join(value.root, 'src', 'nested');
    const relative = 'src/nested/tracked.cjs';
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(value.root, relative), 'original tracked source\n');
    git(value.root, ['add', relative]);
    git(value.root, ['commit', '-m', 'tracked parent fixture']);
    fs.rmSync(path.join(value.root, 'src'), { recursive: true });
    const c = containmentAuthorityFixture(value);
    assert.deepEqual(c.snapshot.sources.find(([key]) => key === relative), [relative, null]);
    assert.deepEqual(c.snapshot.status.find(([key]) => key === relative), [relative, ' D']);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference: c.reference, recoveredEpoch: 2 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(value.root, relative), 'original tracked source\n');
    assert.throws(() => c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored }),
      { code: 'CONTAINMENT_VIOLATION' });
  } finally { clean(value); }
});

for (const kind of ['ENOTDIR', 'EACCES', 'symlink', 'file', 'movement']) {
  test('phase47 original containment recovery deleted tracked parent inspection ' + kind, () => {
    const value = fixture();
    const lstat = fs.lstatSync;
    try {
      const root = fs.realpathSync(value.root);
      const directory = path.join(root, 'src', 'nested');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'tracked.cjs'), 'tracked source\n');
      git(root, ['add', 'src/nested/tracked.cjs']);
      git(root, ['commit', '-m', 'tracked parent inspection fixture']);
      fs.rmSync(directory, { recursive: true });
      if (kind === 'symlink') fs.symlinkSync(root, directory);
      if (kind === 'file') fs.writeFileSync(directory, 'physical file');
      let inspected = false;
      fs.lstatSync = function(target, ...args) {
        if (target === directory) {
          inspected = true;
          if (kind === 'ENOTDIR' || kind === 'EACCES')
            throw Object.assign(new Error('injected parent inspection error'), { code: kind });
          if (kind === 'movement') fs.writeFileSync(path.join(root, 'src', 'changed'), 'changed parent');
        }
        return lstat.call(this, target, ...args);
      };
      const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
      if (kind === 'ENOTDIR') {
        const baseline = sealer.captureContainmentBaseline({ worktree: root });
        sealer.assertContained({ worktree: root, allowed: [], baseline });
      } else assert.throws(() => sealer.captureContainmentBaseline({ worktree: root }),
        { code: kind === 'EACCES' ? 'EACCES' : kind === 'movement' ? 'CONTAINMENT_VIOLATION' : 'CONTAINMENT_STATUS_FAILED' });
      assert.equal(inspected, true);
    } finally { fs.lstatSync = lstat; clean(value); }
  });
}

test('phase47 original containment recovery preserves an unchanged untracked nested repository directory', () => {
  const value = fixture();
  try {
    const vendor = path.join(value.root, 'vendor');
    fs.mkdirSync(vendor);
    git(vendor, ['init']);
    fs.writeFileSync(path.join(vendor, 'nested.txt'), 'original nested repository content\n');
    assert.ok(git(value.root, ['status', '--porcelain=v1', '--untracked-files=all']).includes('?? vendor/'));
    const c = containmentAuthorityFixture(value);
    assert.deepEqual(c.snapshot.status.find(([key]) => key === 'vendor/'), ['vendor/', '??']);
    assert.match(c.snapshot.sources.find(([key]) => key === 'vendor/')[1], /^\d+:directory-sha256:[a-f0-9]{64}$/);
    assert.equal(c.snapshot.sources.some(([key]) => key === 'vendor'), false);
    const bytes = fs.readFileSync(c.file);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference: c.reference, recoveredEpoch: 2 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    assert.deepEqual(c.read(), c.snapshot);
    assert.deepEqual(c.sealer.persistContainmentBaseline({ worktree: c.root, baseline: restored,
      binding: c.binding }), c.reference);
    assert.deepEqual(fs.readFileSync(c.file), bytes);
    assert.equal(fs.readFileSync(path.join(vendor, 'nested.txt'), 'utf8'), 'original nested repository content\n');
  } finally { clean(value); }
});

test('phase47 original containment recovery refuses authenticated legacy directory-only restoration', () => {
  const value = fixture();
  try {
    const vendor = path.join(value.root, 'vendor');
    fs.mkdirSync(vendor); git(vendor, ['init']);
    const c = containmentAuthorityFixture(value);
    const envelope = JSON.parse(fs.readFileSync(c.file));
    const entry = envelope.payload.snapshot.sources.find(([key]) => key === 'vendor/');
    entry[1] = entry[1].split(':')[0] + ':directory';
    const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
      : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
        : JSON.stringify(value);
    const payload = stable(envelope.payload);
    envelope.mac = c.crypto.createHmac('sha256', fs.readFileSync(path.join(c.directory, 'hmac.key'))).update(payload).digest('hex');
    fs.writeFileSync(c.file, JSON.stringify(envelope));
    const reference = { ...c.reference, sha256: c.crypto.createHash('sha256').update(payload).digest('hex') };
    const bytes = fs.readFileSync(c.file);
    assert.throws(() => c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference, recoveredEpoch: 2 }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  } finally { clean(value); }
});

test('phase47 original containment recovery refuses movement during directory inspection', () => {
  const value = fixture();
  const read = fs.readSync;
  try {
    const vendor = path.join(value.root, 'vendor');
    fs.mkdirSync(vendor); git(vendor, ['init']);
    const file = path.join(vendor, 'nested.txt');
    fs.writeFileSync(file, 'original');
    const inode = fs.statSync(file).ino;
    let mutated = false;
    fs.readSync = function(fd, ...args) {
      const result = read.call(this, fd, ...args);
      if (!mutated && fs.fstatSync(fd).ino === inode) {
        mutated = true; fs.appendFileSync(file, 'changed during inspection');
      }
      return result;
    };
    const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
    assert.throws(() => sealer.captureContainmentBaseline({ worktree: value.root }), { code: 'CONTAINMENT_VIOLATION' });
    assert.equal(mutated, true);
  } finally { fs.readSync = read; clean(value); }
});

for (const kind of ['symlink', 'unsupported', 'depth', 'entries', 'bytes', 'gitPointer'])
  test('phase47 original containment recovery bounds rooted directory ' + kind, () => {
    const value = fixture();
    try {
      const vendor = path.join(value.root, 'vendor');
      fs.mkdirSync(vendor);
      git(vendor, ['init']);
      if (kind === 'unsupported') require('node:child_process').execFileSync('mkfifo', [path.join(vendor, 'pipe')]);
      if (kind === 'symlink') fs.symlinkSync(path.dirname(value.root), path.join(vendor, 'escape'));
      if (kind === 'depth') {
        let current = vendor;
        for (let i = 0; i < 33; i++) { current = path.join(current, 'd'); fs.mkdirSync(current); }
      }
      if (kind === 'entries') for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(vendor, 'f' + i), '');
      if (kind === 'bytes') {
        const fd = fs.openSync(path.join(vendor, 'large'), 'w');
        try { fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
      }
      const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
      if (kind === 'gitPointer') {
        const linked = path.join(vendor, 'linked');
        fs.mkdirSync(linked);
        fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /outside/root\n');
        const c = containmentAuthorityFixture(value);
        sealer.assertContained({ worktree: c.root, allowed: [], baseline: c.token });
        fs.appendFileSync(path.join(linked, '.git'), 'changed pointer bytes\n');
        assert.throws(() => sealer.assertContained({ worktree: c.root, allowed: [], baseline: c.token }),
          { code: 'CONTAINMENT_VIOLATION' });
      } else assert.throws(() => sealer.captureContainmentBaseline({ worktree: value.root }),
        { code: 'CONTAINMENT_STATUS_FAILED' });
    } finally { clean(value); }
  });

for (const [name, bytes] of Object.entries({ truncated: '{"payload":', emptyObject: '{}', null: 'null',
  missingPayload: '{"mac":"' + '0'.repeat(64) + '"}', nullPayload: '{"payload":null}',
  malformedMac: '{"payload":{},"mac":[]}' }))
  test('phase47 original containment recovery rejects malformed protected JSON ' + name, () => {
    const c = containmentAuthorityFixture();
    try {
      fs.writeFileSync(c.file, bytes);
      assert.throws(() => c.read(), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
      assert.equal(fs.readFileSync(c.file, 'utf8'), bytes);
    } finally { clean(c.value); }
  });

test('phase47 original containment recovery authenticates initial epoch zero and requires its exact successor', () => {
  const c = containmentAuthorityFixture(fixture(), 0);
  try {
    assert.equal(c.read().head, c.binding.source_revision);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference: c.reference, recoveredEpoch: 1 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    for (const recoveredEpoch of [0, 2])
      assert.throws(() => c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
        reference: c.reference, recoveredEpoch }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    const binding = structuredClone(c.binding);
    binding.lease_epoch = -1;
    assert.throws(() => c.register({ binding }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
  } finally { clean(c.value); }
});

test('phase47 original containment recovery private token persistence is immutable and restores only authenticated authority', () => {
  const c = containmentAuthorityFixture();
  try {
    const bytes = fs.readFileSync(c.file);
    assert.deepEqual(c.register(), c.reference);
    assert.deepEqual(c.sealer.persistContainmentBaseline({ worktree: c.root, baseline: c.token, binding: c.binding }), c.reference);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding, reference: c.reference, recoveredEpoch: 2 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    const replacement = structuredClone(c.binding);
    replacement.launch.dispatch_id = 'replacement-dispatch';
    replacement.reservation.dispatch_id = 'replacement-dispatch';
    for (const baseline of [c.token, restored])
      assert.throws(() => c.sealer.persistContainmentBaseline({ worktree: c.root, baseline, binding: replacement }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    assert.throws(() => c.sealer.persistContainmentBaseline({ worktree: c.root, baseline: {}, binding: c.binding }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    assert.throws(() => c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: c.snapshot }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    assert.throws(() => c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding, reference: c.reference, recoveredEpoch: 3 }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    const changed = structuredClone(c.snapshot); changed.index = '0'.repeat(64);
    assert.throws(() => c.register({ snapshot: changed }), /immutable/);
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  } finally { clean(c.value); }
});

for (const [name, mutate] of Object.entries({
  duplicate(s) { s.sources.push(s.sources[0]); },
  escaped(s) { s.sources[0][0] = '../escape'; },
  absolute(s) { s.sources[0][0] = '/escape'; },
  repeatedSlash(s) { s.sources[0][0] = 'vendor//'; },
  interiorSlash(s) { s.sources[0][0] = 'vendor//child/'; },
  traversalSlash(s) { s.sources[0][0] = 'vendor/../'; },
  dotSlash(s) { s.sources[0][0] = 'vendor/./'; },
  absoluteSlash(s) { s.sources[0][0] = '/vendor/'; },
  backslash(s) { s.sources[0][0] = 'a\\b'; },
  unsorted(s) { s.sources.reverse(); },
  missing(s) { delete s.sources; },
  legacyDirectory(s) { s.sources[0][1] = '16877:directory'; },
  badIdentity(s) { s.sources[0][1] = 'unbound'; },
  badStatus(s) { s.status = [['absent', '??']]; },
  wrongHead(s) { s.head = '0'.repeat(40); },
  wrongRoot(s) { s.root += '-other'; },
})) test('phase47 original containment recovery rejects ' + name + ' serialized map', () => {
  const c = containmentAuthorityFixture();
  try {
    const snapshot = structuredClone(c.snapshot); mutate(snapshot);
    const bytes = fs.readFileSync(c.file);
    assert.throws(() => c.register({ snapshot }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  } finally { clean(c.value); }
});

for (const [name, mutate] of Object.entries({
  run(b) { b.launch.scope.run_id += '-other'; },
  ticket(b) { b.launch.scope.ticket += '-other'; },
  phase(b) { b.launch.scope.phase++; },
  dispatch(b) { b.launch.dispatch_id += '-other'; },
  request(b) { b.launch.request_sha256 = '0'.repeat(64); },
  policy(b) { b.launch.policy_hash = '0'.repeat(64); },
  generatedSelection(b) { b.launch.generated_agent = { file: 'other.toml', sha256: '0'.repeat(64) }; },
  source(b) { b.source_revision = '0'.repeat(40); },
  lease(b) { b.lease_epoch++; },
  leaseIdentity(b) { b.lease_identity_sha256 = '0'.repeat(64); },
  leaseFile(b) { b.writer_lease_file += '-other'; },
  tree(b) { b.tree_snapshot_sha256 = '0'.repeat(64); },
  launchTime(b) { b.launched_at = '2026-10-08T01:00:00.000Z'; },
  reservation(b) { b.reservation.reserved_at += '-other'; },
})) test('phase47 original containment recovery rejects cross-launch ' + name + ' binding', () => {
  const c = containmentAuthorityFixture();
  try {
    const binding = structuredClone(c.binding); mutate(binding);
    assert.throws(() => c.read({ binding }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
  } finally { clean(c.value); }
});

for (const name of ['payload', 'mac', 'digest', 'reference', 'missing', 'symlink', 'oversized', 'publicSnapshot', 'otherWorktree'])
  test('phase47 original containment recovery authenticates protected ' + name, () => {
    const c = containmentAuthorityFixture();
    let other;
    try {
      const envelope = JSON.parse(fs.readFileSync(c.file));
      let overrides = {};
      if (name === 'payload') { envelope.payload.snapshot.index = '0'.repeat(64); fs.writeFileSync(c.file, JSON.stringify(envelope)); }
      if (name === 'mac') { envelope.mac = '0'.repeat(64); fs.writeFileSync(c.file, JSON.stringify(envelope)); }
      if (name === 'digest') overrides.reference = { ...c.reference, sha256: '0'.repeat(64) };
      if (name === 'reference') overrides.reference = { ...c.reference, reference: '../hmac.key' };
      if (name === 'missing') fs.unlinkSync(c.file);
      if (name === 'symlink') { fs.unlinkSync(c.file); fs.symlinkSync(path.join(c.directory, 'hmac.key'), c.file); }
      if (name === 'oversized') fs.writeFileSync(c.file, Buffer.alloc(4 * 1024 * 1024 + 1));
      if (name === 'publicSnapshot') overrides.reference = c.snapshot;
      if (name === 'otherWorktree') { other = fixture(); overrides.worktree = fs.realpathSync(other.root); }
      assert.throws(() => c.read(overrides));
    } finally { clean(c.value); if (other) clean(other); }
  });

for (const archived of [false, true]) test('phase47 original containment recovery retains missing original key with ' + (archived ? 'archive/source records' : 'baseline only'), () => {
  const value = archived ? phaseScopeFixture() : fixture();
  const c = containmentAuthorityFixture(value);
  try {
    const retained = fs.readdirSync(c.directory).filter(name => name !== 'hmac.key')
      .map(name => [name, fs.readFileSync(path.join(c.directory, name))]);
    const archivePins = archived ? value.rows.flatMap(row => row.pins.map(pin => [path.join(row.worktree, pin.path), fs.readFileSync(path.join(row.worktree, pin.path))])) : [];
    fs.unlinkSync(path.join(c.directory, 'hmac.key'));
    assert.throws(() => c.register(), /original authority key/);
    assert.throws(() => c.read());
    assert.equal(fs.existsSync(path.join(c.directory, 'hmac.key')), false);
    for (const [name, bytes] of retained) assert.deepEqual(fs.readFileSync(path.join(c.directory, name)), bytes);
    for (const [file, bytes] of archivePins) assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { if (archived) cleanPhaseScope(value); else clean(value); }
});

for (const mutation of ['missingAuthority', 'missingStore', 'missingKey', 'invalidKey', 'foreignKey', 'symlinkKey', 'symlinkStore', 'symlinkRecord', 'broadKey', 'oversizedRecord', 'tamper', 'legacy'])
  test('F2 readonly original receipt authority refuses without mutation: ' + mutation, async () => {
    const value = await runFixture();
    try {
      const crypto = require('node:crypto');
      const store = path.resolve(value.receipts);
      const key = path.join(path.dirname(store), '.shipyard-dispatch-authority-' + crypto.createHash('sha256').update(store).digest('hex') + '.key');
      const dispatchId = value.result[0].receipt.dispatch_id;
      const record = path.join(store, 'record-' + crypto.createHash('sha256').update(dispatchId).digest('hex') + '.json');
      if (mutation === 'missingAuthority') { fs.rmSync(store, {recursive:true}); fs.unlinkSync(key); }
      if (mutation === 'missingStore') fs.rmSync(store, {recursive:true});
      if (mutation === 'missingKey') fs.unlinkSync(key);
      if (mutation === 'invalidKey') fs.writeFileSync(key, 'invalid');
      if (mutation === 'foreignKey') fs.writeFileSync(key, Buffer.alloc(32, 7));
      if (mutation === 'symlinkKey') { fs.renameSync(key, key + '.original'); fs.symlinkSync(key + '.original', key); }
      if (mutation === 'symlinkStore') { fs.renameSync(store, store + '.original'); fs.symlinkSync(store + '.original', store); }
      if (mutation === 'symlinkRecord') { fs.renameSync(record, record + '.original'); fs.symlinkSync(record + '.original', record); }
      if (mutation === 'broadKey') fs.chmodSync(key, 0o644);
      if (mutation === 'oversizedRecord') fs.writeFileSync(record, Buffer.alloc(16 * 1024 * 1024 + 1));
      if (mutation === 'tamper') { const raw = JSON.parse(fs.readFileSync(record)); raw.payload.receipt.launch_id += '-tampered'; fs.writeFileSync(record, JSON.stringify(raw)); }
      if (mutation === 'legacy') { const raw = JSON.parse(fs.readFileSync(record)); fs.writeFileSync(record, JSON.stringify(raw.payload)); }
      const snapshot = () => {
        const rows = [];
        const visit = dir => { for (const name of fs.readdirSync(dir).sort()) {
          const file = path.join(dir, name), stat = fs.lstatSync(file);
          rows.push([path.relative(value.root,file), stat.mode, stat.ino, stat.mtimeMs, stat.ctimeMs,
            stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file).toString('hex') : null]);
          if (stat.isDirectory()) visit(file);
        } }; visit(value.root); return rows;
      };
      const before = snapshot();
      const input = {worktreePath:value.root, ticket:value.ticket, base:'main', boundaryStore:store, dispatchId};
      for (const consumer of ['validate', 'read', 'seal']) {
        assert.throws(() => roleArtifact[consumer](input), error => ['MISSING_RECEIPT','RECORD_FAILED'].includes(error.code));
        assert.deepEqual(snapshot(), before);
      }
    } finally { clean(value); }
  });

test('F2 original durable receipt parity and genuine fresh-process DIRECT Codex validate/read', async () => {
  const fixtureAPI = require('./codex-arch-review-context.test.cjs');
  const f = fixtureAPI.fixture();
  try {
    const {validationInput:input} = await fixtureAPI.unitJudgment(f);
    const expected = roleArtifact.validateJudgmentManifest(input);
    const preload = path.join(f.storage, 'F2-disposable-direct-cli-io.cjs');
    fs.writeFileSync(preload, "require('node:os').homedir=()=>" + JSON.stringify(os.homedir()) + ";\n"
      + "const cp=require('node:child_process'),original=cp.execFileSync;cp.execFileSync=function(executable,args,options){"
      + "if(executable==='gh')return " + JSON.stringify(JSON.stringify(f.pr)) + ";"
      + "if(executable==='git'&&args.includes('fetch'))return '';return original(executable,args,options);};\n");
    const args = ['--worktree',input.worktreePath,'--role','arch-review','--ticket',input.ticket,
      '--pr',String(input.pr),'--base',input.base,'--boundary-store',path.join(f.storage,'receipts'),
      '--dispatch-id',input.dispatchId,'--artifact',input.artifactPath,'--artifact-digest',input.artifactDigest];
    const keyFiles = fs.readdirSync(f.storage).filter(name => name.startsWith('.shipyard-dispatch-authority-'));
    assert.equal(keyFiles.length, 1);
    const receiptDirectory = path.join(f.storage, 'receipts');
    const records = fs.readdirSync(receiptDirectory).sort().map(name => [name, fs.readFileSync(path.join(receiptDirectory,name))]);
    const keys = keyFiles.map(name => [name, fs.readFileSync(path.join(f.storage,name))]);
    for (const command of ['validate','read']) {
      const result = spawnSync(process.execPath, ['--require',preload,ROLE_ARTIFACT,command,...args],
        {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /assertArchiveInventory is not a function|circular dependency/i);
      const output = JSON.parse(result.stdout);
      assert.equal(output.envelope.verdict, expected.envelope.verdict);
      const invalid = spawnSync(process.execPath, ['--require',preload,ROLE_ARTIFACT,command,...args.slice(0,-1),'0'.repeat(64)],
        {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /ARTIFACT_DIGEST_MISMATCH/);
      assert.equal(output.artifactDigest || output.artifact_digest, expected.artifactDigest || expected.artifact_digest);
      assert.deepEqual(fs.readdirSync(receiptDirectory).sort(), records.map(([name]) => name));
      for (const [name, bytes] of records) assert.deepEqual(fs.readFileSync(path.join(receiptDirectory,name)), bytes);
      for (const [name, bytes] of keys) assert.deepEqual(fs.readFileSync(path.join(f.storage,name)), bytes);
    }
  } finally { fixtureAPI.cleanupJudgment(f); }
});

test('completed reference authentication rejects caller authority with no filesystem mutation', () => {
  const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  for (const selectors of [null, {}, { worktree: '/missing', progress: {}, receipt_store: '/missing', dispatch_id: 'missing',
    evidence: {} }, { worktree: '/missing', progress: {}, receipt_store: '/missing', dispatch_id: 'missing',
    completed: true }, ...['gsd_role', 'gsd_launch_mechanism', 'native_child_evidence', 'task_relay'].map(key => ({
      worktree: '/missing', progress: {}, receipt_store: '/missing', dispatch_id: 'missing', [key]: {} }))]) {
    assert.throws(() => authority.authenticateCompletedReviewReferences(selectors),
      error => error.code === 'REVIEW_PROGRESS_REQUIRED');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-reference-refusal-'));
  try {
    git(root, ['init', '--quiet']);
    const store = path.join(root, 'absent-original-store');
    const source = `
      const fs = require('node:fs');
      const authority = require(process.env.REFERENCE_MODULE);
      const selectors = JSON.parse(process.env.REFERENCE_SELECTORS);
      for (const name of ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'appendFileSync', 'fsyncSync'])
        fs[name] = () => { throw new Error('unexpected authority mutation: ' + name); };
      const original = fs.openSync;
      fs.openSync = (file, flags, ...args) => {
        if (typeof flags === 'string' ? flags !== 'r' : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT))
          throw new Error('unexpected authority write-open');
        return original(file, flags, ...args);
      };
      try { authority.authenticateCompletedReviewReferences(selectors); process.exit(2); }
      catch (error) {
        if (error.message.includes('unexpected authority')) throw error;
        process.stdout.write('REFUSED_WITHOUT_WRITES');
      }
    `;
    const output = execFileSync(process.execPath, [...testAuthorityArgs, '-e', source], { encoding: 'utf8',
      env: { ...process.env, REFERENCE_MODULE: require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs'),
        REFERENCE_SELECTORS: JSON.stringify({ worktree: root, receipt_store: store, dispatch_id: 'missing-original',
          progress: { reference: 'review-progress-' + '0'.repeat(64) + '.json', sha256: '0'.repeat(64) } }) } });
    assert.equal(output, 'REFUSED_WITHOUT_WRITES');
    assert.equal(fs.existsSync(store), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('focused completeness and subject declarations fail closed without consumption inference', () => {
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const binding = { review_contract: context.FOCUSED_CONTRACT, repository: '/repo/.git', id: 'T-49-20',
    pr: 473, head: 'a'.repeat(40), base_commit: 'b'.repeat(40), merge_base: 'c'.repeat(40),
    base_tree: 'd'.repeat(40), ticket_set_digest: 'e'.repeat(64), context_digest: 'f'.repeat(64) };
  const result = { ...binding, launch_digest: '1'.repeat(64), review_completeness: 'complete', limitations: [], unresolved_sources: [] };
  assert.equal(context.validateFocusedResult(result, binding), true);
  for (const edit of [{ review_contract: 'forged' }, { review_completeness: 'maybe' },
    { unresolved_sources: ['src/missing.cjs'] }, { limitations: ['unresolved boundary'] },
    { limitations: ['x'.repeat(1025)] }, { base_commit: '9'.repeat(40) }])
    assert.throws(() => context.validateFocusedResult({ ...result, ...edit }, binding));
  assert.equal(context.validateFocusedResult({ ...result, review_completeness: 'incomplete',
    unresolved_sources: ['src/missing.cjs'] }, binding), true);
});
}

module.exports = { registerRoleArtifacts };

if (require.main === module) {
  const { test, after } = require('node:test');
  const lifecycle = createRoleArtifactLifecycle();
  lifecycle.start();
  try {
    const context = createRoleArtifactFixture({ unitDir: __dirname,
      scriptsDir: require('node:path').resolve(__dirname, '../../plugins/delivery-pipeline/scripts'),
      require, module, assert: require('node:assert'), suite() {}, lifecycle });
    registerRoleArtifacts((name, callback) => test(name, { timeout: 180000, concurrency: 2 },
      () => lifecycle.run(callback)), context);
    after(async () => { await lifecycle.settle(); lifecycle.cleanup(); });
  } catch (error) { lifecycle.cleanup(); throw error; }
}
