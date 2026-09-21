'use strict';

const { suite, test, done, assert } = require('./assert-harness.cjs');
const { createDispatchBoundary } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  CLAUDE_MODEL_ALIASES,
  createClaudeDispatchAdapter,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');

const capabilities = Object.freeze({
  supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  observedModel: true,
  observedEffort: true,
});

suite('Claude dispatch adapter — native runtime evidence');

test('preserves independent session, process, stream and transcript evidence in the durable receipt', () => {
  const host = {
    capabilities,
    launch(selection) {
      return {
        launch_id: 'claude-launch-37-03',
        session_id: '44444444-4444-4444-8444-444444444444',
        process_id: 44003,
        runtime_version: '2.1.277',
        applied_model: selection.model,
        applied_effort: selection.effort,
        observed_model: selection.model,
        observed_effort: selection.effort,
        transcript: { path: '/tmp/claude-transcript.jsonl', bytes: 81, sha256: 'a'.repeat(64) },
        stream_evidence: { format: 'stream-json', records: 3, assistant_messages: 1, usage_records: 1 },
      };
    },
  };
  const adapter = createClaudeDispatchAdapter({ capabilities, host });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder: () => true });
  const result = boundary.dispatch({ runtime: 'claude', role: 'executor' }, {
    ticket: 'T-37-03', run_id: 'run-37-03', phase: 37,
  });
  assert.equal(result.receipt.session_id, '44444444-4444-4444-8444-444444444444');
  assert.equal(result.receipt.process_id, 44003);
  assert.equal(result.receipt.runtime_version, '2.1.277');
  assert.equal(result.receipt.stream_evidence.format, 'stream-json');
  assert.equal(result.receipt.transcript.sha256, 'a'.repeat(64));
  assert.equal(result.receipt.compliance, 'verified');
});

test('rejects malformed independent stream evidence before recording a compliant receipt', () => {
  const calls = [];
  const adapter = createClaudeDispatchAdapter({
    capabilities,
    host: {
      capabilities,
      launch(selection) {
        calls.push(selection);
        return {
          launch_id: 'claude-launch-bad-stream',
          applied_model: selection.model,
          applied_effort: selection.effort,
          observed_model: selection.model,
          observed_effort: selection.effort,
          stream_evidence: { format: 'text', records: 0 },
        };
      },
    },
  });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder: () => true });
  assert.throws(
    () => boundary.dispatch({ runtime: 'claude', role: 'executor' }, { ticket: 'T-37-03' }),
    (error) => error.code === 'MISSING_RECEIPT',
  );
  assert.equal(calls.length, 1);
});

done();
