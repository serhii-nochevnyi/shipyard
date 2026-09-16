'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createClaudeWorkflowDispatch, CLAUDE_MODEL_ALIASES } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');

const WORKFLOW = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'workflows', 'investigation-research.mjs'
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = fs.readFileSync(WORKFLOW, 'utf8').replace(/^export const meta/m, 'const meta');

const capabilities = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.opus],
  supportedEfforts: ['medium'],
  observedModel: true,
  observedEffort: true,
});

const lines = [
  { id: 'system-state', label: 'system state', model: 'opus', effort: 'medium', signals: { type: 'facts' } },
  { id: 'alternatives', label: 'alternatives', model: 'opus', effort: 'medium', signals: { type: 'alternatives' } },
  { id: 'constraints', label: 'constraints', model: 'opus', effort: 'medium', signals: { type: 'facts' } },
  { id: 'risks', label: 'risks and unknowns', model: 'opus', effort: 'medium', signals: { type: 'facts' } },
];

suite('investigation-research.mjs — routed Claude research fan-out');

test('dispatches all four lines through the typed boundary and returns verified receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-investigation-research-'));
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  const calls = [];
  let launch = 0;
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    const result = {
      id: options.label.split(':').pop(),
      status: 'completed',
      summary: `${options.label} completed`,
      draft: `draft for ${options.label}`,
    };
    evidence.set(result, {
      launch_id: `investigation-research-${++launch}`,
      applied_model: options.model,
      applied_effort: options.effort,
      observed_model: options.model,
      observed_effort: options.effort,
    });
    return result;
  };
  const dispatch = (options) => createClaudeWorkflowDispatch({
    ...options,
    capabilities,
    recorder,
    applicationEvidence: ({ result }) => evidence.get(result),
  });
  const args = {
    invId: 'INV-001',
    invPath: '/repo/.planning/investigations/INV-001-runtime-ladder',
    problemStatement: 'Which runtime policy should govern research?',
    referencePath: '/plugin/references/inv-research.md',
    artifactLanguage: 'English',
    lines,
  };

  try {
    const value = await new AsyncFunction(
      'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source
    )(
      agent,
      async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      () => {},
      () => {},
      args,
      dispatch,
    );
    assert.equal(value.length, 4);
    assert.equal(calls.length, 4);
    for (const line of lines) {
      const result = value.find((item) => item.id === line.id);
      assert.ok(result, `missing result for ${line.id}`);
      assert.equal(result.status, 'completed');
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.receipt.applied_model, 'opus');
      assert.equal(result.receipt.applied_effort, 'medium');
      assert.ok(recorder.getVerifiedRecord(result.receipt.dispatch_id));
      const call = calls.find((item) => item.options.label.endsWith(`:${line.id}`));
      assert.ok(call, `missing host call for ${line.id}`);
      assert.equal(call.options.model, line.model);
      assert.equal(call.options.effort, line.effort);
      assert.match(call.prompt, new RegExp(`Research line: ${line.id}`));
      assert.match(call.prompt, /Rule zero:/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a malformed research response instead of normalizing it to completed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-investigation-research-invalid-'));
  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  const agent = async (_prompt, options) => {
    const result = { id: options.label.split(':').pop(), status: 'succeeded', summary: 'not a contract status' };
    evidence.set(result, {
      launch_id: `investigation-research-invalid-${options.label}`,
      applied_model: options.model,
      applied_effort: options.effort,
      observed_model: options.model,
      observed_effort: options.effort,
    });
    return result;
  };
  const dispatch = (options) => createClaudeWorkflowDispatch({
    ...options,
    capabilities,
    recorder,
    applicationEvidence: ({ result }) => evidence.get(result),
  });

  try {
    await assert.rejects(
      () => new AsyncFunction(
        'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source
      )(
        agent,
        async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
        () => {},
        () => {},
        {
          invId: 'INV-INVALID',
          invPath: '/inv',
          problemStatement: 'test',
          referencePath: '/ref',
          lines,
        },
        dispatch,
      ),
      (error) => error && error.code === 'INVALID_RESULT' && /status must be completed or blocked/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses before launch when the host bridge is absent', async () => {
  let launches = 0;
  await assert.rejects(
    () => new AsyncFunction(
      'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source
    )(
      async () => { launches++; },
      async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      () => {},
      () => {},
      { invId: 'INV-002', invPath: '/inv', problemStatement: 'test', referencePath: '/ref', lines },
      undefined,
    ),
    /dispatch boundary bridge is unavailable/
  );
  assert.equal(launches, 0);
});

test('contains no compatibility model reader or direct launch fallback', () => {
  assert.ok(source.includes('__createClaudeWorkflowDispatch'));
  assert.ok(source.includes('createClaudeWorkflowDispatch({'));
  assert.ok(!source.includes('pipeline-config.cjs model'));
  assert.ok(!source.includes('spawn_agent'));
});

done();
