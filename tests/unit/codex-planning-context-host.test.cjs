'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { buildContextPacket } = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const planningHost = require('../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-planning-context-')));
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source.md'), '# Planning source\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function packetFor(root, sourceRevision = git(root, 'rev-parse', 'HEAD')) {
  const subject = 'phase=43;input=ADR-TEST;repository=shipyard/test';
  const packet = buildContextPacket({
    root,
    role: 'decomposition',
    subject,
    sourceRevision,
    policy: policy.POLICY,
    policyHash: policy.POLICY_HASH,
    scope: { files_modified: [] },
    acceptance: [],
    verification: [],
    requiredRefs: ['source.md'],
    roleContext: {
      adr_refs: [{ path: 'source.md' }],
      requirements: [{ path: 'source.md' }],
      research_refs: [],
      context: { phase: 43, input: 'ADR-TEST' },
    },
  });
  return { subject, sourceRevision, packet };
}

function requestFor(root) {
  const { subject, sourceRevision, packet } = packetFor(root);
  return {
    scope: {
      run_id: 'run-43-15', ticket: 'T-43-15', phase: 43,
      worktree: root, runtime: 'codex', provider: 'openai', repository: 'shipyard/test',
    },
    gsd_role: 'gsd-planner',
    prompt: 'Prepare plans for the accepted decision.',
    signals: {},
    subject,
    sourceRevision,
    contextPacket: packet,
    contextPacketRequired: true,
  };
}

function argsFile(root, request) {
  const file = path.join(root, 'request.json');
  fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  return file;
}

test('validates the packet at launch and delegates only the typed prompt to the receipt-owning host', async () => {
  const f = fixture();
  try {
    const request = requestFor(f.root);
    const file = argsFile(f.root, request);
    let delegated;
    let delegatedFile;
    const stateDir = path.join(f.root, 'dispatch');
    await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, {
      stateDir, waitOptions: { pidLive: () => false },
      runHost: async (argv, stdout, options) => {
        assert.deepEqual(argv.slice(0, 2), ['--detach', '--args-file']);
        delegatedFile = argv[2];
        delegated = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
        assert.equal(fs.statSync(argv[2]).mode & 0o777, 0o600);
        const host = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
        const ack = await host.runCli(argv, stdout, { ...options,
          spawn: () => ({ pid: 999999, on() {}, unref() {} }) });
        fs.writeFileSync(path.join(stateDir, ack.dispatch_id, 'result.jsonl'), JSON.stringify({ status: 'blocked' }));
        return ack;
      },
    }), (error) => error.code === 'PLANNING_REFUSED');
    assert.equal(delegated.scope.run_id, 'run-43-15');
    assert.equal(delegated.scope.repository, 'shipyard/test');
    assert.equal(delegated.gsd_role, 'gsd-planner');
    assert.equal(Object.hasOwn(delegated, 'contextPacket'), false);
    assert.match(delegated.prompt, /verified structured context packet/i);
    assert.ok(delegated.prompt.includes(JSON.stringify(request.contextPacket)));
    assert.equal(fs.existsSync(delegatedFile), false);
  } finally { f.clean(); }
});

test('refuses source edits made after packet construction before invoking the host', async () => {
  const f = fixture();
  try {
    const request = requestFor(f.root);
    const file = argsFile(f.root, request);
    fs.appendFileSync(path.join(f.root, 'source.md'), 'changed\n');
    let launched = false;
    await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, {
      runHost: async () => { launched = true; },
    }), (error) => error.code === 'STALE_CONTEXT_PACKET' && /changed after packet construction/.test(error.message));
    assert.equal(launched, false);
  } finally { f.clean(); }
});

test('refuses a moved source revision before invoking the host', async () => {
  const f = fixture();
  try {
    const request = requestFor(f.root);
    const file = argsFile(f.root, request);
    git(f.root, 'commit', '--allow-empty', '-q', '-m', 'advance source revision');
    let launched = false;
    await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, {
      runHost: async () => { launched = true; },
    }), (error) => error.code === 'STALE_CONTEXT_PACKET' && /source revision differs/.test(error.message));
    assert.equal(launched, false);
  } finally { f.clean(); }
});

for (const [name, result, code] of [
  ['blocked', { status: 'blocked', summary: 'primary refusal' }, 'PLANNING_REFUSED'],
  ['verification_failed', { status: 'verification_failed' }, 'PLANNING_REFUSED'],
  ['missing receipt', { status: 'completed' }, 'UNVERIFIED_RECEIPT'],
  ['foreign receipt', { status: 'completed', receipt: { dispatch_id: 'foreign', compliance: 'verified' } }, 'UNVERIFIED_RECEIPT'],
  ['forged receipt', { status: 'completed', receipt: { compliance: 'verified', gsd_role: 'gsd-planner', policy_hash: policy.POLICY_HASH } }, 'UNVERIFIED_RECEIPT'],
]) test(`readable terminal ${name} refuses and repeat consumption does not launch`, async () => {
  const f = fixture();
  try {
    const request = { ...requestFor(f.root), dispatch_id: 'original-dispatch' };
    const file = argsFile(f.root, request);
    const stateDir = path.join(f.root, 'dispatch');
    let launches = 0;
    const options = { stateDir, testStateRoot: path.join(os.tmpdir(), path.basename(f.root) + '-receipts'),
      waitOptions: { pidLive: () => false, recordWakeEvent() {} },
      runHost: async (argv, stdout) => {
        launches++;
        const host = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
        await host.runCli(argv, stdout, { stateDir,
          spawn: () => ({ pid: 999999, on() {}, unref() {} }) });
        const terminal = { ...result, ...(result.receipt ? { receipt: {
          dispatch_id: request.dispatch_id, ...result.receipt } } : {}) };
        fs.writeFileSync(path.join(stateDir, request.dispatch_id, 'result.jsonl'), JSON.stringify(terminal));
      } };
    for (let attempt = 0; attempt < 2; attempt++) {
      let output = '';
      await assert.rejects(() => planningHost.runCli(['--args-file', file], { write(chunk) { output += chunk; } }, options),
        (error) => error.code === code && error.dispatch_id === request.dispatch_id && error.wait.result.status === result.status);
      assert.equal(output, '');
    }
    assert.equal(launches, 1);
  } finally { f.clean(); }
});

test('timeout and lost recovery retain the original dispatch and copied private request', async () => {
  const f = fixture();
  try {
    const request = { ...requestFor(f.root), dispatch_id: 'original-timeout' };
    const file = argsFile(f.root, request);
    const stateDir = path.join(f.root, 'dispatch');
    let launches = 0;
    let tempFile;
    const options = { stateDir, runHost: async (argv, stdout) => {
      launches++;
      tempFile = argv[2];
      await require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs').runCli(argv, stdout,
        { stateDir, spawn: () => ({ pid: 999999, on() {}, unref() {} }) });
    } };
    for (let attempt = 0; attempt < 2; attempt++) {
      let tick = 0;
      await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, { ...options,
        waitOptions: { pidLive: () => true, timeoutMs: 10, intervalMs: 10,
          clock: () => tick, sleep: async (ms) => { tick += ms; } } }),
      (error) => error.code === 'DISPATCH_TIMEOUT' && error.dispatch_id === request.dispatch_id);
      assert.equal(fs.existsSync(tempFile), false);
      assert.equal(fs.existsSync(path.join(stateDir, request.dispatch_id, 'args.json')), true);
      const copied = fs.readFileSync(path.join(stateDir, request.dispatch_id, 'args.json'));
      fs.writeFileSync(file, JSON.stringify({ ...request, prompt: 'concurrent changed input' }));
      await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, options),
        (error) => error.code === 'INVALID_DISPATCH');
      assert.deepEqual(fs.readFileSync(path.join(stateDir, request.dispatch_id, 'args.json')), copied);
      fs.writeFileSync(file, JSON.stringify(request));
    }
    await assert.rejects(() => planningHost.runCli(['--args-file', file], { write() {} }, { ...options,
      waitOptions: { pidLive: () => false, recordWakeEvent() {} } }),
    (error) => error.code === 'DISPATCH_UNAVAILABLE' && error.dispatch_id === request.dispatch_id);
    assert.equal(launches, 1);
  } finally { f.clean(); }
});

test('supported caller retains genuine blocking parent polls outside its writer tree and reads without writes', async () => {
  const f = fixture();
  const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-external-')));
  let child;
  try {
    assert.equal(typeof planningHost.readWaitAccounting, 'function');
    const request = { ...requestFor(f.root), dispatch_id: 'original-external-wait' };
    const file = argsFile(f.root, request);
    const options = { stateDir: path.join(external, 'dispatch'), testStateRoot: external,
      env: { SHIPYARD_GRAPH_DIR: path.join(f.root, '.planning/graph') },
      waitOptions: { timeoutMs: 80, intervalMs: 20, recordWakeEvent() {} },
      runHost: async (argv, stdout, hostOptions) => {
        await require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs').runCli(argv, stdout, {
          ...hostOptions, spawn() {
            child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
            return child;
          },
        });
      },
    };
    let diagnostic;
    await assert.rejects(planningHost.runCli(['--args-file', file], { write() {} }, {
      ...options, onWaitAccounting(value) { diagnostic = value; },
    }), error => error.code === 'DISPATCH_TIMEOUT');
    assert.ok(diagnostic.parent_rows.length > 0);
    assert.ok(!diagnostic.sink.startsWith(f.root + path.sep));
    for (const row of diagnostic.parent_rows) {
      assert.equal(row.dispatch_id, request.dispatch_id);
      assert.equal(row.run_id, request.scope.run_id);
      assert.equal(row.actor, 'parent');
      assert.equal(row.stage, 'wait_poll');
      assert.equal(row.evidence, 'wait-event');
      assert.equal(row.counts.model_turns, null);
      assert.equal(row.provider_tokens, null);
    }
    const stream = path.join(diagnostic.sink, 'orchestration-overhead.jsonl');
    const before = fs.readFileSync(stream);
    const read = planningHost.readWaitAccounting({ scope: request.scope, dispatchId: request.dispatch_id,
      graphDir: path.join(f.root, '.planning/graph') }, options);
    assert.deepEqual(read.parent_rows, diagnostic.parent_rows);
    assert.deepEqual(fs.readFileSync(stream), before);
    assert.equal(fs.existsSync(path.join(f.root, '.planning/graph/orchestration-overhead.jsonl')), false);
  } finally {
    child?.kill();
    f.clean(); fs.rmSync(external, { recursive: true, force: true });
  }
});

for (const kind of ['inside', 'symlink', 'public']) test('caller refuses ' + kind + ' recorder destinations before waiting', async () => {
  const f = fixture();
  const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-recorder-')));
  try {
    const directory = kind === 'inside' ? path.join(f.root, 'telemetry') : path.join(external, 'telemetry');
    fs.mkdirSync(directory, { mode: kind === 'public' ? 0o755 : 0o700 });
    let sink = directory;
    if (kind === 'symlink') { sink = path.join(external, 'alias'); fs.symlinkSync(directory, sink); }
    const recorder = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs').createRecorder(sink);
    assert.throws(() => planningHost.readWaitAccounting({ scope: requestFor(f.root).scope,
      dispatchId: 'unsafe', graphDir: path.join(f.root, '.planning/graph') }, {
      testStateRoot: external, waitOptions: { overheadRecorder: recorder },
    }), error => error.code === 'INVALID_WAIT_RECORDER');
    assert.equal(fs.existsSync(path.join(directory, 'orchestration-overhead.jsonl')), false);
  } finally { f.clean(); fs.rmSync(external, { recursive: true, force: true }); }
});

for (const failure of [false, true]) test('trusted external recorder ' + (failure ? 'failure preserves the timeout and bounded diagnostic' : 'deduplicates repeat observations'), async () => {
  const f = fixture();
  const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-injection-')));
  try {
    const sink = path.join(external, 'telemetry'); fs.mkdirSync(sink, { mode: 0o700 });
    const durable = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs').createRecorder(sink);
    const recorder = failure ? { ...durable, record() { throw new Error('missing telemetry ' + 'x'.repeat(2000)); } } : durable;
    const request = { ...requestFor(f.root), dispatch_id: 'original-injected-wait' };
    const file = argsFile(f.root, request);
    const options = { stateDir: path.join(external, 'dispatch'), testStateRoot: external,
      env: { SHIPYARD_GRAPH_DIR: path.join(f.root, '.planning/graph') },
      runHost: async (argv, stdout, hostOptions) => require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs').runCli(argv, stdout, {
        ...hostOptions, spawn: () => ({ pid: 999999, on() {}, unref() {} }),
      }),
    };
    const readings = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let tick = 1000;
      await assert.rejects(planningHost.runCli(['--args-file', file], { write() {} }, { ...options,
        onWaitAccounting: value => readings.push(value), waitOptions: { overheadRecorder: recorder,
          pidLive: () => true, timeoutMs: 10, intervalMs: 10, clock: () => tick,
          sleep: async ms => { tick += ms; }, recordWakeEvent() {} },
      }), error => error.code === 'DISPATCH_TIMEOUT' && error.dispatch_id === request.dispatch_id);
    }
    if (failure) {
      assert.equal(readings[0].parent_rows.length, 0);
      assert.ok(readings[0].missing_evidence.length < 600);
      assert.match(readings[0].missing_evidence, /missing telemetry/);
    } else {
      assert.equal(durable.latest().length, 1);
      assert.deepEqual(readings[0].parent_rows, readings[1].parent_rows);
      assert.equal(readings[0].parent_rows[0].observed_at, new Date(1000).toISOString());
    }
    assert.equal(fs.existsSync(path.join(f.root, '.planning/graph/orchestration-overhead.jsonl')), false);
  } finally { f.clean(); fs.rmSync(external, { recursive: true, force: true }); }
});
