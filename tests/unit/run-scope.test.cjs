'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const scope = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');

test('constructs the scoped identity components with stable schemas', () => {
  const repository = scope.createRepositoryIdentity({ repository_id: 'shipyard/test', worktree: '/tmp/worktree' });
  const phase = scope.createPhaseIdentity('37');
  const ticket = scope.createTicketIdentity('T-37-01');
  const worktree = scope.createWorktreeIdentity('/tmp/worktree');
  const runtime = scope.createRuntimeIdentity('claude');
  const dispatch = scope.createDispatchIdentity({ dispatch_id: 'd', role: 'executor', runtime: 'claude', model: 'sonnet', effort: 'max' });
  const lease = scope.createLeaseIdentity({ lease_id: 'l', owner_id: 'o' }, 'r', 0);
  const revision = scope.createStateRevision(0);
  const checkpoint = scope.createCheckpointIdentity({ checkpoint_id: 'c', run_id: 'r', state_revision: 0, kind: 'resume' }, 'r', 0);
  const wake = scope.createWakeIdentity({ wake_id: 'w', run_id: 'r', state_revision: 0, kind: 'ci', due_at: 1000 }, 'r', 0);
  const receipt = scope.createReceiptIdentity({
    receipt_id: 'receipt', run_id: 'r', dispatch_id: 'd', runtime: 'claude',
    requested_model: 'opus', requested_effort: 'max', status: 'unknown', usage_status: 'pending',
  });
  assert.deepEqual(repository, { schema: 'shipyard.repository.v1', version: 1, repository_id: 'shipyard/test', worktree: '/tmp/worktree' });
  assert.equal(phase.phase, 37);
  assert.equal(ticket.ticket, 'T-37-01');
  assert.equal(worktree.path, '/tmp/worktree');
  assert.deepEqual(runtime, { schema: 'shipyard.runtime.v1', version: 1, runtime: 'claude', provider: 'anthropic' });
  assert.equal(dispatch.model, 'sonnet');
  assert.equal(lease.run_id, 'r');
  assert.equal(revision.value, 0);
  assert.equal(checkpoint.run_id, 'r');
  assert.equal(wake.kind, 'ci');
  assert.equal(receipt.provider, 'anthropic');
  for (const value of [repository, phase, ticket, worktree, runtime, dispatch, lease, revision, checkpoint, wake, receipt]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('creates a complete run scope and refuses inconsistent nested identities', () => {
  const run = scope.createRunScope({
    run_id: 'run-1', repository_id: 'shipyard/test', phase: 37, ticket: 'T-37-01',
    worktree: '/tmp/worktree', runtime: 'claude', owner_id: 'owner-1',
    dispatch: { dispatch_id: 'dispatch-1', role: 'executor', model: 'sonnet', effort: 'max' },
  });
  assert.equal(run.repository.repository_id, 'shipyard/test');
  assert.equal(run.phase.phase, 37);
  assert.equal(run.ticket.ticket, 'T-37-01');
  assert.equal(run.lease.run_id, 'run-1');
  assert.equal(run.state_revision.value, 0);
  assert.throws(
    () => scope.createRunScope({
      run_id: 'run-1', repository: { repository_id: 'shipyard/test', worktree: '/tmp/other' },
      phase: 37, ticket: 'T-37-01', worktree: '/tmp/worktree', runtime: 'claude', owner_id: 'owner-1',
      dispatch: { dispatch_id: 'dispatch-1', role: 'executor', model: 'sonnet' },
    }),
    (error) => error.code === 'SCOPE_MISMATCH',
  );
});

test('rejects inherited or serialized authority fields at every identity boundary', () => {
  assert.throws(
    () => scope.createDispatchIdentity({ dispatch_id: 'd', role: 'executor', runtime: 'codex', model: 'luna', inherited_model: 'opus' }),
    (error) => error.code === 'SERIALIZED_AUTHORITY',
  );
  assert.throws(
    () => scope.createRunScope({
      repository_id: 'shipyard/test', phase: 37, ticket: 'T-37-01', worktree: '/tmp/worktree', runtime: 'codex', owner_id: 'owner',
      authority: { run_id: 'run' }, dispatch: { dispatch_id: 'd', role: 'executor', model: 'luna' },
    }),
    (error) => error.code === 'SERIALIZED_AUTHORITY',
  );
});

test('receipt validation preserves unsupported and unknown as explicit evidence', () => {
  const unsupported = scope.createReceiptIdentity({
    receipt_id: 'r-1', run_id: 'run-1', dispatch_id: 'd-1', runtime: 'codex',
    requested_model: 'luna', applied_model: 'unsupported', observed_model: 'unknown',
    requested_effort: 'max', applied_effort: 'unsupported', observed_effort: 'unknown',
    status: 'unsupported', usage_status: 'unavailable',
  });
  assert.equal(unsupported.applied_model, 'unsupported');
  assert.equal(unsupported.observed_model, 'unknown');
  assert.equal(unsupported.usage_status, 'unavailable');
  assert.throws(
    () => scope.createReceiptIdentity({
      receipt_id: 'r-2', run_id: 'run-1', dispatch_id: 'd-1', runtime: 'codex', requested_model: 'opus',
    }),
    (error) => error.code === 'RUNTIME_MODEL_MISMATCH',
  );
});
