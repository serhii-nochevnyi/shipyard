'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  createDurableRecorder,
} = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  CLAUDE_MODEL_ALIASES,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const {
  runClaudeWorkflow,
} = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');

const CAPABILITIES = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.sonnet],
  supportedEfforts: ['max'],
  observedModel: true,
  observedEffort: true,
});

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
        evidence.set(result, {
          launch_id: 'claude-workflow-host-test',
          applied_model: options.model,
          applied_effort: options.effort,
          observed_model: options.model,
          observed_effort: options.effort,
        });
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

done();
