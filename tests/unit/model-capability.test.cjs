'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
const capability = require('../../plugins/delivery-pipeline/scripts/model-capability.cjs');

test('model-axis escalation is runtime-local and recognizes Claude Fable ceiling', () => {
  const codex = policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals: { critical: true }, dispatch_id: 'codex-critical' });
  const claude = policy.resolveDispatch({ runtime: 'claude', role: 'arch-review', signals: { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, dispatch_id: 'claude-ceiling' });
  assert.equal(codex.model, policy.CODEX_MODEL_IDS.sol);
  assert.equal(claude.model, policy.CLAUDE_MODEL_ALIASES.fable);
  assert.equal(capability.isModelAxisEscalation(codex), true);
  assert.equal(capability.isModelAxisEscalation(claude), true);
  assert.equal(capability.previousRung(claude).name, 'critical');
});

test('supported capability evidence proves the exact model and effort pair', () => {
  const resolution = policy.resolveDispatch({ runtime: 'claude', role: 'arch-review', signals: { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, dispatch_id: 'launch-1' });
  const snapshot = capability.snapshotFor({
    supportedModels: ['claude-opus-5-5', 'fable'],
    supportedEfforts: ['medium', 'max'],
    supportedSelections: [{ model: 'fable', effort: 'medium' }],
    launch_id: 'host-launch-1',
  }, resolution);
  const got = capability.evaluate(snapshot, resolution);
  assert.equal(got.state, 'supported');
  assert.equal(got.snapshot.launch_id, 'host-launch-1');
});

test('unknown or unsupported capability falls back to the preceding policy rung', () => {
  const resolution = policy.resolveDispatch({ runtime: 'claude', role: 'arch-review', signals: { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, dispatch_id: 'launch-2' });
  assert.equal(capability.evaluate(null, resolution).state, 'unknown');
  assert.equal(capability.evaluate({
    schema_version: capability.SCHEMA_VERSION,
    runtime: 'claude',
    launch_id: 'host-launch-2',
    supported_models: ['claude-opus-5-5'],
    supported_efforts: ['max'],
  }, resolution).state, 'unsupported');
  const fallback = policy.resolveDispatch(capability.fallbackInput({ runtime: 'claude', role: 'arch-review' }, resolution));
  assert.equal(fallback.rung, 'critical');
  assert.equal(fallback.model, 'claude-opus-5-5');
  assert.equal(fallback.effort, 'max');
});

test('repair model escalation needs a completed predecessor identity', () => {
  const resolution = {
    runtime: 'codex', role: 'ci-fix', rung: 'repeat', rung_index: 1,
    model: policy.CODEX_MODEL_IDS.sol, effort: 'high',
    signals: { signatureState: 'repeat' },
  };
  const snapshot = {
    schema_version: capability.SCHEMA_VERSION,
    runtime: 'codex',
    launch_id: 'host-repair-1',
    supported_models: ['gpt-6-luna', 'gpt-6-sol'],
    supported_efforts: ['high', 'max'],
    completed_attempt: true,
    completed_attempt_id: 'prior-1',
  };
  assert.equal(capability.evaluate(snapshot, resolution).state, 'supported');
  assert.equal(capability.evaluate({ ...snapshot, completed_attempt: false }, resolution).state, 'unknown');
});

test('bounded fallback keeps the predecessor identity when falling from a deep repair rung', () => {
  const resolution = {
    runtime: 'codex', role: 'ci-fix', rung: 'repeat_exhausted', rung_index: 2,
    dispatch_id: 'deep-repair',
    signals: {
      signatureState: 'repeat_exhausted',
      priorApplied: { dispatch_id: 'repeat-repair', compliance: 'verified' },
    },
  };
  const input = capability.fallbackInput({}, resolution);
  assert.equal(input.previous_dispatch_id, 'repeat-repair');
  assert.equal(input.signals.signatureState, 'repeat');
});
