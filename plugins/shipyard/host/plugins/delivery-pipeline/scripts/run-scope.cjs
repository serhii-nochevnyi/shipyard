#!/usr/bin/env node
'use strict';

const contract = require('./run-contract.cjs');

function required(value, field) {
  if (value === undefined || value === null || value === '') {
    const error = new Error(`run-scope: ${field} is required`);
    error.code = 'MISSING_SCOPE';
    throw error;
  }
  return value;
}

function createRepositoryIdentity(input) {
  return contract.normalizeRepositoryIdentity(input);
}

function createPhaseIdentity(input) {
  return contract.normalizePhaseIdentity(input);
}

function createTicketIdentity(input, options) {
  return contract.normalizeTicketIdentity(input, options);
}

function createWorktreeIdentity(input) {
  return contract.normalizeWorktreeIdentity(input);
}

function createRuntimeIdentity(input, provider) {
  return contract.normalizeRuntimeIdentity(input, provider);
}

function createDispatchIdentity(input) {
  return contract.normalizeDispatchIdentity(input);
}

function createLeaseIdentity(input, runId, revision) {
  return contract.normalizeLeaseIdentity(input, runId, revision);
}

function createStateRevision(input) {
  return contract.normalizeRevisionIdentity(input);
}

function createCheckpointIdentity(input, runId, revision) {
  return contract.normalizeCheckpointIdentity(input, runId, revision);
}

function createWakeIdentity(input, runId, revision) {
  return contract.normalizeWakeIdentity(input, runId, revision);
}

function createReceiptIdentity(input) {
  return contract.normalizeReceiptIdentity(input);
}

function createRunScope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('run-scope: scope options must be an object');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  contract.rejectSerializedAuthority(input, 'run');
  const run_id = input.run_id || input.runId || contract.id('run');
  const repository = createRepositoryIdentity(input.repository || {
    repository_id: required(input.repository_id, 'repository_id'),
    worktree: required(input.worktree, 'worktree'),
  });
  const phase = createPhaseIdentity(required(input.phase, 'phase'));
  const worktree = createWorktreeIdentity(required(input.worktree || repository.worktree, 'worktree'));
  const runtime = createRuntimeIdentity(required(input.runtime, 'runtime'), input.provider);
  const state_revision = createStateRevision(input.state_revision === undefined ? 0 : input.state_revision);
  const dispatchInput = input.dispatch || {};
  const dispatch = createDispatchIdentity({
    ...dispatchInput,
    runtime: runtime.runtime,
    provider: runtime.provider,
  });
  const ticket = createTicketIdentity(required(input.ticket, 'ticket'), { role: dispatch.role, phase: phase.phase });
  const lease = createLeaseIdentity(input.lease || {
    lease_id: contract.id('lease'),
    owner_id: required(input.owner_id || input.ownerId, 'owner_id'),
  }, run_id, state_revision.value);
  return contract.normalizeRunContract({
    schema: contract.SCHEMA,
    version: contract.VERSION,
    run_id,
    repository,
    phase,
    ticket,
    worktree,
    runtime,
    dispatch,
    lease,
    state_revision,
    state: input.state || 'created',
    wait_kind: input.wait_kind || null,
    checkpoint: input.checkpoint || null,
    wake: input.wake || null,
  });
}

module.exports = Object.freeze({
  SCHEMA: contract.SCHEMA,
  VERSION: contract.VERSION,
  createRepositoryIdentity,
  createPhaseIdentity,
  createTicketIdentity,
  createWorktreeIdentity,
  createRuntimeIdentity,
  createDispatchIdentity,
  createLeaseIdentity,
  createStateRevision,
  createCheckpointIdentity,
  createWakeIdentity,
  createReceiptIdentity,
  createRunScope,
  validateRunScope: contract.normalizeRunContract,
  createHostAuthority: contract.createHostAuthority,
  assertHostAuthority: contract.assertHostAuthority,
  applyEvent: contract.applyEvent,
});
