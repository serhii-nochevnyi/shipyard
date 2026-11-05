'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cases = [];
const test = (title, run) => cases.push({ title, run });
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
function fixtures(name, end, names, transform = value => value) {
  const filename = path.join(__dirname, name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
  const original = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === 'node:test' ? { test() {}, describe() {} } : original.call(this, name, ...args);
    };
    loaded._compile(transform(fs.readFileSync(filename, 'utf8').split(end)[0])
      + '\nmodule.exports = { ' + names + ' };', filename);
  } finally { Module._load = original; }
  return loaded.exports;
}
const codex = fixtures('phase53-codex-architecture.test.cjs', "test('caller architecture",
  'architectureFixture, ordinaryArchitecture, publicIntegrationFixture');
const integration = fixtures('phase53-codex-integration.test.cjs', "function coldCurrent",
  'semanticFixture, supportedPartitionCaller');
const claude = fixtures('phase53-claude-review.test.cjs', "for (const role of ['integrator'",
  'nativeFixture, ordinary', source => source
    .replace('pending[1](); pending[0]();', 'pending.splice(0).reverse().forEach(finish => finish());')
    .replace('assert.equal(completed.length, 0);', 'assert.equal(completed.length % 3, 0);'));
const code = fixtures('phase53-code-review.test.cjs', "for (const runtime of ['codex', 'claude'])",
  'fixture, setup, current');
const artifact = require(path.join(scripts, 'role-artifact.cjs'));
const boundary = require(path.join(scripts, 'dispatch-boundary.cjs'));
const delivery = require(path.join(scripts, 'codex-delivery-host.cjs'));

function ordinary(f, runtime, role, controls = {}) {
  if (role === 'code-review') { code.setup(f); return code.fixture(f, runtime, controls); }
  const prepared = runtime === 'claude' ? claude.nativeFixture(f, role, controls)
    : role === 'integrator' ? integration.semanticFixture(f, controls) : codex.architectureFixture(f, controls);
  prepared.run = () => runtime === 'claude' ? claude.ordinary(f, role, prepared)
    : role === 'integrator' ? integration.supportedPartitionCaller(f, runtime, prepared.options)
      : codex.ordinaryArchitecture(f, prepared);
  return prepared;
}

function interruptPublication(predicate) {
  const saved = { linkSync: fs.linkSync, renameSync: fs.renameSync };
  let interrupted = false;
  for (const method of Object.keys(saved)) fs[method] = function(from, to, ...args) {
    if (!interrupted && predicate(String(to), from)) {
      interrupted = true;
      throw Object.assign(new Error('fixture crash at original publication'), { code: 'FIXTURE_CRASH' });
    }
    return saved[method].call(this, from, to, ...args);
  };
  return { restore() { Object.assign(fs, saved); }, get interrupted() { return interrupted; } };
}
function current(f, role) {
  const input = { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
    head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName };
  const file = path.join(scripts, 'role-artifact.cjs'), cached = require.cache[file];
  delete require.cache[file];
  try { return require(file)[{ integrator: 'currentIntegrationVerdict', 'arch-review': 'currentArchitectureVerdict',
    'code-review': 'currentCodeReviewVerdict' }[role]](input); } finally { require.cache[file] = cached; }
}

for (const runtime of ['codex', 'claude']) for (const role of ['integrator', 'arch-review', 'code-review']) {
  test(`${runtime} ${role}: completed original survives lost recording, retention index and final acknowledgement`, async () => {
    await codex.publicIntegrationFixture(async f => {
      const prepared = ordinary(f, runtime, role);
      const crash = interruptPublication(file => /\/record-[a-f0-9]+\.json$/.test(file));
      try { await assert.rejects(prepared.run()); } finally { crash.restore(); }
      assert.equal(crash.interrupted, true);
      assert.equal(prepared.launches.length, 2);
      const sessions = prepared.launches.map(item => item.session);
      const dispatches = prepared.launches.map(item => 'semantic-worker-' + require('node:crypto')
        .createHash('sha256').update(JSON.stringify([item.payload.snapshot_sha256, 'worker', item.payload.assignment.id])).digest('hex'));
      const recorder = boundary.createDurableRecorder(prepared.recorder.storeDir);
      const stages = dispatches.map(id => recorder.getOriginalDispatch(id));
      assert.deepEqual(stages.map(value => value.state).sort(), ['native-completed', 'recorded']);
      const cold = require('node:child_process').execFileSync(process.execPath, ['-e',
        `const api = require(${JSON.stringify(path.join(scripts, 'dispatch-boundary.cjs'))});
         const recorder = api.createDurableRecorder(process.argv[1]);
         console.log(JSON.stringify(JSON.parse(process.argv[2]).map(id => recorder.getOriginalDispatch(id).state)));`,
        recorder.storeDir, JSON.stringify(dispatches)], { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(cold).sort(), ['native-completed', 'recorded']);
      const indexCrash = interruptPublication(file => file.includes('integration-semantic-original-'));
      try { await assert.rejects(prepared.run()); } finally { indexCrash.restore(); }
      assert.equal(indexCrash.interrupted, true);
      assert.equal(prepared.launches.length, 2, 'recording repair must not launch a third worker');
      const ackCrash = interruptPublication(file => file.includes('integration-semantic-delivered-'));
      try { await assert.rejects(prepared.run()); } finally { ackCrash.restore(); }
      assert.equal(ackCrash.interrupted, true);
      assert.equal(prepared.launches.length, 3);
      assert.ok(current(f, role)?.authenticated, 'accepted local final survives lost consumer acknowledgement');
      const completed = await prepared.run();
      assert.equal(completed.role, role);
      assert.equal(prepared.launches.length, 3, 'only the original independent final may write common evidence');
      assert.deepEqual(prepared.launches.slice(0, 2).map(item => item.session), sessions);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      assert.ok(current(f, role)?.authenticated);
      const index = path.join(artifact.archiveAuthorityDirectory(f.worktree),
        'integration-semantic-original-' + dispatches[0].slice('semantic-worker-'.length) + '.json');
      const indexBytes = fs.readFileSync(index);
      fs.unlinkSync(index);
      await prepared.run();
      assert.deepEqual(fs.readFileSync(index), indexBytes);
      assert.equal(prepared.launches.length, 3, 'a lost index cannot schedule a new review round');
      assert.ok(current(f, role)?.authenticated);
    });
  });
  test(`${runtime} ${role}: started uncertainty refuses a competing owner without duplicate physical work`, async () => {
    await codex.publicIntegrationFixture(async f => {
      let competing;
      const prepared = ordinary(f, runtime, role, { onLaunch() {
        competing ||= prepared.run();
        competing.catch(() => {});
      } });
      await prepared.run();
      await assert.rejects(competing, error => error.code === 'SEMANTIC_REVIEW_UNKNOWN');
      assert.equal(prepared.launches.length, 3);
      assert.ok(current(f, role)?.authenticated);
    });
  });
}

for (const runtime of ['codex', 'claude']) for (const completion of ['missing', 'duplicate'])
  test(`${runtime}: ${completion} native completion remains unproven through restart`, async () => {
    await codex.publicIntegrationFixture(async f => {
      const prepared = ordinary(f, runtime, 'arch-review', { native(rows) {
        const index = runtime === 'codex' ? rows.findIndex(row => row.payload?.type === 'task_complete') : rows.length - 1;
        assert.ok(index >= 0);
        if (completion === 'missing') rows.splice(index, 1);
        else rows.push(structuredClone(rows[index]));
      } });
      await assert.rejects(prepared.run()); assert.equal(prepared.launches.length, 2);
      await assert.rejects(prepared.run()); assert.equal(prepared.launches.length, 2);
      assert.equal(current(f, 'arch-review'), null);
    });
  });

for (const runtime of ['codex', 'claude']) test(`${runtime}: original consumer refuses changed source, membership and same-tree head identity`, async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = ordinary(f, runtime, 'arch-review');
    await prepared.run(); assert.ok(current(f, 'arch-review')?.authenticated);
    for (const file of [path.join(f.worktree, 'src/provider.cjs'), path.join(f.graphDir, 'tickets.json')]) {
      const bytes = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('changed governing bytes')]));
        let accepted; try { accepted = current(f, 'arch-review'); } catch { accepted = null; }
        assert.equal(accepted, null);
      } finally { fs.writeFileSync(file, bytes); }
      assert.ok(current(f, 'arch-review')?.authenticated);
    }
    const cp = require('node:child_process');
    const git = args => cp.execFileSync('git', ['-C', f.worktree, ...args], { encoding: 'utf8' }).trim();
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Recovery Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-m', 'fixture: same tree with a different source identity']);
    assert.equal(git(['rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(current(f, 'arch-review'), null);
    await assert.rejects(prepared.run()); assert.equal(prepared.launches.length, 3);
  });
});

for (const runtime of ['codex', 'claude']) test(`${runtime}: recovered blocked originals remain owed without completion or round credit`, async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = ordinary(f, runtime, 'code-review', { result(result) {
      result.completeness = 'blocked'; result.outcome = 'human-review-required';
      result.required_context = ['Actual caller is unavailable']; result.unread = [result.coverage[0]];
    } });
    const crash = interruptPublication(file => /\/record-[a-f0-9]+\.json$/.test(file));
    try { await assert.rejects(prepared.run()); } finally { crash.restore(); }
    assert.equal(crash.interrupted, true);
    const completed = await prepared.run();
    assert.equal(completed.result.verdict, 'incomplete'); assert.equal(prepared.launches.length, 3);
    const status = require(path.join(scripts, 'phase-code-review.cjs')).status({ worktree: f.worktree,
      graphDir: f.graphDir, phase: 49, pr: f.pr.number }, prepared.options);
    assert.equal(status.state, 'owed'); assert.equal(status.rounds_used, 0);
    await prepared.run(); assert.equal(prepared.launches.length, 3);
  });
});

for (const runtime of ['codex', 'claude']) test(`${runtime}: an original reservation without native completion stays reserved and unknown`, async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = ordinary(f, runtime, 'arch-review');
    const link = fs.linkSync;
    let interrupted = false;
    fs.linkSync = function(from, to, ...args) {
      const result = link.call(this, from, to, ...args);
      if (!interrupted && String(to).includes('integration-semantic-launch-')
          && JSON.parse(fs.readFileSync(from, 'utf8')).payload.stage === 'final') {
        interrupted = true; throw Error('fixture interruption after original final reservation');
      }
      return result;
    };
    try { await assert.rejects(prepared.run()); } finally { fs.linkSync = link; }
    assert.equal(interrupted, true); assert.equal(prepared.launches.length, 2);
    await assert.rejects(prepared.run(), error => error.code === 'SEMANTIC_REVIEW_UNKNOWN'
      && error.details?.stage === 'reserved');
    assert.equal(prepared.launches.length, 2); assert.equal(current(f, 'arch-review'), null);
  });
});

for (const runtime of ['codex', 'claude']) test(`${runtime}: native original, output and receipt tampering never authorize recovery`, async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = ordinary(f, runtime, 'arch-review');
    const crash = interruptPublication(file => /\/record-[a-f0-9]+\.json$/.test(file));
    try { await assert.rejects(prepared.run()); } finally { crash.restore(); }
    assert.equal(crash.interrupted, true);
    const originals = prepared.launches.map(launch => ({ launch, dispatch: 'semantic-worker-' + require('node:crypto')
      .createHash('sha256').update(JSON.stringify([launch.payload.snapshot_sha256, 'worker', launch.payload.assignment.id])).digest('hex') }));
    const recorder = boundary.createDurableRecorder(prepared.recorder.storeDir);
    const original = originals.find(item => recorder.getOriginalDispatch(item.dispatch).state === 'native-completed');
    const record = recorder.getOriginalDispatch(original.dispatch).record;
    const stream = runtime === 'codex' ? record.receipt.runtime_evidence.transcript : record.receipt.transcript;
    const reservation = path.join(recorder.storeDir, 'reservation-' + require('node:crypto').createHash('sha256')
      .update(original.dispatch).digest('hex') + '.json');
    const native = runtime === 'codex' ? original.launch.nativePath
      : path.isAbsolute(record.receipt.selection_evidence.transcript.path) ? record.receipt.selection_evidence.transcript.path
        : path.join(path.dirname(stream.path), 'projects', record.receipt.selection_evidence.transcript.path);
    for (const file of [native, stream.path, reservation]) {
      const bytes = fs.readFileSync(file);
      try {
        fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('changed original bytes')]));
        await assert.rejects(prepared.run());
        assert.equal(prepared.launches.length, 2);
      } finally { fs.writeFileSync(file, bytes); }
    }
    const bytes = fs.readFileSync(native);
    try {
      fs.unlinkSync(native);
      await assert.rejects(prepared.run());
      assert.equal(prepared.launches.length, 2);
    } finally { fs.writeFileSync(native, bytes); }
    if (runtime === 'codex') {
      const duplicate = path.join(path.dirname(original.launch.nativePath), 'duplicate-' + original.launch.session + '.jsonl');
      try {
        fs.writeFileSync(duplicate, bytes);
        await assert.rejects(prepared.run()); assert.equal(prepared.launches.length, 2);
      } finally { fs.unlinkSync(duplicate); }
    }
    await prepared.run(); assert.equal(prepared.launches.length, 3);
    assert.ok(current(f, 'arch-review')?.authenticated);
  });
});

test('codex ordinary CLI restart consumes the accepted original final without a fourth native launch', async () => {
  await codex.publicIntegrationFixture(async f => {
    const prepared = ordinary(f, 'codex', 'code-review', { onLaunch(launch, launches) {
      assert.ok(launches.length <= 3, 'unchanged CLI must not launch another native review');
    } });
    const original = await prepared.run();
    assert.equal(prepared.launches.length, 3);
    assert.ok(current(f, 'code-review')?.authenticated);
    const file = path.join(path.dirname(f.worktree), 'fresh-code-review-cli.json');
    const request = { scope: { worktree: f.worktree, phase: 49,
      ticket: original.subject, run_id: 'fresh-code-review-cli' }, role: 'code-review', context: {} };
    try {
      for (const role of [' code-review ', '\tcode-review\n']) for (const patch of [
        { context: { prompt: 'caller' } }, { signals: { critical: true } }]) {
        fs.writeFileSync(file, JSON.stringify({ ...request, ...patch, role }));
        await assert.rejects(delivery.runCli(['--args-file', file], { write() {} }, prepared.options), {
          code: 'INVALID_CODE_REVIEW_CONTEXT', message: 'codex-code-review-context: '
            + (patch.context ? 'caller prompts or selectors are refused' : 'caller signals are refused'),
        });
        assert.equal(prepared.launches.length, 3);
      }
      fs.writeFileSync(file, JSON.stringify(request));
      const result = await delivery.runCli(['--args-file', file], { write() {} }, prepared.options);
      assert.equal(result.subject, original.subject);
      assert.equal(prepared.launches.length, 3);
      assert.ok(current(f, 'code-review')?.authenticated);
    } finally { fs.rmSync(file, { force: true }); }
  });
});

for (const runtime of ['codex', 'claude']) test(`${runtime}: unavailable multiline probe retains the original error and terminal controller state`, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unavailable-recovery-')));
  try {
    const { createRunController } = require(path.join(scripts, 'run-controller.cjs'));
    const { createRunScope } = require(path.join(scripts, 'run-scope.cjs'));
    const controller = createRunController({ storeDir: path.join(root, 'controller'), ownerId: 'fixture-owner' });
    const scope = { run_id: 'unavailable', repository_id: root, phase: 53, ticket: 'T-53-09', worktree: root,
      runtime, owner_id: 'fixture-owner', dispatch: { runtime, role: 'arch-review', dispatch_id: 'fixture' } };
    controller.begin(createRunScope(scope));
    const probe = { status: 'unavailable', reason: 'native unavailable\noriginal diagnostic' + 'x'.repeat(3000), detail: 'full\nprobe error' };
    let launches = 0;
    const host = require(path.join(scripts, runtime + '-runtime-host.cjs'));
    assert.throws(() => host[runtime === 'codex' ? 'createCodexRuntimeHost' : 'createClaudeRuntimeHost']({
      scope: { run_id: scope.run_id, worktree: root, phase: 53, ticket: 'T-53-09' }, controller,
      probe, spawn() { launches++; } }), error => error.code === 'RUNTIME_UNAVAILABLE'
        && error.details?.probe?.detail === probe.detail);
    assert.equal(controller.status(scope.run_id).state, 'runtime_unavailable');
    assert.equal(controller.status(scope.run_id).retry.last_reason.length, 2048);
    assert.equal(launches, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const publicationFixtures = () => fixtures('phase-code-review-publish.test.cjs', "for (const jira of [null, 'PRJ-42'])",
  'fixture, flow', source => source + "\nfunction retainPlanningInput(f, input, planningRoot = f.root, repo = null) { return require('../fixtures/code-review/artifact-fixture.cjs').retainPlanningInput(f, input, planningRoot, repo); }\n");
for (const kind of ['status', 'comment']) for (const lost of ['response', 'acknowledgement'])
  test(`remote ${kind}: exact owned original reconciles lost ${lost} without another write`, () => {
    const publication = publicationFixtures(), f = publication.fixture();
    try {
      f.seal();
      const gh = f.options.gh;
      let interrupted = false;
      f.options.gh = args => {
        const value = gh(args);
        const mutation = args.includes('-f') && (kind === 'status' ? args[1].includes('/statuses/')
          : args[1].includes('/comments'));
        if (!interrupted && mutation && lost === 'response') {
          interrupted = true; throw Error('fixture response lost after successful remote mutation');
        }
        return value;
      };
      const crash = interruptPublication((file, from) => {
        if (lost !== 'acknowledgement' || !file.endsWith(`.52.${kind}.json`)) return false;
        const saved = JSON.parse(fs.readFileSync(from, 'utf8'));
        return saved.stage === 'published';
      });
      let first;
      try { first = publication.flow.publish(f.input(), f.options); } finally { crash.restore(); }
      assert.equal(first[kind].ok, false);
      assert.equal(first[kind].stage, 'unknown');
      const before = f.writes.length;
      const next = publication.flow.publish(f.input(), f.options);
      assert.equal(next[kind].ok, true, next[kind].reason);
      assert.equal(next[kind].stage, 'published');
      assert.equal(next[kind].action, 'reconciled');
      assert.equal(f.writes.length, before);
      assert.ok(f.lookup()?.authenticated);
    } finally { f.cleanup(); }
  });
for (const failure of ['lookup', 'human-edit', 'duplicate', 'foreign-author'])
  test(`remote uncertain comment ${failure} preserves the original review and human bytes`, () => {
    const publication = publicationFixtures(), f = publication.fixture();
    try {
      f.seal();
      const gh = f.options.gh;
      let lost = false;
      f.options.gh = args => {
        const value = gh(args);
        if (!lost && args.includes('-f') && args[1].includes('/comments')) {
          lost = true; throw Error('fixture lost remote write acknowledgement');
        }
        return value;
      };
      assert.equal(publication.flow.publish(f.input(), f.options).comment.stage, 'unknown');
      if (failure === 'lookup') f.failLookup();
      if (failure === 'human-edit') f.comments[0].body += '\nHuman keeps ownership.';
      if (failure === 'duplicate') f.comments.push({ ...f.comments[0], id: 999 });
      if (failure === 'foreign-author') f.comments[0].user = { id: 999 };
      const before = structuredClone(f.comments), writes = f.writes.length;
      const retry = publication.flow.publish(f.input(), f.options);
      assert.equal(retry.comment.ok, false); assert.equal(retry.comment.stage, 'unknown');
      assert.deepEqual(f.comments, before); assert.equal(f.writes.length, writes);
      assert.ok(f.lookup()?.authenticated);
    } finally { f.cleanup(); }
  });

if (isMainThread) describe('phase 53 original-stage recovery', { concurrency: 4 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-recovery-case-')));
    try {
      await new Promise((resolve, reject) => {
        const env = { ...process.env, HOME: home }; delete env.NODE_TEST_CONTEXT;
        const worker = new Worker(__filename, { workerData: index, env });
        let completed = false, failure;
        worker.once('message', message => { completed = message?.completed === true; });
        worker.once('error', error => { failure = error; });
        worker.once('exit', code => failure ? reject(failure) : code || !completed
          ? reject(Error(entry.title + ' exited without assertions: ' + code)) : resolve());
      });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
else Promise.resolve().then(() => cases[workerData].run()).then(() => parentPort.postMessage({ completed: true }))
  .catch(error => setImmediate(() => { throw error; }));
