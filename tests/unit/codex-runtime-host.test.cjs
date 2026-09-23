'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const {
  EFFORTS,
  createCodexCliLauncher,
  createCodexRuntimeHost,
  observedSelection,
  parseCodexStream,
  probeCodexRuntime,
} = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const { launchAgent } = require('../../plugins/delivery-pipeline/scripts/codex-agent.cjs');

const SCOPE = {
  run_id: 'run-37-04',
  ticket: 'T-37-04',
  phase: 37,
  worktree: '/tmp/shipyard-t3704',
  runtime: 'codex',
  provider: 'openai',
};

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
  supportedEfforts: EFFORTS,
  observedModel: true,
  observedEffort: true,
};

function stream(session = '11111111-1111-4111-8111-111111111111') {
  return [
    { type: 'thread.started', thread_id: session },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function childFor(output, code = 0, pid = 24037, input = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(value) { input.push(String(value)); },
    end() {},
  };
  child.pid = pid;
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  });
  return child;
}

function probe() {
  return {
    schema: 'shipyard.codex-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable: 'codex',
    runtime_version: '0.155.1',
    capabilities,
  };
}

function staticContent(resolution = { model: 'gpt-6-sol', effort: 'high' }) {
  return [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
    '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "research"',
    '# shipyard-policy-rung = "base"',
    'name = "shipyard-inv-research"',
    'model = "' + resolution.model + '"',
    'model_reasoning_effort = "' + resolution.effort + '"',
    'sandbox_mode = "read-only"',
    "developer_instructions = '''",
    'Follow the scoped research contract.',
    "'''",
    '',
  ].join('\n');
}

suite('codex-runtime-host — native launch and independent evidence');

test('parses thread and completed-turn evidence', () => {
  const parsed = parseCodexStream(stream());
  assert.equal(parsed.session_id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(observedSelection(parsed, 'gpt-6-luna', 'max', {
    model: 'gpt-6-luna', effort: 'max',
  }), {
    model: 'gpt-6-luna',
    effort: 'max',
    source: 'codex-exec-explicit-selection',
  });
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.usage_records, 1);
});

test('Codex launcher passes explicit model and reasoning effort to exec', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-runtime-'));
  const calls = [];
  const input = [];
  try {
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root },
      capabilities,
      transcriptDir: path.join(root, 'transcripts'),
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        return childFor(stream('22222222-2222-4222-8222-222222222222'), 0, 24038, input);
      },
    });
    const result = await launch('run the scoped task', {
      model: 'gpt-6-luna',
      effort: 'max',
      dispatch_id: 'dispatch-codex-1',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'codex');
    assert.deepEqual(calls[0].args.slice(0, 2), ['exec', '--json']);
    assert.ok(calls[0].args.includes('--model'));
    assert.ok(calls[0].args.includes('gpt-6-luna'));
    assert.ok(calls[0].args.includes('--config'));
    assert.ok(calls[0].args.includes('model_reasoning_effort="max"'));
    assert.ok(calls[0].args.includes('--cd'));
    assert.equal(calls[0].options.cwd, root);
    assert.equal(input.join(''), 'run the scoped task');
    assert.equal(result.session_id, '22222222-2222-4222-8222-222222222222');
    assert.equal(result.process_id, 24038);
    assert.equal(result.runtime_evidence.dispatch_id, 'dispatch-codex-1');
    assert.equal(result.runtime_evidence.stream_evidence.format, 'jsonl');
    assert.ok(fs.existsSync(result.runtime_evidence.transcript.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('static launcher consumes the immutable generated instructions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-static-'));
  const input = [];
  try {
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root },
      capabilities,
      transcriptDir: null,
      spawn: (_executable, args) => {
        assert.ok(args.includes('--model'));
        return childFor(stream('33333333-3333-4333-8333-333333333333'), 0, 24039, input);
      },
    });
    const content = staticContent();
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    await launch('ticket contract', {
      model: 'gpt-6-sol',
      effort: 'high',
      agent_file: 'shipyard-inv-research.toml',
      agent_file_digest: digest,
      agent_file_content: content,
      dispatch_id: 'dispatch-static-1',
    });
    assert.ok(input.join('').startsWith('Follow the scoped research contract.'));
    await assert.rejects(
      () => launch('ticket contract', {
        model: 'gpt-6-sol',
        effort: 'high',
        agent_file: 'shipyard-inv-research.toml',
        agent_file_digest: '0'.repeat(64),
        agent_file_content: content,
        dispatch_id: 'dispatch-static-2',
      }),
      (error) => error.code === 'STALE_GENERATED_AGENT',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller-owned host binds run identity and returns process evidence', async () => {
  const ownerCalls = [];
  const controller = {
    assertOwner(runId) { ownerCalls.push(runId); },
  };
  const host = createCodexRuntimeHost({
    scope: SCOPE,
    probe: probe(),
    controller,
    recorder: () => true,
    spawn: () => childFor(stream(), 0, 24040),
    transcriptDir: null,
  });
  const result = await host.launch(
    { model: 'gpt-6-luna', reasoning_effort: 'max' },
    { run_id: SCOPE.run_id, dispatch_id: 'dispatch-host-1', prompt: 'scoped prompt' },
  );
  assert.equal(host.scope.run_id, SCOPE.run_id);
  assert.equal(result.runtime_evidence.run_id, SCOPE.run_id);
  assert.equal(result.runtime_evidence.provider, 'openai');
  assert.equal(result.observed_model, 'gpt-6-luna');
  assert.equal(result.observed_effort, 'max');
  assert.deepEqual(ownerCalls, [SCOPE.run_id, SCOPE.run_id, SCOPE.run_id]);
});

test('host reports unavailable capability without fabricating a receipt', () => {
  const unavailable = [];
  assert.throws(
    () => createCodexRuntimeHost({
      scope: SCOPE,
      probe: { status: 'unavailable', reason: 'runtime_missing' },
      controller: { markUnavailable(runId, input) { unavailable.push([runId, input.reason]); } },
      recorder: () => true,
    }),
    (error) => error.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0][0], SCOPE.run_id);
});

test('probe requires the real CLI surface and explicit host capability evidence', () => {
  const calls = [];
  const result = probeCodexRuntime({
    capabilities,
    spawnSync: (command, args) => {
      calls.push([command, args]);
      if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.155.1\n', stderr: '' };
      return { status: 0, stdout: '--json --model --config --cd', stderr: '' };
    },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.runtime_version, 'codex-cli 0.155.1');
  assert.deepEqual(calls, [['codex', ['--version']], ['codex', ['exec', '--help']]]);
  const missing = probeCodexRuntime({
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'not found' }),
  });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'capability_evidence_missing');
});

test('launchAgent sends dynamic selection through the adapter boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-agent-launch-'));
  try {
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}));
    const host = {
      capabilities,
      recorder: () => true,
      launch(selection, context) {
        return {
          launch_id: 'host-launch-1',
          applied_model: selection.model,
          applied_effort: selection.reasoning_effort,
          observed_model: selection.model,
          observed_effort: selection.reasoning_effort,
          context_dispatch_id: context.dispatch_id,
        };
      },
    };
    const result = launchAgent('executor', {
      cwd: root,
      capabilities,
      host,
      dispatch_id: 'dispatch-agent-1',
      context: { prompt: 'execute the scoped ticket' },
    });
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.applied_model, 'gpt-6-luna');
    assert.equal(result.receipt.applied_effort, 'max');
    assert.equal(result.receipt.launch_id, 'host-launch-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done();
