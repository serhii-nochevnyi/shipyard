'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const scope = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const contract = require('../../plugins/delivery-pipeline/scripts/run-contract.cjs');

function makeScope(extra = {}) {
  return scope.createRunScope({
    run_id: 'run-test-01',
    repository_id: 'shipyard/test',
    phase: 37,
    ticket: 'T-37-01',
    worktree: '/tmp/shipyard-test-worktree',
    runtime: 'codex',
    owner_id: 'owner-test',
    dispatch: { dispatch_id: 'dispatch-test', role: 'executor', model: 'luna', effort: 'max' },
    ...extra,
  });
}

test('creates a frozen scoped contract with provider-pure model evidence', () => {
  const run = makeScope();
  assert.equal(run.schema, 'shipyard.run.v1');
  assert.equal(run.runtime.runtime, 'codex');
  assert.equal(run.runtime.provider, 'openai');
  assert.equal(run.dispatch.model, 'gpt-6-luna');
  assert.equal(run.dispatch.model_key, 'luna');
  assert.ok(Object.isFrozen(run));
  assert.ok(Object.isFrozen(run.repository));
  assert.ok(Object.isFrozen(run.dispatch));
  assert.ok(Object.isFrozen(run.state_revision));
});

test('requires the complete scope before constructing a run', () => {
  assert.throws(
    () => scope.createRunScope({ phase: 37, ticket: 'T-37-01', runtime: 'codex' }),
    (error) => error.code === 'MISSING_SCOPE',
  );
  assert.throws(
    () => scope.createRunScope({
      repository_id: 'shipyard/test', phase: 37, ticket: 'T-37-01',
      worktree: 'relative/path', runtime: 'codex', owner_id: 'owner-test',
      dispatch: { dispatch_id: 'd', role: 'executor', model: 'luna', effort: 'max' },
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('rejects a provider or model from the other runtime', () => {
  assert.throws(
    () => scope.createRuntimeIdentity({ runtime: 'claude', provider: 'openai' }),
    (error) => error.code === 'RUNTIME_PROVIDER_MISMATCH',
  );
  assert.throws(
    () => scope.createDispatchIdentity({ dispatch_id: 'd', role: 'executor', runtime: 'claude', provider: 'anthropic', model: 'gpt-6-luna' }),
    (error) => error.code === 'RUNTIME_MODEL_MISMATCH',
  );
  assert.throws(
    () => scope.createDispatchIdentity({ dispatch_id: 'd', role: 'executor', runtime: 'codex', provider: 'openai', model: 'opus' }),
    (error) => error.code === 'RUNTIME_MODEL_MISMATCH',
  );
});

test('applies a state transition only with a live host authority', () => {
  const run = makeScope();
  const authority = scope.createHostAuthority({ run_id: run.run_id, owner_id: run.lease.owner_id });
  const result = scope.applyEvent(run, {
    event_id: 'event-start', effect_id: 'effect-start', expected_revision: 0, to: 'running',
  }, authority);
  assert.equal(result.applied, true);
  assert.equal(result.contract.state, 'running');
  assert.equal(result.contract.state_revision.value, 1);
  assert.equal(JSON.stringify(authority).includes('token'), false);
  assert.throws(
    () => scope.applyEvent(run, { event_id: 'event-forged', expected_revision: 0, to: 'running' }, JSON.parse(JSON.stringify(authority))),
    (error) => error.code === 'SERIALIZED_AUTHORITY',
  );
});

test('rejects a stale revision before a second effect can run', () => {
  const run = makeScope();
  const authority = scope.createHostAuthority({ run_id: run.run_id, owner_id: run.lease.owner_id });
  const first = scope.applyEvent(run, { event_id: 'event-start', expected_revision: 0, to: 'running' }, authority).contract;
  assert.throws(
    () => scope.applyEvent(first, { event_id: 'event-wait', expected_revision: 0, to: 'waiting', wait_kind: 'ci' }, authority),
    (error) => error.code === 'STALE_REVISION',
  );
});

test('replays the same event or effect idempotently without advancing revision', () => {
  const run = makeScope();
  const authority = scope.createHostAuthority({ run_id: run.run_id, owner_id: run.lease.owner_id });
  const event = { event_id: 'event-start', effect_id: 'effect-start', expected_revision: 0, to: 'running' };
  const first = scope.applyEvent(run, event, authority);
  const replay = scope.applyEvent(first.contract, event, authority);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.contract.state_revision.value, 1);
  const effectReplay = scope.applyEvent(first.contract, {
    event_id: 'event-retry', effect_id: 'effect-start', expected_revision: 0, to: 'running',
  }, authority);
  assert.equal(effectReplay.reason, 'duplicate-effect');
  assert.throws(
    () => scope.applyEvent(first.contract, {
      event_id: 'event-start', effect_id: 'effect-other', expected_revision: 0, to: 'failed',
    }, authority),
    (error) => error.code === 'DUPLICATE_EVENT',
  );
});

test('terminal states cannot be reopened', () => {
  const run = makeScope();
  const authority = scope.createHostAuthority({ run_id: run.run_id, owner_id: run.lease.owner_id });
  const running = scope.applyEvent(run, { event_id: 'start', expected_revision: 0, to: 'running' }, authority).contract;
  const completed = scope.applyEvent(running, { event_id: 'finish', expected_revision: 1, to: 'completed' }, authority).contract;
  assert.throws(
    () => scope.applyEvent(completed, { event_id: 'restart', expected_revision: 2, to: 'running' }, authority),
    (error) => error.code === 'INVALID_TRANSITION',
  );
});

test('checkpoint transitions survive canonical revalidation with an absent digest', () => {
  const run = makeScope();
  const authority = scope.createHostAuthority({ run_id: run.run_id, owner_id: run.lease.owner_id });
  const running = scope.applyEvent(run, { event_id: 'start-checkpoint', expected_revision: 0, to: 'running' }, authority).contract;
  const checkpointed = scope.applyEvent(running, {
    event_id: 'checkpoint', expected_revision: 1, to: 'human_checkpoint', checkpoint_id: 'checkpoint-1',
  }, authority).contract;
  assert.equal(checkpointed.state, 'human_checkpoint');
  assert.equal(checkpointed.checkpoint.digest, null);
});
