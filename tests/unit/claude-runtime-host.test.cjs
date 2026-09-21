'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  EFFORTS,
  createClaudeCliLauncher,
  createClaudeRuntimeHost,
  observedSelection,
  parseClaudeStream,
  probeClaudeRuntime,
} = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');

const SCOPE = {
  run_id: 'run-37-03',
  ticket: 'T-37-03',
  phase: 37,
  worktree: '/tmp/shipyard-t3703',
  runtime: 'claude',
  provider: 'anthropic',
};

function stream(session = '11111111-1111-4111-8111-111111111111', model = 'sonnet', effort = 'max') {
  return [
    { type: 'system', subtype: 'init', session_id: session, model, effort },
    { type: 'assistant', session_id: session, message: { role: 'assistant', model: `claude-${model}-4`, usage: { input_tokens: 4 } }, effort },
    { type: 'result', session_id: session, model: `claude-${model}-4`, effort, result: 'done' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function childFor(output, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.pid = 24037;
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  });
  return child;
}

function probe() {
  return {
    schema: 'shipyard.claude-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable: 'claude',
    runtime_version: '2.1.277',
    capabilities: { supportedModels: ['sonnet', 'opus', 'fable'], supportedEfforts: EFFORTS, observedModel: true, observedEffort: true },
  };
}

suite('claude-runtime-host — native launch and independent evidence');

test('parses session, model and effort from stream records', () => {
  const parsed = parseClaudeStream(stream());
  assert.equal(parsed.session_id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(observedSelection(parsed, 'sonnet', 'max'), { model: 'sonnet', effort: 'max' });
  assert.equal(parsed.assistant_count, 1);
  assert.equal(parsed.usage_count, 1);
});

test('native launcher uses explicit model, effort, session and stream format', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-runtime-'));
  const calls = [];
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: path.join(root, 'transcripts'),
      uuid: () => '22222222-2222-4222-8222-222222222222',
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        return childFor(stream('22222222-2222-4222-8222-222222222222'));
      },
      runtime_version: '2.1.277',
    });
    const result = await launch('run the scoped task', { model: 'sonnet', effort: 'max' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'claude');
    assert.ok(calls[0].args.includes('--print'));
    assert.ok(calls[0].args.includes('--input-format'));
    assert.ok(calls[0].args.includes('stream-json'));
    assert.ok(calls[0].args.includes('--model'));
    assert.ok(calls[0].args.includes('sonnet'));
    assert.ok(calls[0].args.includes('--effort'));
    assert.ok(calls[0].args.includes('max'));
    assert.ok(calls[0].args.includes('--session-id'));
    assert.equal(calls[0].options.cwd, root);
    assert.equal(result.applicationEvidence.session_id, '22222222-2222-4222-8222-222222222222');
    assert.equal(result.applicationEvidence.process_id, 24037);
    assert.equal(result.applicationEvidence.runtime_version, '2.1.277');
    assert.equal(result.applicationEvidence.stream_evidence.format, 'stream-json');
    assert.ok(fs.existsSync(result.applicationEvidence.transcript.path));
    assert.equal(result.applicationEvidence.transcript.bytes, Buffer.byteLength(stream('22222222-2222-4222-8222-222222222222')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing independent effort evidence refuses a successful process exit', async () => {
  const launch = createClaudeCliLauncher({
    scope: SCOPE,
    uuid: () => '33333333-3333-4333-8333-333333333333',
    spawn: () => childFor(JSON.stringify({ type: 'system', session_id: '33333333-3333-4333-8333-333333333333', model: 'sonnet' }) + '\n'),
  });
  await assert.rejects(
    () => launch('missing proof', { model: 'sonnet', effort: 'max' }),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISSING',
  );
});

test('probe accepts required CLI capabilities and authenticated status', () => {
  const calls = [];
  const result = probeClaudeRuntime({
    spawnSync: (command, args) => {
      calls.push([command, args]);
      if (args[0] === '--version') return { status: 0, stdout: '2.1.277\n', stderr: '' };
      if (args[0] === '--help') return { status: 0, stdout: '--model --effort --output-format stream-json --session-id', stderr: '' };
      return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' };
    },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.runtime_version, '2.1.277');
  assert.equal(result.auth_method, 'claude.ai');
  assert.equal(calls.length, 3);
});

test('probe reports unavailable without turning missing runtime into a receipt', () => {
  const result = probeClaudeRuntime({ spawnSync: () => ({ status: 1, stdout: '', stderr: 'not found' }) });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'runtime_missing');
});

test('controller-owned host binds scope and routes launch evidence', async () => {
  const ownerCalls = [];
  const controller = {
    assertOwner(runId) { ownerCalls.push(['assert', runId]); },
  };
  const host = createClaudeRuntimeHost({
    scope: SCOPE,
    probe: probe(),
    controller,
    recorder: { record() {} },
    uuid: () => '11111111-1111-4111-8111-111111111111',
    spawn: () => childFor(stream()),
    transcriptDir: null,
  });
  const result = await host.agent('scoped prompt', { model: 'sonnet', effort: 'max' });
  const evidence = host.applicationEvidence({ result });
  assert.equal(host.scope.run_id, SCOPE.run_id);
  assert.equal(host.scope.ticket, SCOPE.ticket);
  assert.equal(evidence.session_id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(ownerCalls, [['assert', SCOPE.run_id], ['assert', SCOPE.run_id]]);
});

test('unavailable probe is reported to the controller and refuses launch', () => {
  const unavailable = [];
  assert.throws(
    () => createClaudeRuntimeHost({
      scope: SCOPE,
      probe: { status: 'unavailable', reason: 'runtime_auth_unavailable' },
      controller: { markUnavailable(runId, input) { unavailable.push([runId, input.reason]); } },
      recorder: { record() {} },
    }),
    (error) => error.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0][0], SCOPE.run_id);
});

done();
