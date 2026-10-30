'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = path.join(ROOT, 'plugins/delivery-pipeline/scripts');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const TTL = 30 * 60 * 1000;
const { execFileSync, spawnSync } = require('node:child_process');
const signingHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z23-signing-')));
const previousEnv = Object.fromEntries(['GNUPGHOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  'SHIPYARD_COVERAGE_ROOT'].map(key => [key, process.env[key]]));
process.env.GNUPGHOME = path.join(signingHome, 'gnupg');
process.env.GIT_CONFIG_GLOBAL = path.join(signingHome, 'empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.SHIPYARD_COVERAGE_ROOT = path.join(signingHome, 'coverage');
fs.mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
process.on('exit', () => {
  const stopped = spawnSync('gpgconf', ['--homedir', path.join(signingHome, 'gnupg'), '--kill', 'gpg-agent'],
    { stdio: 'ignore', timeout: 5000 });
  if (stopped.error || stopped.status !== 0) process.exitCode = process.exitCode || 1;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(signingHome, { recursive: true, force: true });
});
execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
  'Z23 Test <z23@example.test>', 'ed25519', 'sign', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
const signer = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], { encoding: 'utf8' })
  .split('\n').find(line => line.startsWith('fpr:')).split(':')[9];

function setup(t, scripts = SCRIPTS) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z23-owner-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const filename = path.join(__dirname, 'codex-delivery-host.test.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
  loaded.require = request => request === 'node:os' ? { ...os, tmpdir: () => temporary }
    : request.startsWith('../../plugins/delivery-pipeline/scripts/')
      ? require(path.join(scripts, path.basename(request))) : require(request);
  loaded._compile(`'use strict';
    const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const { createCodexDeliveryHost } = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const temporary = ${JSON.stringify(temporary)}, signer = ${JSON.stringify(signer)};
    const finalizeCommit = () => { throw Object.assign(new Error('fixture candidate retained'), { code: 'Z23_CANDIDATE' }); };
    ${source.slice(source.indexOf('const capabilities ='), source.indexOf('const finalizerFile ='))}
    ${source.slice(source.indexOf('function git('), source.indexOf("suite('codex-delivery-host"))}
    module.exports = { fixture, delivery, clean, git };
  `, filename);
  const helpers = loaded.exports;
  const f = helpers.fixture({ physicalPaths: true });
  t.after(() => helpers.clean(f));
  fs.mkdirSync(path.join(f.root, '.planning/phases/38-z23'), { recursive: true });
  const controllerApi = require(path.join(scripts, 'run-controller.cjs'));
  const writerApi = require(path.join(scripts, 'planning-writer-lease.cjs'));
  let clock = 1000, writerOffset = 0;
  const controller = controllerApi.createRunController({ storeDir: path.join(temporary, 'runs'), now: () => clock });
  const run = require(path.join(scripts, 'run-scope.cjs')).createRunScope({
    ...f.scope, repository_id: 'shipyard/z23', owner_id: controller.owner_id,
    dispatch: { dispatch_id: 'z23-original', role: 'executor', model: 'gpt-6.1-sol', effort: 'low' },
  });
  controller.begin(run);
  const phaseDir = path.join(f.root, '.planning/phases/38-z23');
  const lease = writerApi.createPlanningWriterLease({ worktree: f.root, phaseDir,
    stateRoot: path.join(temporary, 'writers'), now: () => clock + writerOffset });
  const handle = lease.acquire({ owner: 'z23-original', base_revision: f.base });
  const writerSession = { lease, handle, base_revision: f.base, phaseDir, snapshot: lease.snapshotTree() };
  return { ...helpers, f, temporary, controller, run, lease, handle, writerSession, scripts,
    now: () => clock, advanceWriter: ms => { writerOffset += ms; }, advance: ms => { clock += ms; } };
}

async function matrix(t, configured, scripts = SCRIPTS) {
  const s = setup(t, scripts), { f, controller, lease, handle } = s;
  const original = controller.status(f.scope.run_id).owner;
  const commands = Array.from({ length: 5 }, (_, i) => ({ id: 'row-' + i, executable: process.execPath,
    argv: ['-e', 'void(' + i + ')'], timeoutMs: 600000, maxOutputBytes: 4096 }));
  f.verification = { commands };
  const allowList = commands.map(c => ({ argv: ['node', ...c.argv], profile: 'host', timeout_s: 600 }));
  if (configured) fs.writeFileSync(f.plan, '# approved\n## Verification commands\n'
    + allowList.map(c => '- `' + c.argv.join(' ') + '`').join('\n') + '\n');
  const calls = [];
  const runner = { run(spec) {
    assert.equal(spec.timeoutMs, 600000);
    calls.push(spec); s.advance(7 * 60 * 1000);
    return { status: 0, stdout_sha256: hash('out'), stderr_sha256: hash(''), timed_out: false };
  } };
  const host = s.delivery(f, { controller, writerSession: s.writerSession,
    verificationRunner: runner, hostVerificationRunner: runner,
    ...(configured ? { verificationAllowList: allowList } : {}) });
  await assert.rejects(host.run({ role: 'executor', context: { prompt: 'Implement the approved scoped fixture.' } }),
    error => error.code === 'Z23_CANDIDATE' && Boolean(error.candidate_id));
  assert.equal(calls.length, 5);
  assert.equal(s.now(), 1000 + 35 * 60 * 1000);
  const current = controller.status(f.scope.run_id).owner;
  for (const key of ['owner_id', 'lease_id', 'epoch', 'acquired_at']) assert.equal(current[key], original[key]);
  assert.equal(current.expires_at, s.now() + TTL);
  assert.equal(lease.ttl_ms, TTL);
  assert.equal(require(path.join(scripts, 'run-controller.cjs')).DEFAULT_LEASE_TTL_MS, TTL);
  const writer = JSON.parse(fs.readFileSync(lease.file));
  assert.equal(writer.token, handle.token); assert.equal(writer.epoch, handle.epoch);
  assert.equal(writer.base_revision, f.base); assert.equal(writer.expires_at, s.now() + TTL);
  assert.equal(controller.assertOwner(f.scope.run_id), true);
  assert.equal(lease.assertFence({ ...handle, base_revision: f.base }).ok, true);
}

for (const configured of [true, false]) test((configured ? 'PLAN' : 'legacy')
  + ' public host keeps the original default owner and writer across five synchronous seven-minute commands',
  async t => matrix(t, configured));

function commandsFor(s, configured, count = 3) {
  const commands = Array.from({ length: count }, (_, i) => ({ id: 'row-' + i,
    executable: process.execPath, argv: ['-e', 'void(' + i + ')'], timeoutMs: 600000, maxOutputBytes: 4096 }));
  s.f.verification = { commands, required: commands.map(c => c.id) };
  const verificationAllowList = commands.map(c => ({ argv: ['node', ...c.argv], profile: 'host', timeout_s: 600 }));
  if (configured) fs.writeFileSync(s.f.plan, '# approved\n## Verification commands\n'
    + verificationAllowList.map(c => '- `' + c.argv.join(' ') + '`').join('\n') + '\n');
  return configured ? { verificationAllowList } : {};
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

function stateRoot(s) {
  return path.join(fs.realpathSync(s.f.storageRoot), 'finalization', hash(fs.realpathSync(s.f.root)));
}

function recordsFor(s, configured) {
  const directory = path.join(stateRoot(s), 'verification');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
  if (configured) {
    const verifier = require(path.join(s.scripts, 'host-verification.cjs'));
    const found = files.map(file => ({ file: path.join(directory, file), digest: file.slice(0, -5) }))
      .map(ref => ({ ...ref, payload: verifier.readEvidence(ref.file, ref.digest) }));
    assert.equal(found.length, 1); assert.ok(found[0].payload);
    return { records: found[0].payload.results, sealed: found[0] };
  }
  const key = fs.readFileSync(path.join(stateRoot(s), 'finalization-authority/hmac.key'));
  const records = files.map(file => JSON.parse(fs.readFileSync(path.join(directory, file))))
    .filter(envelope => envelope.payload.command_id).map(envelope => {
      assert.equal(envelope.integrity.mac, crypto.createHmac('sha256', key)
        .update(canonical(envelope.payload)).digest('hex'));
      return envelope.payload;
    }).sort((a, b) => a.command_id.localeCompare(b.command_id));
  assert.ok(records.length);
  return { records };
}

function noCandidate(s) {
  const directory = path.join(stateRoot(s), 'candidates');
  assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
  assert.equal(s.git(s.f.root, 'rev-parse', 'HEAD'), s.f.base);
}

const losses = {
  expiry(s) { s.advance(TTL + 1); return 'LEASE_EXPIRED'; },
  stolen(s) {
    s.advance(TTL + 1);
    require(path.join(s.scripts, 'run-controller.cjs')).createRunController({
      storeDir: path.join(s.temporary, 'runs'), now: s.now, ownerId: 'z23-successor' }).begin(s.run);
    return 'SESSION_FENCED';
  },
  'same-controller-reacquire'(s) {
    s.advance(TTL + 1); s.controller.begin(s.run, { event_id: 'z23-replacement' });
    return 'SESSION_FENCED';
  },
  cancelled(s) { s.controller.fail(s.f.scope.run_id, { reason: 'cancelled by fixture owner' }); return 'SESSION_FENCED'; },
  released(s) { s.controller.release(s.f.scope.run_id); return 'HOST_AUTHORITY_REQUIRED'; },
  checkpointed(s) {
    s.controller.checkpoint(s.f.scope.run_id, { checkpoint_id: 'z23-stop', head: s.f.base,
      base: s.f.base, worktree: s.f.root, clean: false, children: [] });
    return 'SESSION_FENCED';
  },
  'writer-expiry'(s) {
    s.advanceWriter(TTL + 1); return 'LEASE_EXPIRED';
  },
  'writer-replaced'(s) { s.lease.acquire({ owner: 'z23-original', base_revision: s.f.base }); return 'WRITER_FENCED'; },
  'writer-released'(s) { s.lease.release(s.handle); return 'WRITER_FENCED'; },
  'writer-base'(s) {
    s.writerSession.base_revision = 'replacement-base';
    const record = JSON.parse(fs.readFileSync(s.lease.file)); record.base_revision = 'replacement-base';
    fs.writeFileSync(s.lease.file, JSON.stringify(record)); return 'BASE_MOVED';
  },
  'writer-token'(s) {
    const replacement = s.lease.acquire({ owner: 'z23-original', base_revision: s.f.base });
    s.writerSession.handle.token = replacement.token; s.writerSession.handle.epoch = replacement.epoch;
    return 'WRITER_FENCED';
  },
  'writer-epoch'(s) {
    const replacement = s.lease.acquire({ owner: 'z23-original', base_revision: s.f.base });
    s.writerSession.handle.epoch = replacement.epoch;
    return 'WRITER_FENCED';
  },
};

for (const configured of [true, false]) for (const [label, lose] of Object.entries(losses))
  test((configured ? 'PLAN' : 'legacy') + ' public finalization refuses ' + label + ' without later execution or signing', async t => {
    const s = setup(t), config = commandsFor(s, configured);
    let calls = 0, expected, lostRun, lostWriter;
    const runner = { run() {
      calls++; expected = lose(s);
      lostRun = s.controller.store.get(s.f.scope.run_id); lostWriter = fs.readFileSync(s.lease.file);
      return { status: 0, signal: null, timed_out: false, stdout: 'actual stdout', stderr: 'actual stderr' };
    } };
    const result = await s.delivery(s.f, { ...config, controller: s.controller, writerSession: s.writerSession,
      verificationRunner: runner, hostVerificationRunner: runner,
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } });
    assert.equal(result.status, 'verification_failed'); assert.equal(result.retryable, false);
    assert.equal(calls, 1); assert.equal(s.f.calls.length, 1);
    const { records } = recordsFor(s, configured), row = records[0];
    assert.equal(row.authority_error_code, expected); assert.equal(row.error_code, null);
    assert.equal(row.outcome, 'failed'); assert.equal(row.status, 0);
    assert.equal(row.stdout_sha256, hash('actual stdout')); assert.equal(row.stderr_sha256, hash('actual stderr'));
    assert.equal(row.tree_before, row.tree_after); assert.match(row.tree_before, /^[0-9a-f]{40,64}$/);
    if (configured) assert.deepEqual(records.slice(1).map(r => r.outcome), ['skipped', 'skipped']);
    else {
      assert.equal(records.length, 1); assert.equal(result.gates.pre_commit.length, 1);
      assert.match(result.summary, /missing row-1, missing row-2/);
      assert.deepEqual(result.gates.downstream, { ci: 'pending', review: 'pending' });
    }
    assert.deepEqual(s.controller.store.get(s.f.scope.run_id), lostRun);
    assert.deepEqual(fs.readFileSync(s.lease.file), lostWriter);
    noCandidate(s);
  });

for (const configured of [true, false]) for (const mode of ['nonzero', 'throw', 'timeout'])
  test((configured ? 'PLAN' : 'legacy') + ' retains real ' + mode + ' observations when its after-check also fences', async t => {
    const s = setup(t), config = commandsFor(s, configured);
    let calls = 0;
    const runner = { run() {
      calls++; s.controller.release(s.f.scope.run_id);
      const observation = { status: mode === 'nonzero' ? 7 : null, signal: mode === 'timeout' ? 'SIGTERM' : null,
        timed_out: mode === 'timeout', stdout_sha256: hash('original out'), stderr_sha256: hash('original err') };
      if (mode === 'throw') throw Object.assign(new Error('original runner exception'), observation, { code: 'Z23_RUNNER' });
      return { ...observation, error_code: mode === 'timeout' ? 'ETIMEDOUT' : null };
    } };
    const result = await s.delivery(s.f, { ...config, controller: s.controller, writerSession: s.writerSession,
      verificationRunner: runner, hostVerificationRunner: runner,
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } });
    assert.equal(result.status, 'verification_failed'); assert.equal(result.retryable, false); assert.equal(calls, 1);
    const { records } = recordsFor(s, configured), row = records[0];
    assert.equal(row.status, mode === 'nonzero' ? 7 : null);
    assert.equal(row.signal, mode === 'timeout' ? 'SIGTERM' : null); assert.equal(row.timed_out, mode === 'timeout');
    assert.equal(row.error_code, mode === 'throw' ? 'Z23_RUNNER' : mode === 'timeout' ? 'ETIMEDOUT' : null);
    assert.equal(row.authority_error_code, 'HOST_AUTHORITY_REQUIRED');
    assert.equal(row.stdout_sha256, hash('original out')); assert.equal(row.stderr_sha256, hash('original err'));
    assert.equal(row.tree_before, row.tree_after); assert.equal(row.outcome, 'failed');
    noCandidate(s);
  });

for (const configured of [true, false]) test((configured ? 'PLAN' : 'legacy')
  + ' before-check records refusal and invokes no runner', async t => {
    const s = setup(t), config = commandsFor(s, configured);
    let trees = 0, calls = 0;
    const scoped = require(path.join(SCRIPTS, 'delivery-commit-finalizer.cjs')).scopedTree;
    const runner = { run() { calls++; assert.fail('fenced before invocation'); } };
    const result = await s.delivery(s.f, { ...config, controller: s.controller, writerSession: s.writerSession,
      verificationRunner: runner, hostVerificationRunner: runner, scopedTree(input) {
        if (++trees === 2) s.controller.release(s.f.scope.run_id);
        return scoped(input);
      },
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } });
    assert.equal(result.status, 'verification_failed'); assert.equal(calls, 0);
    const row = recordsFor(s, configured).records[0];
    assert.equal(row.authority_error_code, 'HOST_AUTHORITY_REQUIRED'); assert.equal(row.status, null);
    assert.equal(row.error_code, null); assert.equal(row.stdout_sha256, hash('')); assert.equal(row.stderr_sha256, hash(''));
    assert.equal(row.tree_before, row.tree_after); noCandidate(s);
  });

for (const configured of [true, false]) for (const mode of ['nonzero', 'throw', 'timeout', 'tree'])
  test((configured ? 'PLAN' : 'legacy') + ' preserves ordinary ' + mode + ' failure and branch accounting', async t => {
    const s = setup(t), config = commandsFor(s, configured);
    let calls = 0;
    const launch = s.f.host.launch.bind(s.f.host);
    s.f.host.launch = (selection, context) => ({ ...launch(selection, context), launch_id: 'z23-attempt-' + s.f.calls.length });
    const runner = { run() {
      const first = calls++ === 0 || configured;
      if (!first) return { status: 0, stdout: '', stderr: '' };
      if (mode === 'tree') fs.appendFileSync(path.join(s.f.root, 'src/owned.txt'), 'during verification\n');
      if (mode === 'throw') throw Object.assign(new Error('ordinary runner failure'), { code: 'Z23_RUNNER' });
      return { status: mode === 'nonzero' ? 4 : mode === 'timeout' ? null : 0,
        signal: mode === 'timeout' ? 'SIGTERM' : null, timed_out: mode === 'timeout', stdout: 'out', stderr: 'err' };
    } };
    const host = s.delivery(s.f, { ...config, controller: s.controller, writerSession: s.writerSession,
      verificationRunner: runner, hostVerificationRunner: runner });
    if (configured) {
      const result = await host.run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } });
      assert.equal(result.status, 'verification_failed');
      assert.equal(result.retryable, mode === 'nonzero'); assert.equal(calls, mode === 'nonzero' ? 2 : 1);
    } else {
      await assert.rejects(host.run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } }),
        error => error.code === 'VERIFICATION_FAILED' && error.gates.pre_commit.length === 3
          && !error.message.includes('missing row-'));
      assert.equal(calls, 3);
    }
    const { records } = recordsFor(s, configured), row = records[0];
    assert.equal(row.outcome, 'failed'); assert.equal(row.authority_error_code, null);
    if (mode === 'tree') assert.notEqual(row.tree_before, row.tree_after);
    else assert.equal(row.tree_before, row.tree_after);
    assert.equal(s.controller.assertOwner(s.f.scope.run_id), true);
    noCandidate(s);
  });

for (const configured of [true, false]) test((configured ? 'PLAN' : 'legacy')
  + ' refuses an incomplete original writer without reacquiring it', async t => {
    const s = setup(t), config = commandsFor(s, configured);
    const original = fs.readFileSync(s.lease.file);
    const lease = { ...s.lease, heartbeatFenced: undefined };
    const runner = { run() { assert.fail('incompatible original writer must not run'); } };
    const result = await s.delivery(s.f, { ...config, controller: s.controller,
      writerSession: { ...s.writerSession, lease }, verificationRunner: runner, hostVerificationRunner: runner,
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } });
    assert.equal(result.status, 'verification_failed'); assert.equal(result.retryable, false);
    assert.equal(recordsFor(s, configured).records[0].authority_error_code, 'WRITER_FENCED');
    assert.deepEqual(fs.readFileSync(s.lease.file), original); noCandidate(s);
  });

test('atomic writer renewal samples expiry under the existing writer lock and preserves the soft API race', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z23-atomic-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const worktree = path.join(directory, 'worktree'); fs.mkdirSync(worktree);
  const api = require(path.join(SCRIPTS, 'planning-writer-lease.cjs'));
  let clock = 1000, armed = false, observed = false;
  let lease;
  lease = api.createPlanningWriterLease({ worktree, phaseDir: 'phase', stateRoot: path.join(directory, 'state'), now() {
    if (armed) {
      const lock = path.join(path.dirname(lease.file), '.locks/writer.lock/owner.json');
      assert.equal(fs.lstatSync(lock).isFile(), true);
      observed = true; clock += TTL;
    }
    return clock;
  } });
  const handle = lease.acquire({ owner: 'original', base_revision: 'original-base' });
  const input = { ...handle, base_revision: 'original-base' };
  assert.equal(lease.assertFence(input).ok, true);
  const before = fs.readFileSync(lease.file);
  armed = true;
  assert.throws(() => lease.heartbeatFenced(input), { code: 'LEASE_EXPIRED' });
  armed = false;
  assert.equal(observed, true); assert.deepEqual(fs.readFileSync(lease.file), before);
  assert.equal(lease.heartbeat(handle).expires_at, clock + TTL);
  const live = fs.readFileSync(lease.file);
  for (const [changed, code] of [[{ token: 'foreign' }, 'WRITER_FENCED'], [{ epoch: handle.epoch + 1 }, 'WRITER_FENCED'],
    [{ base_revision: 'foreign-base' }, 'BASE_MOVED']]) {
    assert.throws(() => lease.heartbeatFenced({ ...input, ...changed }), { code });
    assert.deepEqual(fs.readFileSync(lease.file), live);
  }
  const renewed = lease.heartbeatFenced(input);
  assert.equal(renewed.expires_at, clock + TTL); assert.equal(renewed.epoch, handle.epoch);
  lease.release(handle);
  const released = fs.readFileSync(lease.file);
  assert.throws(() => lease.heartbeatFenced(input), { code: 'WRITER_FENCED' });
  assert.deepEqual(fs.readFileSync(lease.file), released);
});

for (const configured of [true, false]) test((configured ? 'PLAN' : 'legacy')
  + ' no-controller callers retain behavior and cannot install renewal through option or PLAN fields', async t => {
    const s = setup(t), config = commandsFor(s, configured, 5);
    fs.appendFileSync(s.f.plan, '\nrenewOwner: serialized-callback\nwriterSession: serialized-writer\n');
    let calls = 0;
    const forged = () => assert.fail('serialized or arbitrary options cannot grant renewal authority');
    const runner = { run() { calls++; s.advance(7 * 60 * 1000); return { status: 0, stdout: 'out', stderr: '' }; } };
    const host = s.delivery(s.f, { ...config, renewOwner: forged, renewVerificationOwner: forged,
      verificationRunner: runner, hostVerificationRunner: runner });
    await assert.rejects(host.run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.',
      renewOwner: 'forged', controller: { owner_id: 'forged' } } }), error => error.code === 'Z23_CANDIDATE');
    assert.equal(calls, 5); assert.equal(s.controller.status(s.f.scope.run_id).owner.status, 'expired');
    const { records, sealed } = recordsFor(s, configured);
    assert.ok(records.every(row => row.outcome === 'passed' && row.authority_error_code === null));
    if (configured) {
      const verifier = require(path.join(SCRIPTS, 'host-verification.cjs'));
      const bytes = fs.readFileSync(sealed.file);
      const forgedEnvelope = JSON.parse(bytes); forgedEnvelope.payload.results[0].authority_error_code = 'forged';
      const fakeFile = path.join(path.dirname(sealed.file), 'tampered.json');
      fs.writeFileSync(fakeFile, JSON.stringify(forgedEnvelope), { mode: 0o600 });
      assert.equal(verifier.readEvidence(fakeFile, sealed.digest), null);
      assert.deepEqual(fs.readFileSync(sealed.file), bytes);
      assert.ok(verifier.readEvidence(sealed.file, sealed.digest));
    }
    for (const input of [{ role: 'executor', renewOwner: 'forged' },
      { role: 'executor', context: { writerSession: {} } },
      { role: 'executor', context: { verification_assignment: {} } }])
      await assert.rejects(host.run(input), { code: 'INVALID_INPUT' });
  });

for (const configured of [true, false]) test((configured ? 'PLAN' : 'legacy')
  + ' renews a real controller without an optional writer', async t => {
    const s = setup(t), config = commandsFor(s, configured, 5);
    let calls = 0;
    const runner = { run() { calls++; s.advance(7 * 60 * 1000); return { status: 0, stdout: '', stderr: '' }; } };
    await assert.rejects(s.delivery(s.f, { ...config, controller: s.controller,
      verificationRunner: runner, hostVerificationRunner: runner,
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } }), { code: 'Z23_CANDIDATE' });
    assert.equal(calls, 5); assert.equal(s.controller.assertOwner(s.f.scope.run_id), true);
    assert.equal(s.controller.status(s.f.scope.run_id).owner.expires_at, s.now() + TTL);
  });

for (const configured of [true, false]) test((configured ? 'PLAN' : 'legacy')
  + ' ignores forged option and serialized request renewal while the real owner expires', async t => {
    const s = setup(t), config = commandsFor(s, configured);
    let forgedCalls = 0, calls = 0;
    const forged = () => { forgedCalls++; s.controller.begin(s.run, { event_id: 'forged-reacquire' }); };
    const runner = { run() { calls++; s.advance(TTL + 1); return { status: 0, stdout: '', stderr: '' }; } };
    fs.appendFileSync(s.f.plan, '\nrenewVerificationOwner: forged\n');
    const result = await s.delivery(s.f, { ...config, controller: s.controller, writerSession: s.writerSession,
      renewOwner: forged, renewVerificationOwner: forged, verificationRunner: runner, hostVerificationRunner: runner,
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.', renewOwner: 'forged' } });
    assert.equal(result.status, 'verification_failed'); assert.equal(result.retryable, false);
    assert.equal(calls, 1); assert.equal(forgedCalls, 0);
    assert.equal(recordsFor(s, configured).records[0].authority_error_code, 'LEASE_EXPIRED'); noCandidate(s);
  });

for (const target of ['PLAN', 'graph']) test('public host still refuses changed pinned ' + target + ' before verification', async t => {
  const s = setup(t), config = commandsFor(s, true);
  const launch = s.f.host.launch.bind(s.f.host);
  s.f.host.launch = (selection, context) => {
    const result = launch(selection, context);
    fs.appendFileSync(target === 'PLAN' ? s.f.plan : path.join(s.f.graphDir, 'tickets.json'), '\n');
    return result;
  };
  const runner = { run() { assert.fail('changed governing source cannot reach verification'); } };
  await assert.rejects(s.delivery(s.f, { ...config, controller: s.controller, writerSession: s.writerSession,
    verificationRunner: runner, hostVerificationRunner: runner,
  }).run({ role: 'executor', context: { prompt: 'Implement the scoped fixture.' } }),
  { code: target === 'PLAN' ? 'PLAN_DIGEST_MISMATCH' : 'GRAPH_CHANGED' });
  noCandidate(s);
});

function inventory(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = prefix + entry.name, file = path.join(directory, relative), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, relative);
      if (stat.isDirectory()) return inventory(directory, relative + '/');
      assert.equal(stat.isFile(), true, relative);
      return [{ path: relative, mode: stat.mode & 0o777, digest: hash(fs.readFileSync(file)) }];
    });
}

test('genuine complete staged package preserves current regular bytes modes identities and independently loaded owner behavior',
  { timeout: 180000 }, async t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z23-package-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const shipped = path.join(ROOT, 'plugins/shipyard'), before = inventory(shipped);
    const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(directory, 'package'));
    assert.deepEqual(inventory(shipped), before); const actual = inventory(candidate); assert.deepEqual(actual, before);
    const originals = {
      'host-verification.cjs': { mode: 420, digest: '7821d83325758e5b71c7d25604556ff41a495bcccaacbbe1fb9ca8813a417d86' },
      'planning-writer-lease.cjs': { mode: 420, digest: 'abef7cd685442eb5c0d2f0cec5a3e1ec94c0ba3865b767bcb5f664f13b106200' },
    };
    const stagedScripts = path.join(candidate, 'host/plugins/delivery-pipeline/scripts');
    const prior = {};
    for (const name of ['codex-delivery-host.cjs', ...Object.keys(originals)]) {
      const canonicalFile = path.join(SCRIPTS, name), mirror = path.join(stagedScripts, name);
      for (const file of [canonicalFile, mirror]) {
        const stat = fs.lstatSync(file); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
      }
      assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonicalFile));
      assert.equal(fs.lstatSync(mirror).mode & 0o777, fs.lstatSync(canonicalFile).mode & 0o777);
      if (originals[name]) {
        assert.equal(fs.lstatSync(mirror).mode & 0o777, originals[name].mode);
        const row = actual.find(row => row.path === 'host/plugins/delivery-pipeline/scripts/' + name);
        assert.equal(row.digest, hash(fs.readFileSync(canonicalFile)));
        prior[name] = { ...row, ...originals[name] };
      }
      assert.equal(require.cache[mirror], undefined);
    }
    for (const name of ['codex-delivery-host.cjs', ...Object.keys(originals)])
      assert.notEqual(require(path.join(stagedScripts, name)), require(path.join(SCRIPTS, name)));
    assert.deepEqual(Object.keys(prior), Object.keys(originals));
    const digest = crypto.createHash('sha256');
    for (const row of actual.filter(row => !['.codex-plugin/plugin.json', 'package-build.json'].includes(row.path)))
      digest.update(row.path + '\0').update(fs.readFileSync(path.join(candidate, row.path)));
    const sourceDigest = digest.digest('hex'), manifestBytes = fs.readFileSync(path.join(candidate, '.codex-plugin/plugin.json'));
    const manifest = JSON.parse(manifestBytes), identity = JSON.parse(fs.readFileSync(path.join(candidate, 'package-build.json')));
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version;
    assert.equal(manifest.version, version + '+codex.' + sourceDigest.slice(0, 16));
    assert.equal(identity.version, manifest.version);
    assert.equal(identity.digest, hash(sourceDigest + '\0' + manifestBytes));
    assert.deepEqual(fs.readFileSync(path.join(shipped, '.codex-plugin/plugin.json')), manifestBytes);
    assert.deepEqual(fs.readFileSync(path.join(shipped, 'package-build.json')), fs.readFileSync(path.join(candidate, 'package-build.json')));
    await matrix(t, true, stagedScripts); await matrix(t, false, stagedScripts);
    t.diagnostic(JSON.stringify({ package: identity, installed_native_acceptance: false, R8: 'INCOMPLETE', semantic_credit: 0 }));
  });

test('actual sorted physical membership retains the frozen 44 rows permits either z24 arrival and future singleton appends', t => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const frozen = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs']];
  const physical = s.unitFiles(), actual = s.appendShard(manifest, s.unitTasks(physical));
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(actual.shards.slice(0, 39), first39); assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.deepEqual(actual.shards.slice(0, 44), frozen);
  assert.deepEqual(actual.shards.slice(44), s.unitTasks(physical).filter(file => !new Set(frozen.flat()).has(file)).map(file => [file]));
  assert.deepEqual(actual.shards[44], [path.basename(__filename)]);
  for (let i = 0; i < actual.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z23-shards-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of physical) fs.writeFileSync(path.join(directory, file), '');
  const z24 = physical.find(file => file.startsWith('phase53-z24-')) || 'phase53-z24-future-portable.test.cjs';
  fs.writeFileSync(path.join(directory, z24), '');
  const both = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
  assert.deepEqual(both.shards.slice(0, 44), frozen);
  assert.deepEqual(both.shards.slice(44, 46), [[path.basename(__filename)], [z24]]);
  fs.unlinkSync(path.join(directory, z24));
  const without = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
  assert.deepEqual(without.shards.slice(0, 45), [...frozen, [path.basename(__filename)]]);
  fs.writeFileSync(path.join(directory, z24), '');
  const futureFile = 'zz-future-owner-regression.test.cjs'; fs.writeFileSync(path.join(directory, futureFile), '');
  const future = s.appendShard(both, s.unitTasks(s.unitFiles(directory)));
  assert.deepEqual(future.shards.slice(0, both.shards.length), both.shards);
  assert.deepEqual(future.shards.at(-1), [futureFile]);
  for (let i = 0; i < future.shards.length; i++)
    assert.deepEqual(s.selectTaskShard(`${i + 1}/${future.shards.length}`, directory, both), future.shards[i]);
  t.diagnostic(JSON.stringify({ actual_unit_rows: actual.shards.length, actual_workflow_checks: actual.shards.length + 3,
    z24_present: physical.includes(z24), future_append: true, installed_native_acceptance: false, R8: 'INCOMPLETE', semantic_credit: 0 }));
});
