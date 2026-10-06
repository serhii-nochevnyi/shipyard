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

test('integrator accepts only the canonical phase subject as its run ticket', () => {
  const subject = 'phase=38-runtime-model-ladder-recovery;repository=/tmp/shipyard/.git;tickets=' + 'a'.repeat(64);
  const run = makeScope({
    phase: 38,
    ticket: subject,
    dispatch: { dispatch_id: 'dispatch-integrator', role: 'integrator', model: 'gpt-6.1-sol', effort: 'high' },
  });
  assert.equal(run.ticket.ticket, subject);
  assert.equal(contract.normalizeRunContract(run).ticket.ticket, subject);
  assert.throws(() => makeScope({ ticket: subject }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => scope.createTicketIdentity(subject), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => scope.createTicketIdentity(subject, { role: 'integrator', phase: 37 }),
    (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => makeScope({
    phase: 37,
    ticket: subject,
    dispatch: { dispatch_id: 'dispatch-integrator', role: 'integrator', model: 'gpt-6.1-sol', effort: 'high' },
  }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => makeScope({
    phase: 38,
    ticket: 'phase=38-runtime-model-ladder-recovery;repository=/tmp/shipyard/.git;tickets=bad',
    dispatch: { dispatch_id: 'dispatch-integrator', role: 'integrator', model: 'gpt-6.1-sol', effort: 'high' },
  }), (error) => error.code === 'INVALID_INPUT');
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

test('planning identities are scoped to their parsed role and decomposition phase', () => {
  const adr = 'phase=47;input=ADR-025-runtime;repository=shipyard/test';
  const inv = 'phase=47;input=INV-014-runtime;repository=shipyard/test';
  for (const ticket of [adr, inv]) {
    const run = makeScope({ phase: 47, ticket,
      dispatch: { dispatch_id: 'planning', role: 'decomposition', model: 'sol', effort: 'high' } });
    assert.equal(contract.normalizeRunContract(run).ticket.ticket, ticket);
    assert.throws(() => contract.normalizeRunContract({ ...run, phase: { phase: 48 } }), { code: 'INVALID_INPUT' });
    assert.throws(() => contract.normalizeRunContract({ ...run,
      repository: { ...run.repository, repository_id: 'foreign/repository' } }), { code: 'SCOPE_MISMATCH' });
    for (const role of ['executor', 'integrator', 'research']) {
      assert.throws(() => makeScope({ phase: 47, ticket,
        dispatch: { dispatch_id: 'wrong-role', role, model: 'sol', effort: 'high' } }), { code: 'INVALID_INPUT' });
    }
  }
  for (const role of ['research', 'decomposition']) {
    const run = makeScope({ ticket: 'INV-014-runtime',
      dispatch: { dispatch_id: 'investigation', role, model: 'sol', effort: 'high' } });
    assert.equal(contract.normalizeRunContract(run).ticket.ticket, 'INV-014-runtime');
  }
  for (const ticket of ['INV-014-runtime', 'ADR-025-runtime']) {
    for (const role of ['executor', 'integrator']) {
      assert.throws(() => makeScope({ ticket,
        dispatch: { dispatch_id: 'execution', role, model: 'sol', effort: 'high' } }), { code: 'INVALID_INPUT' });
    }
  }
  // An ADR id alone carries no accepted packet/phase binding.
  assert.throws(() => scope.createTicketIdentity('ADR-025-runtime', { role: 'decomposition', phase: 47 }),
    { code: 'INVALID_INPUT' });
  for (const ticket of [adr.replace('ADR-025-runtime', 'ADR-'), adr.replace('phase=47', 'phase=0'),
    adr.replace('repository=shipyard/test', 'repository='), adr + ';authority=host']) {
    assert.throws(() => scope.createTicketIdentity(ticket, { role: 'decomposition', phase: 47 }),
      { code: 'INVALID_INPUT' });
  }
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

// @contract: Synthetic historical metadata does not authenticate runtime execution.
const historicalHash = '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968';
test('recorded Sol preserves its native identity and independently checks concrete model', () => {
  const input = { ...makeScope().dispatch, model_key: 'sol', model: 'gpt-6-sol', policy_version: 'adr-014.v6', policy_hash: historicalHash };
  assert.deepEqual(contract.normalizeDispatchIdentity(input), input);
  assert.throws(() => contract.normalizeDispatchIdentity({ ...input, model: 'gpt-6-luna' }), { code: 'RUNTIME_MODEL_MISMATCH' });
});

const currentPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const runtimeAdapters = require('../../plugins/delivery-pipeline/scripts/runtime-adapters.cjs');
const fixturePalettes = {
  'adr-014.v6': { codex: { sol: 'gpt-6-sol', luna: 'gpt-6-luna', astra: 'gpt-6-astra' }, claude: { sonnet: 'sonnet', opus: 'claude-opus-5-5', fable: 'fable' } },
  'adr-014.v7': { codex: { sol: 'gpt-6.1-sol', luna: 'gpt-6-luna', astra: 'gpt-6-astra' }, claude: { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'fable' } },
};
test('synthetic recorded palette matrix preserves dispatches and receipts, while history stays stale', () => {
  for (const [version, runtimes] of Object.entries(fixturePalettes)) {
    for (const [runtime, palette] of Object.entries(runtimes)) {
      for (const [key, model] of Object.entries(palette)) {
        const input = { dispatch_id: 'fixture', role: 'executor', runtime, model_key: key, model, policy_version: version, policy_hash: version.endsWith('v6') ? historicalHash : currentPolicy.POLICY_HASH };
        const output = contract.normalizeDispatchIdentity(input);
        assert.equal(output.model, model);
        assert.equal(output.model_key, key);
        assert.deepEqual(contract.normalizeDispatchIdentity(output), output);
        assert.ok(Object.isFrozen(output));
        assert.ok(Object.isFrozen(runtimeAdapters.recordedPalette(version, runtime)));
        const receipt = contract.normalizeReceiptIdentity({ ...input, receipt_id: 'fixture-receipt', run_id: 'fixture-run', requested_model: model, applied_model: model, observed_model: model, status: 'verified', usage_status: 'joined' });
        assert.equal(receipt.observed_model, model);
        assert.equal(receipt.policy_hash, input.policy_hash);
        assert.deepEqual(contract.normalizeReceiptIdentity(receipt), receipt);
        if (version.endsWith('v6')) {
          const resolution = currentPolicy.resolveDispatch({ runtime, role: 'executor', signals: {} });
          assert.throws(() => currentPolicy.validateResolution({ ...resolution, model, model_key: key, policy_version: version, policy_hash: historicalHash }), { code: 'STALE_POLICY' });
        }
      }
    }
  }
  assert.equal(currentPolicy.POLICY_VERSION, 'adr-014.v7');
  assert.equal(runtimeAdapters.matchesModelObservation('claude', 'sonnet', 'claude-sonnet-5-5'), false);
  assert.equal(runtimeAdapters.matchesModelObservation('claude', 'claude-fable-1', 'fable'), true);
  assert.equal(contract.normalizeDispatchIdentity({ dispatch_id: 'fresh', runtime: 'codex', role: 'executor', model: 'sol' }).model, 'gpt-6.1-sol');
});
test('recorded metadata and independently supplied identities fail closed', () => {
  const base = { ...makeScope().dispatch, model_key: 'sol', model: 'gpt-6.1-sol' };
  const cases = [
    [{ model: 'gpt-6-luna' }, 'RUNTIME_MODEL_MISMATCH'],
    [{ model: 'sonnet' }, 'RUNTIME_MODEL_MISMATCH'],
    [{ model_key: 'opus' }, 'RUNTIME_MODEL_MISMATCH'],
    [{ model: '' }, 'UNSUPPORTED_MODEL'],
    [{ model_key: '' }, 'UNSUPPORTED_MODEL'],
    [{ model: 'missing' }, 'UNSUPPORTED_MODEL'],
    [{ model_key: 'missing' }, 'UNSUPPORTED_MODEL'],
    [{ model: 'gpt-6-sol' }, 'RUNTIME_MODEL_MISMATCH'],
    [{ policy_version: 'unknown' }, 'UNSUPPORTED_POLICY_VERSION'],
    [{ policy_version: undefined }, 'MISSING_POLICY_IDENTITY'],
    [{ policy_hash: undefined }, 'MISSING_POLICY_IDENTITY'],
    [{ policy_version: null }, 'MISSING_POLICY_IDENTITY'],
    [{ policy_hash: '' }, 'MISSING_POLICY_IDENTITY'],
    [{ policyVersion: 'adr-014.v6' }, 'POLICY_IDENTITY_CONFLICT'],
    [{ policyHash: historicalHash }, 'POLICY_IDENTITY_CONFLICT'],
  ];
  for (const [patch, code] of cases) assert.throws(() => contract.normalizeDispatchIdentity({ ...base, ...patch }), { code });
  for (const patch of [{ policy_hash: historicalHash }, { policy_version: 'adr-014.v6' }]) {
    assert.throws(() => contract.normalizeDispatchIdentity({ dispatch_id: 'fresh', role: 'executor', runtime: 'codex', ...patch }), { code: 'MISSING_POLICY_IDENTITY' });
  }
  const run = JSON.parse(JSON.stringify(makeScope()));
  delete run.dispatch.schema;
  delete run.dispatch.policy_hash;
  assert.throws(() => contract.normalizeRunContract(run), { code: 'MISSING_POLICY_IDENTITY' });
  for (const [patch, code] of [[{ runtime: 'claude' }, 'RUNTIME_MODEL_MISMATCH'], [{ provider: 'anthropic' }, 'RUNTIME_PROVIDER_MISMATCH'], [{ runtime: 'unknown' }, 'UNSUPPORTED_RUNTIME']]) {
    assert.throws(() => contract.normalizeRunContract({ ...makeScope(), dispatch: { ...base, ...patch } }), { code });
  }
  for (const [runtime, old] of [['codex', 'gpt-6-sol'], ['claude', 'sonnet']]) {
    assert.throws(() => contract.normalizeReceiptIdentity({ ...base, runtime, provider: undefined, receipt_id: 'r', run_id: 'r', observed_model: old }), { code: 'RUNTIME_MODEL_MISMATCH' });
  }
});

test('serialized concrete-only dispatch cannot silently turn a symbolic alias into native evidence', () => {
  const input = { ...makeScope().dispatch, model: 'sol' };
  delete input.model_key;
  assert.throws(() => contract.normalizeDispatchIdentity(input), { code: 'UNSUPPORTED_MODEL' });
  delete input.schema;
  assert.equal(contract.normalizeDispatchIdentity(input).model, 'gpt-6.1-sol');
});

 test('authoritative policy pairs reject crossed and arbitrary hashes across dispatch and receipts', () => {
  for (const [version, hash, model] of [['adr-014.v6', historicalHash, 'gpt-6-sol'], ['adr-014.v7', currentPolicy.POLICY_HASH, 'gpt-6.1-sol']]) {
    const base = { ...makeScope().dispatch, model_key: 'sol', model, policy_version: version, policy_hash: hash };
    for (const invalid of [version.endsWith('v6') ? currentPolicy.POLICY_HASH : historicalHash, 'a'.repeat(64)]) {
      assert.throws(() => contract.normalizeDispatchIdentity({ ...base, policy_hash: invalid }), { code: 'POLICY_IDENTITY_CONFLICT' });
      assert.throws(() => contract.normalizeReceiptIdentity({ ...base, receipt_id: 'r', run_id: 'r', requested_model: model, policy_hash: invalid }), { code: 'POLICY_IDENTITY_CONFLICT' });
    }
  }
  assert.equal(currentPolicy.POLICY_HASH, '3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570');
});
test('serialized requested models require recorded native values while fresh Sonnet aliases remain supported', () => {
  const serialized = {
    schema: 'shipyard.receipt.v1', version: 1,
    receipt_id: 'serialized-sonnet', run_id: 'r', dispatch_id: 'd',
    runtime: 'claude', provider: 'anthropic',
    policy_version: currentPolicy.POLICY_VERSION, policy_hash: currentPolicy.POLICY_HASH,
    requested_model: 'sonnet', applied_model: 'claude-sonnet-5-5', observed_model: 'claude-sonnet-5-5',
    status: 'verified', usage_status: 'joined',
  };
  assert.throws(() => contract.normalizeReceiptIdentity(serialized), { code: 'RUNTIME_MODEL_MISMATCH' });
  const fresh = { ...serialized }; delete fresh.schema;
  assert.equal(scope.createReceiptIdentity(fresh).requested_model, 'claude-sonnet-5-5');
  const historical = {
    ...serialized, policy_version: 'adr-014.v6', policy_hash: historicalHash,
    applied_model: 'sonnet', observed_model: 'sonnet',
  };
  const preserved = contract.normalizeReceiptIdentity(historical);
  for (const field of ['requested_model', 'applied_model', 'observed_model', 'policy_version', 'policy_hash', 'status', 'usage_status']) {
    assert.equal(preserved[field], historical[field]);
  }
  assert.deepEqual(contract.normalizeReceiptIdentity(preserved), preserved);
});

test('fresh receipt constructors default current identity and serialized receipts require it', () => {
  for (const runtime of ['codex', 'claude']) {
    const fresh = { receipt_id: 'fresh', run_id: 'r', dispatch_id: 'd', runtime, requested_model: runtime === 'codex' ? 'sol' : 'sonnet' };
    const receipt = scope.createReceiptIdentity(fresh);
    assert.equal(receipt.policy_hash, currentPolicy.POLICY_HASH);
    assert.equal(receipt.policy_version, currentPolicy.POLICY_VERSION);
    for (const field of ['policy_hash', 'policy_version']) {
      const serialized = { ...receipt }; delete serialized[field];
      assert.throws(() => contract.normalizeReceiptIdentity(serialized), { code: 'MISSING_POLICY_IDENTITY' });
    }
  }
});
