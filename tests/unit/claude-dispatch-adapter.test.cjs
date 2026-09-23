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

test('native Fable model IDs remain comparable to the rolling alias', () => {
  const adapter = createClaudeDispatchAdapter({ capabilities, host: {} });
  assert.equal(adapter.matchesObservation('observed_model', 'claude-fable-5-1', 'fable'), true);
  assert.equal(adapter.matchesObservation('observed_model', 'fable', 'fable'), false);
  assert.equal(adapter.matchesObservation('observed_model', 'sonnet', 'sonnet'), false);
});

test('preserves applied selection and exact-session model evidence in the durable receipt', () => {
  const host = {
    capabilities,
    launch(selection) {
      const sessionId = '44444444-4444-4444-8444-444444444444';
      const transcript = { path: '/tmp/claude-session.jsonl', bytes: 120, sha256: 'b'.repeat(64) };
      return {
        launch_id: 'claude-launch-37-03',
        session_id: sessionId,
        process_id: 44003,
        runtime_version: '2.1.277',
        applied_model: selection.model,
        applied_effort: selection.effort,
        observed_model: 'claude-sonnet-5',
        observed_effort: selection.effort,
        transcript: { path: '/tmp/claude-transcript.jsonl', bytes: 81, sha256: 'a'.repeat(64) },
        selection_evidence: {
          source: 'claude-session-assistant-transcript',
          session_id: sessionId,
          assistant_records: 2,
          model: 'claude-sonnet-5',
          effort: selection.effort,
          transcript,
        },
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
  assert.equal(result.receipt.applied_model, 'sonnet');
  assert.equal(result.receipt.observed_model, 'claude-sonnet-5');
  assert.equal(result.receipt.selection_evidence.assistant_records, 2);
  assert.equal(result.receipt.selection_evidence.transcript.sha256, 'b'.repeat(64));
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
        const sessionId = '55555555-5555-4555-8555-555555555555';
        const observedModel = 'claude-sonnet-5';
        return {
          launch_id: 'claude-launch-bad-stream',
          session_id: sessionId,
          applied_model: selection.model,
          applied_effort: selection.effort,
          observed_model: observedModel,
          observed_effort: selection.effort,
          selection_evidence: {
            source: 'claude-session-assistant-transcript',
            session_id: sessionId,
            assistant_records: 1,
            model: observedModel,
            effort: selection.effort,
            transcript: { path: '/tmp/claude-session.jsonl', bytes: 1, sha256: 'c'.repeat(64) },
          },
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

test('refuses an observed selection without exact-session transcript evidence', () => {
  let recorded = 0;
  const adapter = createClaudeDispatchAdapter({
    capabilities,
    host: {
      capabilities,
      launch(selection) {
        return {
          launch_id: 'claude-launch-without-transcript-proof',
          applied_model: selection.model,
          applied_effort: selection.effort,
          observed_model: selection.model,
          observed_effort: selection.effort,
        };
      },
    },
  });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder: () => { recorded += 1; return true; } });
  assert.throws(
    () => boundary.dispatch({ runtime: 'claude', role: 'executor' }, { ticket: 'T-38-02' }),
    (error) => error.code === 'MISSING_RECEIPT',
  );
  assert.equal(recorded, 0);
});

test('a host without exact model and effort observation cannot launch or record success', () => {
  let launches = 0;
  let recorded = 0;
  const unavailable = { ...capabilities, observedModel: false, observedEffort: false };
  const adapter = createClaudeDispatchAdapter({
    capabilities: unavailable,
    host: {
      capabilities: unavailable,
      launch() { launches += 1; return {}; },
    },
  });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder: () => { recorded += 1; return true; } });
  assert.throws(
    () => boundary.dispatch({ runtime: 'claude', role: 'executor' }, { ticket: 'T-38-02' }),
    (error) => error.code === 'UNSUPPORTED_SELECTION',
  );
  assert.equal(launches, 0);
  assert.equal(recorded, 0);
});

test('a transcript evidence reference cannot attest another model or session', () => {
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const adapter = createClaudeDispatchAdapter({
    capabilities,
    host: {
      capabilities,
      launch(selection) {
        return {
          launch_id: 'claude-launch-mismatched-evidence',
          session_id: sessionId,
          applied_model: selection.model,
          applied_effort: selection.effort,
          observed_model: 'claude-sonnet-5',
          observed_effort: selection.effort,
          selection_evidence: {
            source: 'claude-session-assistant-transcript',
            session_id: sessionId,
            assistant_records: 1,
            model: 'claude-opus-5-5',
            effort: selection.effort,
            transcript: { path: '/tmp/claude-session.jsonl', bytes: 1, sha256: 'd'.repeat(64) },
          },
        };
      },
    },
  });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder: () => true });
  assert.throws(
    () => boundary.dispatch({ runtime: 'claude', role: 'executor' }, { ticket: 'T-38-02' }),
    (error) => error.code === 'MISSING_RECEIPT',
  );
});

test('the pinned Opus 5.5 selection refuses an older transcript model ID', () => {
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const adapter = createClaudeDispatchAdapter({
    capabilities,
    host: {
      capabilities,
      launch(selection) {
        return {
          launch_id: 'claude-launch-old-opus',
          session_id: sessionId,
          applied_model: selection.model,
          applied_effort: selection.effort,
          observed_model: 'claude-opus-5',
          observed_effort: selection.effort,
          selection_evidence: {
            source: 'claude-session-assistant-transcript',
            session_id: sessionId,
            assistant_records: 1,
            model: 'claude-opus-5',
            effort: selection.effort,
            transcript: { path: '/tmp/claude-session.jsonl', bytes: 1, sha256: 'e'.repeat(64) },
          },
        };
      },
    },
  });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder: () => true });
  assert.throws(
    () => boundary.dispatch({ runtime: 'claude', role: 'executor', signals: { critical: true } }, { ticket: 'T-38-02' }),
    (error) => error.code === 'NONCOMPLIANT_RECEIPT',
  );
});

done();
