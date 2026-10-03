'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
const capability = require('../../plugins/delivery-pipeline/scripts/model-capability.cjs');

test('model-axis escalation is runtime-local and recognizes Claude Fable ceiling', () => {
  const codex = policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals: { critical: true }, dispatch_id: 'codex-critical' });
  const claude = policy.resolveDispatch({ runtime: 'claude', role: 'arch-review', signals: { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, dispatch_id: 'claude-ceiling' });
  assert.deepEqual([codex.model, codex.effort], [policy.CODEX_MODEL_IDS.sol, 'high']);
  assert.deepEqual([claude.model, claude.effort], [policy.CLAUDE_MODEL_ALIASES.fable, 'medium']);
  assert.equal(claude.model, policy.CLAUDE_MODEL_ALIASES.fable);
  assert.equal(capability.isModelAxisEscalation(codex), false, 'Codex executor changes effort within its pinned Sol family');
  assert.equal(capability.isModelAxisEscalation(claude), true);
  assert.equal(capability.previousRung(claude).name, 'critical');
  assert.deepEqual(
    [capability.previousRung(claude).model_key, capability.previousRung(claude).effort],
    ['opus', 'high'],
  );
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
  const mismatchedPair = capability.evaluate(capability.snapshotFor({
    supportedModels: ['fable'],
    supportedEfforts: ['medium', 'high'],
    supportedSelections: [{ model: 'fable', effort: 'high' }],
    launch_id: 'host-launch-1-wrong-pair',
  }, resolution), resolution);
  assert.equal(mismatchedPair.state, 'unsupported', 'separately supported axes do not authorize an unsupported exact pair');
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
  assert.equal(fallback.effort, 'high');
});

test('repair model escalation needs a completed predecessor identity', () => {
  const resolution = {
    runtime: 'claude', role: 'ci-fix', rung: 'repeat_exhausted', rung_index: 2,
    model: policy.CLAUDE_MODEL_ALIASES.opus, effort: 'high',
    signals: { signatureState: 'repeat_exhausted' },
  };
  const snapshot = {
    schema_version: capability.SCHEMA_VERSION,
    runtime: 'claude',
    launch_id: 'host-repair-1',
    supported_models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
    supported_efforts: ['xhigh', 'high'],
    completed_attempt: true,
    completed_attempt_id: 'prior-1',
  };
  assert.equal(capability.evaluate(snapshot, resolution).state, 'supported');
  assert.equal(capability.evaluate({ ...snapshot, completed_attempt: false }, resolution).state, 'unknown');
});

test('deep repair fallback refuses without the fallback rung authenticated predecessor', () => {
  for (const runtime of ['codex', 'claude']) {
    const resolution = {
      runtime, role: 'ci-fix', rung: 'repeat_exhausted', rung_index: 2,
      dispatch_id: 'deep-repair',
      signals: {
        signatureState: 'repeat_exhausted',
        priorApplied: { dispatch_id: 'repeat-repair', compliance: 'verified' },
      },
    };
    assert.throws(() => capability.fallbackInput({}, resolution),
      (error) => error.code === 'UNSUPPORTED_REPAIR_FALLBACK');
  }
});
