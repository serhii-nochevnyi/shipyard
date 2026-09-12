'use strict';

const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');

function receiptFor(resolution, extra = {}) {
  return {
    runtime: resolution.runtime,
    dispatch_id: resolution.dispatch_id,
    launch_id: `launch-${resolution.dispatch_id}`,
    ...(resolution.agent_file ? { agent_file: resolution.agent_file } : {}),
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: resolution.model,
    applied_effort: resolution.effort,
    observed_model: resolution.model,
    observed_effort: resolution.effort,
    policy_hash: resolution.policy_hash,
    ...extra,
  };
}

function fakeAdapter({ receipt = receiptFor, extra = {}, onLaunch, ...options } = {}) {
  return {
    ...options,
    launch(resolution, context) {
      if (onLaunch) onLaunch(resolution, context);
      return receipt(resolution, extra);
    },
  };
}

suite('mandatory resolve → validate → launch → receipt boundary');

test('dynamic Codex execution receives explicit model and reasoning effort and returns an immutable trace', () => {
  const calls = [];
  const recorded = [];
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({ onLaunch: (resolution, context) => calls.push({ resolution, context }) }),
    },
    recorder: (trace) => recorded.push(trace),
  });
  const result = boundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-36-01' });
  assert.equal(calls.length, 1);
  assert.deepStrictEqual(calls[0].resolution.launch_arguments, {
    model: 'gpt-5.6-luna',
    reasoning_effort: 'max',
  });
  assert.deepStrictEqual(calls[0].context, { ticket: 'T-36-01' });
  assert.equal(result.requested_model, 'gpt-5.6-luna');
  assert.equal(result.applied_model, 'gpt-5.6-luna');
  assert.equal(result.observed_effort, 'max');
  assert.deepStrictEqual(result.trace.map((step) => step.stage), ['resolve', 'validate', 'launch', 'receipt', 'record']);
  assert.equal(result.trace.at(-1).status, 'passed');
  assert.equal(recorded.length, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.resolution));
  assert.ok(Object.isFrozen(result.receipt));
  assert.ok(Object.isFrozen(result.trace));
});

test('static Codex roles pass the resolver-selected generated file to the adapter', () => {
  let launched;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({ onLaunch: (resolution) => { launched = resolution; } }),
    },
  });
  const result = boundary.dispatch({
    runtime: 'codex',
    role: 'research',
    signals: { type: 'alternatives' },
  });
  assert.equal(launched.agent_file, 'shipyard-inv-research-alternatives.toml');
  assert.equal(result.receipt.agent_file, launched.agent_file);
  assert.equal(launched.launch_arguments, undefined);
});

test('Claude launches use the existing palette alias with an explicit effort', () => {
  let launched;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      claude: fakeAdapter({ onLaunch: (resolution) => { launched = resolution; } }),
    },
  });
  const result = boundary.dispatch({
    runtime: 'claude',
    role: 'integrator',
    signals: { contested: true },
  });
  assert.deepStrictEqual(launched.launch_arguments, { model: 'fable', effort: 'medium' });
  assert.equal(result.applied_model, 'fable');
  assert.equal(result.receipt.policy_hash, policy.POLICY_HASH);
});

test('validation hooks can reject an unsupported selection before launch', () => {
  let launched = false;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        supports: () => ({ valid: false, reason: 'model unavailable on this host' }),
        onLaunch: () => { launched = true; },
      }),
    },
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor' }),
    (error) => error.code === 'UNSUPPORTED_SELECTION' && /unavailable/.test(error.message),
  );
  assert.equal(launched, false);
});

test('missing adapters fail closed before any launch', () => {
  let launched = false;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: { launch: () => { launched = true; } } },
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'claude', role: 'executor' }),
    (error) => error.code === 'MISSING_ADAPTER' && /inherited session|CLI default/.test(error.message),
  );
  assert.equal(launched, false);
});

test('missing receipt fails closed and does not record a phantom dispatch', () => {
  let records = 0;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: { launch: () => undefined } },
    recorder: () => { records++; },
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor' }),
    (error) => error.code === 'MISSING_RECEIPT' && /application receipt/.test(error.message),
  );
  assert.equal(records, 0);
});

test('requested values copied without adapter-applied evidence are not a receipt', () => {
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: {
        launch: (resolution) => ({
          runtime: resolution.runtime,
          dispatch_id: resolution.dispatch_id,
          launch_id: 'copy-only',
          requested_model: resolution.model,
          requested_effort: resolution.effort,
          observed_model: resolution.model,
          observed_effort: resolution.effort,
          policy_hash: resolution.policy_hash,
        }),
      },
    },
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor' }),
    (error) => error.code === 'MISSING_RECEIPT' && /applied_model/.test(error.message),
  );
});

test('receipt contradictions, stale policy, and wrong agent file are rejected', () => {
  const cases = [
    [
      { applied_model: 'gpt-5.6-sol' },
      'NONCOMPLIANT_RECEIPT',
    ],
    [
      { policy_hash: 'stale-policy' },
      'STALE_POLICY',
    ],
    [
      { agent_file: 'shipyard-other.toml' },
      'NONCOMPLIANT_RECEIPT',
    ],
    [
      { observed_effort: 'low' },
      'NONCOMPLIANT_RECEIPT',
    ],
  ];
  for (const [extra, code] of cases) {
    const boundary = boundaryModule.createDispatchBoundary({
      adapters: {
        codex: fakeAdapter({
          extra,
        }),
      },
    });
    assert.throws(
      () => boundary.dispatch({ runtime: 'codex', role: 'research' }),
      (error) => error.code === code,
      JSON.stringify(extra),
    );
  }
});

test('a runtime that cannot expose observations may say so, but applied values remain mandatory', () => {
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        observationUnavailable: true,
        receipt: (resolution) => ({
          runtime: resolution.runtime,
          dispatch_id: resolution.dispatch_id,
          launch_id: 'unobserved',
          requested_model: resolution.model,
          requested_effort: resolution.effort,
          applied_model: resolution.model,
          applied_effort: resolution.effort,
          policy_hash: resolution.policy_hash,
        }),
      }),
    },
  });
  const result = boundary.dispatch({ runtime: 'codex', role: 'executor' });
  assert.equal(result.observed_model, 'unknown');
  assert.equal(result.observed_effort, 'unknown');
});

test('inline, inherited, stale, and malformed resolutions cannot bypass validation', () => {
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor', override: { inline: true } }),
    (error) => error.code === 'UNSUPPORTED_SELECTION',
  );
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor', override: { inherit: true } }),
    (error) => error.code === 'UNSUPPORTED_SELECTION',
  );
  const stale = { ...policy.resolveDispatch({ runtime: 'codex', role: 'executor', dispatch_id: 'stale' }), policy_hash: 'stale' };
  assert.throws(
    () => boundary.validate(stale),
    (error) => error.code === 'STALE_POLICY',
  );
});

test('standalone receipt verification and injected recorder are available as boundary primitives', () => {
  const resolution = policy.resolveDispatch({ runtime: 'codex', role: 'executor', dispatch_id: 'dispatch-primitive' });
  const receipt = receiptFor(resolution);
  const verified = boundaryModule.verifyApplicationReceipt(resolution, receipt);
  assert.equal(verified.applied_model, 'gpt-5.6-luna');
  assert.ok(Object.isFrozen(verified));
  assert.throws(
    () => boundaryModule.verifyApplicationReceipt(resolution, { ...receipt, observed_model: 'other' }),
    (error) => error.code === 'NONCOMPLIANT_RECEIPT',
  );
  const direct = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
  });
  assert.equal(direct.validate(resolution), true);
});

done();
