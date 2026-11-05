'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const test = require('node:test');
if (process.argv[2] === '--fixture-child') {
  const cp = require('node:child_process'), exec = cp.execFileSync;
  cp.execFileSync = (program, args, ...rest) => {
    globalThis.t36BeforeCommand?.(program, args);
    if (program === 'git' && args.includes('commit-tree') && args.includes('-S'))
      fs.appendFileSync(process.argv[3] + '.events', JSON.stringify({ kind: 'sign', pid: process.pid }) + '\n');
    return exec(program, args, ...rest);
  };
  const Module = require('node:module'), load = Module._load;
  Module._load = function (name, ...args) {
    const exports = load.call(this, name, ...args);
    if (name.endsWith('/codex-delivery-host.cjs') || name === './codex-delivery-host.cjs')
      return { ...exports, validateOriginalCiOperation(...input) {
        const result = exports.validateOriginalCiOperation(...input); globalThis.t36AfterTransition?.(input[1], input[2]); return result;
      } };
    return name.endsWith('/role-artifact.cjs') || name === './role-artifact.cjs'
      ? { ...exports, sealRole(...input) { const sealed = exports.sealRole(...input); globalThis.t36AfterSeal?.(); return sealed; } }
      : exports;
  };
}
const fixture = require('./phase53-z29x-native-ci-fix-contract.test.cjs');
const packageProof = require('./phase53-z29y-native-ci-fix-recovery.test.cjs');
const { root, scripts, hash, git, bounded } = fixture;
const SOURCE = path.join(scripts, 'codex-delivery-host.cjs');
const SHIPPED = path.join(root, 'plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');

function operation(spec) {
  const directory = path.join(spec.options.storageRoot, 'finalization', hash(spec.options.scope.worktree), 'ci-originals');
  const rows = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({
    file: path.join(directory, name), payload: JSON.parse(fs.readFileSync(path.join(directory, name))).payload,
  }));
  assert.equal(rows.length, 1);
  return rows[0];
}

async function child(specFile, action, point, consumer) {
  let spec = JSON.parse(fs.readFileSync(specFile)), f;
  if (spec.fixtureEnv) Object.assign(process.env, spec.fixtureEnv);
  const events = specFile + '.events';
  const event = (kind, data = {}) => fs.appendFileSync(events, JSON.stringify({ kind, pid: process.pid, ...data }) + '\n');
  process.on('exit', code => {
    const usage = process.resourceUsage();
    fs.appendFileSync(specFile + '.resources', JSON.stringify({ pid: process.pid, code,
      user_cpu_us: usage.userCPUTime, system_cpu_us: usage.systemCPUTime }) + '\n');
  });
  const mode = point.split(':')[0];
  if (['exit', 'hold'].includes(mode)) point = point.slice(mode.length + 1);
  let options;
  if (action === 'establish') {
    f = fixture.ciFixture(spec.signing, { producerScripts: path.dirname(consumer) });
    delete f.options.verificationAllowList;
    f.control.source = spec.outcome === 'fixed'; f.output.status = spec.outcome;
    const spawn = f.options.spawn;
    f.options.spawn = (...args) => { event('native'); return spawn(...args); };
    const runner = f.options.hostVerificationRunner.run;
    f.options.hostVerificationRunner.run = command => { event('HOST'); return runner(command); };
    options = f.options;
    if (point === 'unfinished') f.control.mutateNative = rows => { rows.splice(rows.findIndex(row => row.payload?.type === 'task_complete'), 1); };
    spec = { ...spec, ...f.coldSpec(), requestFile: f.requestFile,
      originalHead: f.originalHead, fixtureEnv: { SHIPYARD_COVERAGE_ROOT: process.env.SHIPYARD_COVERAGE_ROOT } };
  } else {
    let live = spec.live;
    options = { ...spec.options, getPullRequest: () => live,
      spawn() { event('native'); throw Error('completed original must never relaunch'); },
      execFileSync(program, args, opts) {
        if (program === 'git' && args[0] === 'push') {
          event('push'); live = { ...live, headRefOid: git(spec.options.scope.worktree, 'rev-parse', 'HEAD') };
          spec.live = live; save();
          if (point === 'publication-loss') interrupt();
          return '';
        }
        assert.equal(program, 'gh');
        const encoded = spec.responses[JSON.stringify(args)];
        assert.ok(encoded, 'only original fixture transport: ' + JSON.stringify(args));
        const bytes = Buffer.from(encoded, 'base64');
        return opts.encoding === null ? bytes : bytes.toString('utf8');
      },
      hostVerificationRunner: { run(command) {
        event('HOST');
        const result = require(path.join(path.dirname(consumer), 'command-runner.cjs')).runBounded(command.executable, command.argv,
          { cwd: command.cwd, timeoutMs: command.timeoutMs, env: {} });
        return { id: command.id, status: result.status, signal: result.signal, error_code: result.errorCode,
          timed_out: result.timedOut, stdout_sha256: hash(result.stdout), stderr_sha256: hash(result.stderr),
          backend: { kind: 'test-host', path: process.execPath, digest: hash('host') }, profile_sha256: hash('profile') };
      } },
    };
  }
  function save() {
    if (f) spec = { ...spec, ...f.coldSpec(), fixtureEnv: { SHIPYARD_COVERAGE_ROOT: process.env.SHIPYARD_COVERAGE_ROOT } };
    fs.writeFileSync(specFile, JSON.stringify(spec));
  }
  let injected = false;
  function interrupt() {
    if (injected) return;
    injected = true; save(); event('interruption', { point });
    if (mode === 'exit') process.exit(86);
    if (mode === 'hold') {
      const deadline = Date.now() + 180000;
      while (!fs.existsSync(specFile + '.release') && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      assert.ok(fs.existsSync(specFile + '.release'), 'fixture barrier released within case bound');
      return;
    }
    const error = Object.assign(Error('HTTP502 fixture ' + point), { code: 'FIXTURE_HTTP502' });
    throw error;
  }
  globalThis.t36AfterSeal = () => { if (point === 'seal') interrupt(); };
  globalThis.t36AfterTransition = (stage, facts) => {
    if (point === 'before_record' && (stage === 'pre-record' || stage === 'recover' && !facts.record)) interrupt();
  };
  globalThis.t36BeforeCommand = () => {
    if (point !== 'attempt' || injected) return;
    const directory = path.join(options.storageRoot, 'finalization', hash(options.scope.worktree), 'ci-repair-attempts');
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => {
      const payload = JSON.parse(fs.readFileSync(path.join(directory, name))).payload;
      return payload.reference;
    })) interrupt();
  };
  const rename = fs.renameSync, link = fs.linkSync;
  const afterWrite = destination => {
    const name = path.basename(destination);
    if (destination.includes(path.sep + 'ci-originals' + path.sep)) {
      const op = JSON.parse(fs.readFileSync(destination)).payload;
      if (point === 'before_record' && op.completed && op.output) interrupt();
      if (point === 'ack' && op.state === 'acknowledged') interrupt();
      if (point === 'candidate' && op.candidate_result) interrupt();
      if (point === 'signed' && op.signed_result) interrupt();
    }
    if (point === 'record' && name.startsWith('record-')) interrupt();
    if (point === 'index' && name.startsWith('latest-')) interrupt();
    if (point === 'verification' && destination.includes(path.sep + 'verification' + path.sep) && /^[a-f0-9]{64}\.json$/.test(name)) interrupt();
    if (point === 'finalized' && destination.includes(path.sep + 'finalized' + path.sep)) interrupt();
  };
  fs.renameSync = (source, destination, ...args) => { const result = rename(source, destination, ...args); afterWrite(destination); return result; };
  fs.linkSync = (source, destination, ...args) => { const result = link(source, destination, ...args); afterWrite(destination); return result; };
  try {
    const result = await require(consumer).runCli(['--args-file', spec.requestFile], { write() {} }, options);
    save(); event('result', { result });
  } catch (error) {
    save();
    const op = operation(spec).payload;
    const storeDir = path.join(spec.options.storageRoot, hash(op.scope.run_id + '\0' + op.scope.worktree), 'runs');
    event('original-controller', { status: require(path.join(path.dirname(consumer), 'run-controller.cjs'))
      .createRunController({ storeDir }).status(op.scope.run_id) });
    event('error', { code: error.code, message: error.message });
    process.stderr.write(error.stack + '\n'); process.exitCode = 1;
  } finally { fs.renameSync = rename; fs.linkSync = link; }
}

function invoke(specFile, action = 'retry', point = '', consumer = SOURCE) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [__filename, '--fixture-child', specFile, action, point, consumer],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.appendFileSync(specFile + '.invocations', JSON.stringify({ action, point, pid: result.pid,
    status: result.status, signal: result.signal, wall_ms: Number(process.hrtime.bigint() - started) / 1e6 }) + '\n');
  return result;
}
function events(file) {
  return fs.readFileSync(file + '.events', 'utf8').trim().split('\n').map(JSON.parse);
}
function establish(signing, outcome, point = 'before_record', consumer = SOURCE) {
  const file = path.join(signing.directory, 'cli-' + require('node:crypto').randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify({ signing: { directory: signing.directory, signer: signing.signer }, outcome }));
  const failed = invoke(file, 'establish', point, consumer);
  assert.equal(failed.status, point.startsWith('exit:') ? 86 : 1, failed.stderr);
  assert.ok(events(file).some(row => row.kind === 'interruption' && row.point === point.replace(/^exit:/, '')), failed.stderr);
  return established(file, failed.stderr);
}
function established(file, rawFailure = '') {
  const spec = JSON.parse(fs.readFileSync(file)), original = operation(spec).payload;
  assert.ok(original.completed?.session_id); assert.equal(original.candidate_result, undefined);
  const runStore = path.join(spec.options.storageRoot, hash(original.scope.run_id + '\0' + original.scope.worktree), 'runs/runs.json');
  const originalStatus = require(path.join(scripts, 'run-controller.cjs')).createRunController({ storeDir: path.dirname(runStore) })
    .status(original.scope.run_id);
  assert.equal(originalStatus.owner.owner_id, original.controller_owner.owner_id);
  assert.equal(originalStatus.owner.lease_id, original.controller_owner.lease_id);
  assert.equal(originalStatus.owner.epoch, original.controller_owner.epoch);
  return { file, spec, original, runStore, originalStatus, originalRunBytes: fs.readFileSync(runStore), rawFailure };
}
function recordWindow(f, point) {
  const names = fs.readdirSync(f.original.receipt_store);
  assert.equal(names.filter(name => /^record-[a-f0-9]{64}\.json$/.test(name)).length, point === 'before_record' ? 0 : 1);
  assert.equal(names.filter(name => /^latest-[a-f0-9]{64}\.json$/.test(name)).length, ['index', 'ack'].includes(point) ? 1 : 0);
  const receipts = require(path.join(scripts, 'dispatch-boundary.cjs')).createDurableRecorder(f.original.receipt_store);
  const record = receipts.getVerifiedRecord(f.original.dispatch_id);
  if (point === 'before_record') assert.equal(record, null);
  else {
    assert.ok(record);
    assert.equal(record.dispatch_id, f.original.dispatch_id);
    assert.equal(record.receipt.dispatch_id, f.original.dispatch_id);
    assert.equal(record.receipt.runtime_evidence.session_id, f.original.completed.session_id);
  }
  assert.deepEqual(receipts.getLatestReceipt('codex', 'ci-fix'), ['index', 'ack'].includes(point) ? record : null);
  assert.equal(operation(f.spec).payload.state === 'acknowledged', point === 'ack');
}
function finished(f, consumer = SOURCE) {
  const result = invoke(f.file, 'retry', '', consumer);
  assert.equal(result.status, 0, result.stderr);
  const spec = JSON.parse(fs.readFileSync(f.file)), op = operation(spec).payload;
  assert.equal(op.state, 'finished');
  for (const key of ['scope', 'dispatch_id', 'controller_owner', 'resolution', 'completed', 'native_custody', 'preparation', 'output', 'receipt_store', 'recorder_identity'])
    assert.deepEqual(op[key], f.original[key], 'immutable original ' + key);
  assert.equal(op.result.receipt.dispatch_id, f.original.dispatch_id);
  assert.equal(op.result.receipt.runtime_evidence.session_id, f.original.completed.session_id);
  const stateRoot = path.dirname(path.dirname(operation(spec).file));
  const controls = fs.readdirSync(path.join(stateRoot, 'ci-controls')).map(name => JSON.parse(fs.readFileSync(path.join(stateRoot, 'ci-controls', name))).payload);
  assert.ok(controls.length > 0);
  for (const control of controls) {
    assert.notEqual(control.run_id, f.original.scope.run_id);
    assert.equal(control.original_run_id, f.original.scope.run_id);
    assert.equal(control.original_dispatch_id, f.original.dispatch_id);
    assert.match(control.original_sha256, /^[a-f0-9]{64}$/);
  }
  const originalStore = path.join(spec.options.storageRoot, hash(f.original.scope.run_id + '\0' + f.original.scope.worktree), 'runs');
  const originalController = require(path.join(scripts, 'run-controller.cjs')).createRunController({ storeDir: originalStore });
  assert.deepEqual(originalController.status(f.original.scope.run_id), f.originalStatus,
    'original factual controller status and owner remain unchanged');
  assert.deepEqual(fs.readFileSync(f.runStore), f.originalRunBytes, 'original controller remains byte-identical');
  const receipts = require(path.join(scripts, 'dispatch-boundary.cjs')).createDurableRecorder(op.receipt_store);
  assert.equal(receipts.getLatestReceipt('codex', 'ci-fix').dispatch_id, f.original.dispatch_id);
  assert.deepEqual(receipts.getVerifiedRecord(op.dispatch_id).receipt, op.result.receipt);
  const attempts = fs.readdirSync(path.join(stateRoot, 'ci-repair-attempts')).map(name => JSON.parse(fs.readFileSync(path.join(stateRoot, 'ci-repair-attempts', name))).payload)
    .filter(row => row.dispatch_id === op.dispatch_id);
  assert.equal(attempts.length, 1);
  const expected = { scope: spec.options.scope, worktree: spec.options.scope.worktree, output: spec.output, stateRoot };
  const fixtureNamespace = path.join(spec.signing.directory, 'coverage-' + hash(spec.options.scope.worktree));
  assert.deepEqual(spec.fixtureEnv, { SHIPYARD_COVERAGE_ROOT: fixtureNamespace });
  const savedCoverageRoot = process.env.SHIPYARD_COVERAGE_ROOT;
  try {
    Object.assign(process.env, spec.fixtureEnv);
    fixture.assertCurrent(expected, op.result, path.dirname(consumer));
  } finally {
    if (savedCoverageRoot === undefined) delete process.env.SHIPYARD_COVERAGE_ROOT;
    else process.env.SHIPYARD_COVERAGE_ROOT = savedCoverageRoot;
  }
  if (spec.outcome === 'fixed') {
    const candidate = JSON.parse(fs.readFileSync(path.join(stateRoot, 'candidates', op.result.artifact.candidate_id + '.json'))).payload;
    assert.equal(candidate.run_id, f.original.scope.run_id);
    assert.equal(candidate.scoped_tree, f.original.output.tree);
    assert.equal(candidate.dispatch_id, f.original.dispatch_id);
    assert.equal(op.result.publication.status, 'confirmed');
    assert.equal(git(spec.options.scope.worktree, 'show', '-s', '--format=%P', op.result.artifact.commit), f.original.preparation.commit.expectedHead);
  } else assert.equal(fs.existsSync(path.join(stateRoot, 'candidates')) && fs.readdirSync(path.join(stateRoot, 'candidates')).length > 0, false);
  const before = events(f.file), again = invoke(f.file, 'retry', '', consumer);
  assert.equal(again.status, 0, again.stderr);
  const rows = events(f.file), count = kind => rows.filter(row => row.kind === kind).length;
  for (const kind of ['native', 'HOST', 'sign', 'push'])
    assert.equal(count(kind), before.filter(row => row.kind === kind).length, 'finished retry effects ' + kind);
  assert.equal(count('native'), 1);
  for (const kind of ['HOST', 'sign', 'push']) assert.equal(count(kind), spec.outcome === 'fixed' ? 1 : 0, kind);
  assert.equal(git(spec.options.scope.worktree, 'rev-list', '--count', f.original.preparation.commit.expectedHead + '..HEAD'), spec.outcome === 'fixed' ? '1' : '0');
  const readRows = suffix => fs.readFileSync(f.file + suffix, 'utf8').trim().split('\n').map(JSON.parse);
  const resources = readRows('.resources'), invocations = readRows('.invocations');
  process.stdout.write('# T36-recovery ' + JSON.stringify({ outcome: spec.outcome,
    original_state: f.originalStatus.state, original_lease: f.originalStatus.owner.status,
    controls: controls.length, interruptions: rows.filter(row => row.kind === 'interruption').map(row => row.point),
    effects: Object.fromEntries(['native', 'HOST', 'sign', 'push'].map(kind => [kind, count(kind)])),
    receipt_dispatch: op.dispatch_id, retained_attempts: attempts.length,
    invoked_wall_ms: invocations.reduce((sum, row) => sum + row.wall_ms, 0),
    resources, invocations, killed_process_cpu: 'unknown' }) + '\n');
  return op;
}

if (process.argv[2] === '--fixture-child') {
  child(...process.argv.slice(3)).catch(error => { console.error(error); process.exitCode = 1; });
} else if (require.main === module) {
  for (const outcome of ['no-op', 'fixed']) test('T36-tracer fresh process completed ' + outcome, bounded, () => {
    const signing = fixture.signingFixture();
    try { finished(establish(signing, outcome)); } finally { signing.close(); }
  });
  for (const outcome of ['no-op', 'fixed']) for (const point of ['record', 'index', 'ack'])
    test('T36-crash fresh CLI ' + outcome + ' HTTP502 at ' + point, bounded, () => {
      const signing = fixture.signingFixture();
      try { const f = establish(signing, outcome, point); recordWindow(f, point); finished(f); } finally { signing.close(); }
    });
  for (const outcome of ['no-op', 'fixed']) for (const point of ['before_record', 'record', 'index', 'ack'])
    test('T36-crash original producer process exit ' + outcome + ' at ' + point, bounded, () => {
      const signing = fixture.signingFixture();
      try {
        const f = establish(signing, outcome, 'exit:' + point);
        recordWindow(f, point);
        assert.equal(f.originalStatus.owner.status, 'active', 'real process exit retains the original lease');
        finished(f);
      } finally { signing.close(); }
    });
  for (const outcome of ['no-op', 'fixed']) for (const point of ['before_record', 'record', 'index', 'ack'])
    test('T36-crash fresh recovery process exit ' + outcome + ' at ' + point, bounded, () => {
      const signing = fixture.signingFixture();
      try {
        const f = establish(signing, outcome), failed = invoke(f.file, 'retry', 'exit:' + point);
        assert.equal(failed.status, 86, failed.stderr);
        recordWindow(f, point);
        finished(f);
      } finally { signing.close(); }
    });
  for (const point of ['seal', 'attempt', 'verification', 'candidate', 'finalized', 'signed', 'publication-loss'])
    test('T36-crash FIXED durable downstream exit at ' + point, bounded, () => {
      const signing = fixture.signingFixture();
      try {
        const f = establish(signing, 'fixed'), failed = invoke(f.file, 'retry', 'exit:' + point);
        assert.equal(failed.status, 86, failed.stderr);
        finished(f);
      } finally { signing.close(); }
    });
  for (const [name, consumer] of [['canonical', SOURCE], ['shipped', SHIPPED]]) for (const point of ['candidate', 'signed'])
    test('T36-existing-recovery fresh CLI ' + name + ' ' + point, bounded, () => {
      const signing = fixture.signingFixture();
      try {
        const f = establish(signing, 'fixed'), failed = invoke(f.file, 'retry', point);
        assert.equal(failed.status, 1, failed.stderr);
        assert.ok(operation(JSON.parse(fs.readFileSync(f.file))).payload.candidate_result);
        finished(f, consumer);
      } finally { signing.close(); }
    });
  const mutations = {
    failure: { code: 'CI_EVIDENCE_CHANGED', change(f) { fs.appendFileSync(f.original.preparation.repair.evidence.original.path, 'changed failure'); } },
    plan: { code: 'PLAN_DIGEST_MISMATCH', change(f) { fs.appendFileSync(path.resolve(f.spec.options.graphDir, '../..', f.original.preparation.plan.path), '\nchanged criteria'); } },
    graph: { code: 'CI_SUBJECT_CHANGED', change(f) { fs.appendFileSync(path.join(f.spec.options.graphDir, 'tickets.json'), '\n'); } },
    tree: { code: 'CI_ORIGINAL_INVALID', change(f) { fs.appendFileSync(path.join(f.spec.options.scope.worktree, 'src/owned.txt'), 'changed output'); } },
    instructions: { code: 'STALE_GENERATED_AGENT', change(f) { fs.appendFileSync(path.join(f.spec.options.agentDir, f.original.resolution.agent_file), '\nchanged instructions'); } },
    nativeSHA: { code: 'REPAIR_COMPLETION_INVALID', change(f) {
      const pin = f.original.completed.runtime_evidence.native_session_evidence;
      const directory = require(path.join(scripts, 'codex-runtime-host.cjs')).nativeSessionCandidates(path.join(f.original.native_custody.native_home, 'sessions'), f.original.completed.session_id);
      assert.equal(directory.length, 1); assert.equal(path.basename(directory[0]), pin.file); fs.appendFileSync(directory[0], '\n');
    } },
    transcriptSHA: { code: 'CI_ORIGINAL_INVALID', change(f) { fs.appendFileSync(f.original.completed.runtime_evidence.transcript.path, '\n'); } },
    ambiguous: { code: 'REPAIR_COMPLETION_INVALID', change(f) {
      const files = require(path.join(scripts, 'codex-runtime-host.cjs')).nativeSessionCandidates(path.join(f.original.native_custody.native_home, 'sessions'), f.original.completed.session_id);
      assert.equal(files.length, 1); fs.copyFileSync(files[0], path.join(path.dirname(files[0]), 'duplicate-' + f.original.completed.session_id + '.jsonl'));
    } },
    foreignRun: { code: 'CI_ORIGINAL_INVALID', change(f) {
      const request = JSON.parse(fs.readFileSync(f.spec.requestFile)); request.scope.run_id = 'foreign-control'; fs.writeFileSync(f.spec.requestFile, JSON.stringify(request));
    } },
    allowlist: { code: 'CI_SUBJECT_CHANGED', change(f) {
      const file = path.resolve(f.spec.options.graphDir, '../config.json'), config = JSON.parse(fs.readFileSync(file));
      config.delivery_pipeline.verification_commands.default[0].profile = 'sandbox'; fs.writeFileSync(file, JSON.stringify(config));
    } },
    signer: { code: 'SIGNER_UNAVAILABLE', change(f) { git(f.spec.options.scope.worktree, 'config', 'user.signingkey', '0'.repeat(40)); } },
    branch: { code: 'CI_SUBJECT_CHANGED', change(f) { git(f.spec.options.scope.worktree, 'branch', '-m', 'foreign-branch'); } },
    head: { code: 'CI_SUBJECT_CHANGED', change(f) {
      git(f.spec.options.scope.worktree, 'commit', '--allow-empty', '-qm', 'foreign fixture head');
    } },
    base: { code: 'CI_SUBJECT_CHANGED', change(f) {
      const root = f.spec.options.scope.worktree;
      const commit = git(root, 'commit-tree', git(root, 'rev-parse', 'main^{tree}'), '-p', f.original.preparation.commit.expectedBase, '-m', 'foreign fixture base');
      git(root, 'update-ref', 'refs/heads/main', commit);
    } },
  };
  for (const [name, mutation] of Object.entries(mutations)) test('T36-refusal authentic completed CLI ' + name, bounded, () => {
    const signing = fixture.signingFixture();
    try {
      const f = establish(signing, 'fixed'); mutation.change(f);
      const failed = invoke(f.file); assert.equal(failed.status, 1, failed.stderr);
      assert.equal(events(f.file).at(-1).code, mutation.code, failed.stderr);
      for (const kind of ['HOST', 'sign', 'push']) assert.equal(events(f.file).filter(row => row.kind === kind).length, 0);
      assert.equal(events(f.file).filter(row => row.kind === 'native').length, 1);
      assert.deepEqual(operation(f.spec).payload.completed, f.original.completed);
    } finally { signing.close(); }
  });
  test('T36-refusal changed producer generation never rebinds the completed original', bounded, () => {
    const signing = fixture.signingFixture();
    try {
      const directory = path.join(signing.directory, 'source-generation');
      fs.cpSync(scripts, directory, { recursive: true });
      const consumer = path.join(directory, 'codex-delivery-host.cjs'), f = establish(signing, 'fixed', 'before_record', consumer);
      fs.appendFileSync(consumer, '\nvoid "changed fixture generation";\n');
      const failed = invoke(f.file, 'retry', '', consumer); assert.equal(failed.status, 1, failed.stderr);
      assert.equal(events(f.file).at(-1).code, 'CI_ORIGINAL_INVALID', failed.stderr);
      assert.equal(events(f.file).filter(row => row.kind === 'native').length, 1);
      assert.equal(events(f.file).filter(row => ['HOST', 'sign', 'push'].includes(row.kind)).length, 0);
      assert.deepEqual(operation(f.spec).payload, f.original);
    } finally { signing.close(); }
  });
  test('T36-refusal unfinished native original stays unknown without relaunch', bounded, () => {
    const signing = fixture.signingFixture();
    try {
      const file = path.join(signing.directory, 'unfinished.json');
      fs.writeFileSync(file, JSON.stringify({ signing: { directory: signing.directory, signer: signing.signer }, outcome: 'fixed' }));
      const first = invoke(file, 'establish', 'unfinished'); assert.equal(first.status, 1, first.stderr);
      const spec = JSON.parse(fs.readFileSync(file)); assert.equal(operation(spec).payload.completed, undefined);
      const failed = invoke(file); assert.equal(failed.status, 1, failed.stderr);
      assert.equal(events(file).at(-1).code, 'CI_ORIGINAL_UNKNOWN', failed.stderr);
      assert.equal(events(file).filter(row => row.kind === 'native').length, 1);
      assert.equal(events(file).filter(row => ['HOST', 'sign', 'push'].includes(row.kind)).length, 0);
    } finally { signing.close(); }
  });
  test('T36-refusal concurrent live CLI control and genuine dead-owner takeover', bounded, async () => {
    const signing = fixture.signingFixture(); let holder;
    try {
      const f = establish(signing, 'fixed');
      holder = spawn(process.execPath, [__filename, '--fixture-child', f.file, 'retry', 'hold:record', SOURCE], { stdio: 'pipe' });
      let stderr = ''; holder.stderr.on('data', data => { stderr += data; });
      const ended = new Promise(resolve => holder.on('close', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 30000;
      while (!events(f.file).some(row => row.kind === 'interruption' && row.point === 'record')) {
        assert.ok(Date.now() < deadline, 'actual fresh CLI reached its live recovery barrier: ' + stderr);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const refused = invoke(f.file); assert.equal(refused.status, 1, refused.stderr);
      assert.equal(events(f.file).at(-1).code, 'RECOVERY_IN_PROGRESS', refused.stderr);
      holder.kill('SIGKILL'); const status = await ended; assert.equal(status.signal, 'SIGKILL'); holder = null;
      finished(f);
    } finally { holder?.kill('SIGKILL'); signing.close(); }
  });
  test('T36-refusal live original producer and dead original takeover preserve factual state', bounded, async () => {
    const signing = fixture.signingFixture(); let holder;
    try {
      const file = path.join(signing.directory, 'live-original.json');
      fs.writeFileSync(file, JSON.stringify({ signing: { directory: signing.directory, signer: signing.signer }, outcome: 'fixed' }));
      holder = spawn(process.execPath, [__filename, '--fixture-child', file, 'establish', 'hold:before_record', SOURCE], { stdio: 'pipe' });
      let stderr = ''; holder.stderr.on('data', data => { stderr += data; });
      const ended = new Promise(resolve => holder.on('close', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(file + '.events') || !events(file).some(row => row.kind === 'interruption')) {
        assert.ok(Date.now() < deadline, 'actual original CLI reached native completion: ' + stderr);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const f = established(file);
      assert.equal(f.originalStatus.owner.status, 'active');
      const refused = invoke(file); assert.equal(refused.status, 1, refused.stderr);
      assert.equal(events(file).at(-1).code, 'WRITER_FENCED', refused.stderr);
      assert.deepEqual(fs.readFileSync(f.runStore), f.originalRunBytes);
      holder.kill('SIGKILL'); assert.equal((await ended).signal, 'SIGKILL'); holder = null;
      finished(f);
    } finally { holder?.kill('SIGKILL'); signing.close(); }
  });
  test('T36-refusal foreign replacement controller lease cannot acquire original recovery', bounded, () => {
    const signing = fixture.signingFixture();
    try {
      const f = establish(signing, 'fixed');
      assert.equal(f.originalStatus.owner.status, 'released');
      const controller = require(path.join(scripts, 'run-controller.cjs')).createRunController({ storeDir: path.dirname(f.runStore) });
      controller.begin(controller.store.get(f.original.scope.run_id).run);
      const before = fs.readFileSync(f.runStore), failed = invoke(f.file);
      assert.equal(failed.status, 1, failed.stderr);
      assert.equal(events(f.file).at(-1).code, 'WRITER_FENCED', failed.stderr);
      assert.deepEqual(fs.readFileSync(f.runStore), before);
      assert.equal(events(f.file).filter(row => ['HOST', 'sign', 'push'].includes(row.kind)).length, 0);
      assert.equal(events(f.file).filter(row => row.kind === 'native').length, 1);
      controller.release(f.original.scope.run_id);
    } finally { signing.close(); }
  });
  test('T36-refusal unchanged terminal runs, default TTL and stale controller fences', bounded, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't36-fences-')));
    try {
      const { createRunController, DEFAULT_LEASE_TTL_MS } = require(path.join(scripts, 'run-controller.cjs'));
      const { createRunScope } = require(path.join(scripts, 'run-scope.cjs'));
      let now = 1000;
      const options = { storeDir: path.join(directory, 'runs'), now: () => now };
      const first = createRunController(options);
      const run = createRunScope({ run_id: 'terminal-native', repository_id: 'fixture/repository', worktree: directory,
        phase: 53, ticket: 'T-53-36', runtime: 'codex', provider: 'openai', owner_id: first.owner_id,
        dispatch: { dispatch_id: 'fixture-dispatch', role: 'ci-fix', model: 'gpt-6.1-sol', effort: 'low' } });
      first.begin(run); first.fail(run.run_id, { reason: 'fixture failure retained' });
      const before = fs.readFileSync(path.join(options.storeDir, 'runs.json'));
      assert.throws(() => createRunController(options).begin(run), { code: 'RUN_TERMINAL' });
      assert.deepEqual(fs.readFileSync(path.join(options.storeDir, 'runs.json')), before);
      const recovery = { ...run, run_id: 'fresh-control', lease: { ...run.lease, run_id: 'fresh-control' } };
      const fresh = createRunScope({ ...recovery, lease: undefined, owner_id: first.owner_id });
      first.begin(fresh);
      now += DEFAULT_LEASE_TTL_MS + 1;
      assert.throws(() => first.assertOwner(fresh.run_id), { code: 'LEASE_EXPIRED' });
      const contender = createRunController(options); contender.begin(fresh);
      assert.throws(() => first.assertOwner(fresh.run_id), { code: 'SESSION_FENCED' });
      contender.assertOwner(fresh.run_id); contender.fail(fresh.run_id, { reason: 'fixture control complete' });
      assert.equal(first.status(run.run_id).state, 'failed');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('T36-refusal private owner guard checks actual controller leases and dead processes', bounded, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't36-owner-')));
    const savedHome = process.env.HOME;
    process.env.HOME = directory;
    try {
      const Module = require('node:module'), loaded = new Module(SOURCE, module);
      loaded.filename = SOURCE; loaded.paths = Module._nodeModulePaths(path.dirname(SOURCE));
      loaded._compile(fs.readFileSync(SOURCE, 'utf8') + '\nmodule.exports = { ownerGuard: assertCompletedCiOwner };', SOURCE);
      const { createRunController } = require(path.join(scripts, 'run-controller.cjs'));
      const { createRunScope } = require(path.join(scripts, 'run-scope.cjs'));
      const worktree = path.join(directory, 'worktree'), storageRoot = path.join(directory, 'host-state');
      fs.mkdirSync(worktree);
      const scope = { run_id: 'original-owner', repository_id: 'fixture/repository', worktree,
        phase: 53, ticket: 'T-53-36', runtime: 'codex', provider: 'openai' };
      const storeDir = path.join(storageRoot, hash(scope.run_id + '\0' + worktree), 'runs');
      const controller = createRunController({ storeDir });
      controller.begin(createRunScope({ ...scope, owner_id: controller.owner_id,
        dispatch: { dispatch_id: 'original-dispatch', role: 'ci-fix', model: 'gpt-6.1-sol', effort: 'low' } }));
      const status = controller.status(scope.run_id);
      const pinned = { scope: status.scope, owner_id: status.owner.owner_id, lease_id: status.owner.lease_id,
        epoch: status.owner.epoch, pid: process.pid, hostname: os.hostname() };
      const state = { operation: { scope, controller_owner: pinned }, options: { storageRoot } };
      assert.throws(() => loaded.exports.ownerGuard(state), { code: 'WRITER_FENCED' });
      controller.release(scope.run_id);
      const originalBytes = fs.readFileSync(path.join(storeDir, 'runs.json'));
      loaded.exports.ownerGuard(state);
      assert.deepEqual(fs.readFileSync(path.join(storeDir, 'runs.json')), originalBytes);
      const recoveryScope = { ...scope, run_id: 'fresh-runtime-control' };
      const recovery = createRunController({ storeDir: path.join(storageRoot, hash(recoveryScope.run_id + '\0' + worktree), 'runs') });
      recovery.begin(createRunScope({ ...recoveryScope, owner_id: recovery.owner_id,
        dispatch: { dispatch_id: 'recovery-dispatch', role: 'ci-fix', model: 'gpt-6.1-sol', effort: 'low' } }));
      const runtimeOptions = { scope, controller: recovery, probe: { status: 'available', executable: 'fixture',
        capabilities: { supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['low'] } },
      recorderDir: path.join(storageRoot, 'receipts'), env: { CODEX_HOME: path.join(directory, 'native') },
      spawn() { assert.fail('constructing recovery must never launch native work'); } };
      const runtime = require(path.join(scripts, 'codex-runtime-host.cjs'));
      assert.throws(() => runtime.createCodexRuntimeHost(runtimeOptions), { code: 'RUN_NOT_FOUND' });
      const host = runtime.createCodexRuntimeHost({ ...runtimeOptions, run_id: recoveryScope.run_id });
      assert.equal(host.scope.run_id, scope.run_id);
      assert.equal(host.run_id, recoveryScope.run_id);
      recovery.release(recoveryScope.run_id);
      assert.deepEqual(fs.readFileSync(path.join(storeDir, 'runs.json')), originalBytes);
      const foreign = createRunController({ storeDir });
      foreign.begin(controller.store.get(scope.run_id).run);
      assert.throws(() => loaded.exports.ownerGuard(state), { code: 'WRITER_FENCED' });
      foreign.release(scope.run_id);

      const file = path.join(directory, 'dead-owner.json');
      const child = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs'), os = require('node:os');
        const scope = JSON.parse(process.argv[1]);
        const controller = require(process.argv[2]).createRunController({ storeDir: process.argv[3] });
        controller.begin(require(process.argv[4]).createRunScope({ ...scope, owner_id: controller.owner_id,
          dispatch: { dispatch_id: 'original-dispatch', role: 'ci-fix', model: 'gpt-6.1-sol', effort: 'low' } }));
        const status = controller.status(scope.run_id);
        fs.writeFileSync(process.argv[5], JSON.stringify({ scope: status.scope, owner_id: status.owner.owner_id,
          lease_id: status.owner.lease_id, epoch: status.owner.epoch, pid: process.pid, hostname: os.hostname() }));
      `, JSON.stringify(scope), path.join(scripts, 'run-controller.cjs'), storeDir, path.join(scripts, 'run-scope.cjs'), file],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(child.status, 0, child.stderr);
      state.operation.controller_owner = JSON.parse(fs.readFileSync(file));
      const deadBytes = fs.readFileSync(path.join(storeDir, 'runs.json'));
      loaded.exports.ownerGuard(state);
      assert.deepEqual(fs.readFileSync(path.join(storeDir, 'runs.json')), deadBytes);
      state.operation.controller_owner.hostname += '-foreign';
      assert.throws(() => loaded.exports.ownerGuard(state), { code: 'WRITER_FENCED' });
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test('T36-package complete whole-builder inventory, modes, bytes and both identities', bounded, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't36-package-')));
    try {
      const source = path.join(directory, 'source'), built = packageProof.packageSource(source);
      const entries = packageProof.verifyPackage(built);
      packageProof.verifySourceMirrors(source, built);
      assert.deepEqual(entries, packageProof.inventory(path.join(root, 'plugins/shipyard')));
      assert.deepEqual(fs.readFileSync(path.join(built, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs')), fs.readFileSync(SOURCE));
      for (const name of ['host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs', '.codex-plugin/plugin.json', 'package-build.json']) {
        const file = path.join(built, name), bytes = fs.readFileSync(file);
        fs.appendFileSync(file, 'foreign package');
        assert.throws(() => packageProof.verifyPackage(built));
        fs.writeFileSync(file, bytes);
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('T36-admission unchanged exact74 prefix and normal75 unit78 total matrix and run.sh queue', bounded, () => {
    const s = require('./shard-files.cjs'), files = s.unitFiles(), tasks = s.unitTasks(files);
    const actual = s.appendShard(s.readManifest(), tasks), self = path.basename(__filename);
    assert.ok(actual.shards.length >= 75);
    assert.equal(hash(JSON.stringify(actual.shards.slice(0, 74))), 'a6a52de553ecef8424b4a39d85bd6ce7338549072450a91c902c63a63a0da9b6');
    assert.deepEqual(actual.shards[74], [self]);
    assert.equal(actual.shards.flat().filter(task => task === self).length, 1);
    assert.deepEqual([...actual.shards.flat()].sort(), tasks);
    assert.equal(new Set(actual.shards.flat()).size, tasks.length);
    const matrix = spawnSync(process.execPath, [path.join(__dirname, 'shard-files.cjs'), '--matrix'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(matrix.status, 0, matrix.stderr);
    assert.deepEqual(JSON.parse(matrix.stdout).shard, actual.shards.map((_, i) => (i + 1) + '/' + actual.shards.length));
    for (let i = 0; i < actual.shards.length; i++) assert.deepEqual(s.selectTaskShard((i + 1) + '/' + actual.shards.length), actual.shards[i]);
    const runner = fs.readFileSync(path.join(__dirname, 'run.sh'), 'utf8');
    const selection = /unit_selection="\$\(node - "\$\{UNIT_SHARD:-\}" <<'NODE'\n([^]*?)\nNODE\n\)"/.exec(runner);
    assert.ok(selection, 'actual run.sh queue producer');
    for (const shard of ['', '75/' + actual.shards.length]) {
      const queue = spawnSync(process.execPath, ['-', shard], { cwd: root, input: selection[1], encoding: 'utf8', timeout: 30000 });
      assert.equal(queue.status, 0, queue.stderr);
      const expected = (shard ? [self] : tasks).map(task => { const parsed = s.parseTask(task);
        return 'tests/unit/' + parsed.file + (parsed.partition === null ? '' : '#integration-partition=' + parsed.partition); });
      assert.deepEqual(queue.stdout.trim().split('\n'), expected);
    }
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(workflow, /shard-files\.cjs --matrix/);
    assert.ok(actual.shards.length + 3 >= 78);
    assert.equal(hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
    assert.throws(() => s.selectTaskShard('1/74'));
    assert.throws(() => s.validateManifest({ ...actual, shards: [...actual.shards, [self]] }, tasks));
    assert.throws(() => s.validateManifest({ ...actual, shards: actual.shards.slice(0, -1) }, tasks));
  });
  test('T36-cold-cli canonical and shipped actual CLI reject caller control flags', bounded, () => {
    for (const consumer of [SOURCE, SHIPPED]) for (const flag of ['--owner', '--store', '--token', '--json', '--recover-completed']) {
      const result = spawnSync(process.execPath, [consumer, flag, 'caller'], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /args-file/);
    }
  });
}
