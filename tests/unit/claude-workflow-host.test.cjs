'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');
const {
  createDurableRecorder,
} = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  CLAUDE_MODEL_ALIASES,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const { createClaudeCliLauncher } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
const { capture: captureSessionStart } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
const {
  runClaudeWorkflow,
} = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');
const {
  INVESTIGATION_RESEARCH_SCRIPT,
  registerInvestigationWorkflowHost,
  runInvestigationResearch,
} = require('../../plugins/delivery-pipeline/scripts/claude-investigation-host.cjs');

const CAPABILITIES = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.sonnet],
  supportedEfforts: ['max'],
  observedModel: true,
  observedEffort: true,
});

const OPUS_CAPABILITIES = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.opus],
  supportedEfforts: ['medium'],
  observedModel: true,
  observedEffort: true,
});

function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

const ROOT = path.resolve(__dirname, '..', '..');
const EXECUTOR_STREAM = 'tests/fixtures/captured/claude-stream-executor.jsonl';
const REPLAY_SESSION = '33333333-3333-4333-8333-333333333333';

function capturedLines(rel) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((line) => line.trim());
  assert.ok(JSON.parse(lines[0]).shipyard_fixture, `${rel} must start with a provenance line`);
  return lines.slice(1);
}

function replayChild(rel, transform) {
  const lines = capturedLines(rel);
  const placeholder = JSON.parse(lines[0]).session_id;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.pid = 24039;
  process.nextTick(() => {
    for (const line of lines) {
      const record = transform(JSON.parse(line.split(placeholder).join(REPLAY_SESSION)));
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(record)}\n`));
    }
    child.emit('close', 0, null);
  });
  return child;
}

function withoutStructuredOutput(record) {
  if (!Object.hasOwn(record, 'structured_output')) return record;
  const { structured_output: _dropped, ...rest } = record;
  return rest;
}

async function replayedHostResult(options, transform = (record) => record) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-replay-'));
  const projects = path.join(root, 'projects');
  const transcript = path.join(projects, 'project-a', `${REPLAY_SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant', sessionId: REPLAY_SESSION, effort: options.effort,
    message: { role: 'assistant', model: 'claude-sonnet-5' },
  })}\n`);
  try {
    const launch = createClaudeCliLauncher({
      scope: { run_id: 'run-40-08', ticket: 'T-40-08', phase: 40, worktree: root, runtime: 'claude', provider: 'anthropic' },
      transcriptDir: null,
      sessionTranscriptRoot: projects,
      transcriptPollMs: 5,
      uuid: () => REPLAY_SESSION,
      spawn: (_executable, args) => {
        const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
        const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
        const value = (name) => hookArgs[hookArgs.indexOf(name) + 1];
        captureSessionStart({
          hook_event_name: 'SessionStart', source: 'startup', session_id: value('--expected-session'),
          transcript_path: transcript, cwd: settings.sandbox.filesystem.allowWrite[0],
        }, { evidenceFile: value('--evidence-file'), expectedSession: value('--expected-session') });
        return replayChild(EXECUTOR_STREAM, transform);
      },
    });
    const { applicationEvidence: _evidence, ...result } = await launch('host-bound prompt', { model: options.model, effort: options.effort });
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

suite('claude-workflow-host — production sixth binding');

test('binds the real workflow bridge with host-owned receipt services', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-host-'));
  const scriptPath = path.join(root, 'workflow.mjs');
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  fs.writeFileSync(scriptPath, `
export const meta = { name: 'host-test' }
phase('Host test')
return await parallel([async () => {
  const dispatched = await __createClaudeWorkflowDispatch({
    agent,
    prompt: 'host-bound prompt',
    role: 'executor',
    model: 'sonnet',
    effort: 'max',
    context: { ticket: 'T-36-host-test' },
  })
  return { id: 'T-36-host-test', receipt: dispatched.receipt }
}])
`);
  let calls = 0;
  try {
    const value = await runClaudeWorkflow({
      scriptPath,
      args: { claudeCapabilities: { supportedModels: ['fable'] } },
      agent: async (prompt, options) => {
        calls++;
        const result = {};
        evidence.set(result, transcriptEvidence({
          launch_id: 'claude-workflow-host-test',
          applied_model: options.model,
          applied_effort: options.effort,
          observed_model: options.model,
          observed_effort: options.effort,
        }));
        return result;
      },
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      capabilities: CAPABILITIES,
      recorder,
      applicationEvidence: ({ result }) => evidence.get(result),
    });
    assert.equal(calls, 1);
    assert.equal(value[0].receipt.compliance, 'verified');
    assert.equal(value[0].receipt.applied_model, 'sonnet');
    assert.equal(value[0].receipt.applied_effort, 'max');
    assert.ok(recorder.getVerifiedRecord(value[0].receipt.dispatch_id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function workflowResultFor(hostResult) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-output-'));
  const scriptPath = path.join(root, 'workflow.mjs');
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  fs.writeFileSync(scriptPath, `
export const meta = { name: 'output-test' }
const dispatched = await __createClaudeWorkflowDispatch({
  agent,
  prompt: 'host-bound prompt',
  role: 'executor',
  model: 'sonnet',
  effort: 'max',
  context: { ticket: 'T-39-12' },
})
return dispatched.result
`);
  try {
    return await runClaudeWorkflow({
      scriptPath,
      args: {},
      agent: async (_prompt, options) => {
        const result = await hostResult(options);
        evidence.set(result, transcriptEvidence({
          launch_id: 'claude-workflow-output-test',
          applied_model: options.model,
          applied_effort: options.effort,
          observed_model: options.model,
          observed_effort: options.effort,
        }));
        return result;
      },
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      capabilities: CAPABILITIES,
      recorder,
      applicationEvidence: ({ result }) => evidence.get(result),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a structured host output reaches the workflow as the agent result', async () => {
  const captured = JSON.parse(capturedLines(EXECUTOR_STREAM).at(-1)).structured_output;
  const result = await workflowResultFor((options) => replayedHostResult(options));
  assert.deepEqual(result, captured);
  assert.equal(result.status, 'committed');
});

test('a text host output keeps the host result unchanged', async () => {
  const captured = JSON.parse(capturedLines(EXECUTOR_STREAM).at(-1)).result;
  const result = await workflowResultFor((options) => replayedHostResult(options, withoutStructuredOutput));
  assert.equal(result.status, 'completed');
  assert.equal(result.output, captured);
});

test('production investigation entry point pins the research workflow and runs all four lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-investigation-host-'));
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  const calls = [];
  const lines = ['system-state', 'alternatives', 'constraints', 'risks'].map((id) => ({
    id,
    label: {
      'system-state': 'system state',
      alternatives: 'alternatives',
      constraints: 'constraints',
      risks: 'risks and unknowns',
    }[id],
    model: 'claude-opus-5-5',
    effort: 'medium',
    signals: id === 'alternatives' ? { type: 'alternatives' } : { type: 'facts' },
  }));
  try {
    const args = {
        invId: 'INV-HOST',
        invPath: '/repo/.planning/investigations/INV-HOST',
        problemStatement: 'Test the production research entry point',
        referencePath: '/plugin/references/inv-research.md',
        artifactLanguage: 'English',
        lines,
      };
    const value = await registerInvestigationWorkflowHost({
      agent: async (_prompt, options) => {
        calls.push(options);
        const result = {
          id: options.label.split(':').pop(),
          status: 'completed',
          summary: `completed ${options.label}`,
          draft: `draft ${options.label}`,
        };
        evidence.set(result, transcriptEvidence({
          launch_id: `investigation-host-${calls.length}`,
          applied_model: options.model,
          applied_effort: options.effort,
          observed_model: options.model,
          observed_effort: options.effort,
        }));
        return result;
      },
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      capabilities: OPUS_CAPABILITIES,
      recorder,
      applicationEvidence: ({ result }) => evidence.get(result),
    }).run(args);
    assert.match(INVESTIGATION_RESEARCH_SCRIPT, /workflows[\\/]investigation-research\.mjs$/);
    assert.equal(value.length, 4);
    assert.equal(calls.length, 4);
    for (const item of value) {
      assert.equal(item.receipt.compliance, 'verified');
      assert.equal(item.receipt.applied_model, 'claude-opus-5-5');
      assert.equal(item.receipt.applied_effort, 'medium');
      assert.ok(recorder.getVerifiedRecord(item.receipt.dispatch_id));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production investigation entry point refuses a caller-supplied script', async () => {
  assert.throws(
    () => runInvestigationResearch({ scriptPath: '/tmp/not-the-research-workflow.mjs' }),
    /scriptPath is fixed to the research workflow/
  );
});

test('investigation CLI refuses caller-supplied host modules', () => {
  const scriptPath = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/claude-investigation-host.cjs');
  const result = spawnSync(process.execPath, [scriptPath, '--args-file', '/tmp/args.json', '--host-module', '/tmp/host.cjs'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--request-file <json> is required/);
});

test('refuses before evaluating a workflow when the host bridge is incomplete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-host-'));
  const scriptPath = path.join(root, 'workflow.mjs');
  fs.writeFileSync(scriptPath, 'return []\n');
  let launches = 0;
  try {
    await assert.rejects(
      () => runClaudeWorkflow({
        scriptPath,
        agent: async () => { launches++; },
        parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
        capabilities: CAPABILITIES,
      }),
      /durable receipt recorder is required/
    );
    assert.equal(launches, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routes a named GSD callback through the host-owned typed resource', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-typed-host-'));
  const scriptPath = path.join(root, 'workflow.mjs');
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  fs.writeFileSync(scriptPath, `
export const meta = { name: 'typed-host-test' }
return await __createClaudeWorkflowDispatch({
  agent,
  prompt: 'typed GSD prompt',
  role: 'decomposition',
  model: 'claude-opus-5-5',
  effort: 'medium',
  gsdRole: 'gsd-planner',
  context: { ticket: 'T-36-typed-host-test' },
})
`);
  let genericCalls = 0;
  let typedCalls = 0;
  try {
    const value = await runClaudeWorkflow({
      scriptPath,
      agent: async () => {
        genericCalls++;
        throw new Error('generic callback must not run for a typed GSD dispatch');
      },
      typedGsdCallback: async (prompt, options, gsdRole) => {
        typedCalls++;
        return transcriptEvidence({
          prompt,
          launch_id: 'typed-host-launch',
          applied_model: options.model,
          applied_effort: options.effort,
          observed_model: options.model,
          observed_effort: options.effort,
          gsd_role: gsdRole,
          gsd_launch_mechanism: options.gsd_launch_mechanism,
        });
      },
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      capabilities: OPUS_CAPABILITIES,
      recorder,
      applicationEvidence: ({ result }) => result,
    });
    assert.equal(typedCalls, 1);
    assert.equal(genericCalls, 0);
    assert.equal(value.receipt.gsd_role, 'gsd-planner');
    assert.equal(value.receipt.gsd_launch_mechanism, 'typed-gsd-callback');
    assert.equal(value.receipt.applied_model, 'claude-opus-5-5');
    assert.equal(value.receipt.applied_effort, 'medium');
    assert.ok(recorder.getVerifiedRecord(value.receipt.dispatch_id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a typed GSD dispatch without host-owned role and mechanism evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-typed-evidence-'));
  const scriptPath = path.join(root, 'workflow.mjs');
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  fs.writeFileSync(scriptPath, `
export const meta = { name: 'typed-evidence-test' }
return await __createClaudeWorkflowDispatch({
  agent,
  prompt: 'typed GSD prompt',
  role: 'decomposition',
  model: 'claude-opus-5-5',
  effort: 'medium',
  gsdRole: 'gsd-planner',
  context: { ticket: 'T-36-typed-evidence-test' },
})
`);
  let typedCalls = 0;
  try {
    await assert.rejects(
      () => runClaudeWorkflow({
        scriptPath,
        agent: async () => { throw new Error('generic callback must not run'); },
        typedGsdCallback: async (prompt, options, gsdRole) => {
          typedCalls++;
          const evidence = transcriptEvidence({
            prompt,
            launch_id: 'typed-evidence-launch',
            applied_model: options.model,
            applied_effort: options.effort,
            observed_model: options.model,
            observed_effort: options.effort,
            gsd_role: gsdRole,
            gsd_launch_mechanism: options.gsd_launch_mechanism,
          });
          delete evidence.gsd_agent_evidence;
          return evidence;
        },
        parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
        capabilities: OPUS_CAPABILITIES,
        recorder,
        applicationEvidence: ({ result }) => result,
      }),
      /host application evidence must attest gsd-planner through typed-gsd-callback/
    );
    assert.equal(typedCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a frozen structural recorder lookalike before workflow evaluation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-workflow-lookalike-'));
  const scriptPath = path.join(root, 'workflow.mjs');
  fs.writeFileSync(scriptPath, 'return []\n');
  const lookalike = Object.freeze({
    reserve() {},
    record() {},
    getReceipt() { return null; },
    getVerifiedRecord() { return null; },
  });
  try {
    await assert.rejects(
      () => runClaudeWorkflow({
        scriptPath,
        agent: async () => {},
        parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
        capabilities: CAPABILITIES,
        recorder: lookalike,
        applicationEvidence: () => ({}),
      }),
      /frozen durable receipt recorder is required/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done();
