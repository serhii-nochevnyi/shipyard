'use strict';

const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');

function receiptFor(resolution, extra = {}) {
  return {
    receipt_type: 'adr-014.application',
    runtime: resolution.runtime,
    role: resolution.role,
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
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: `launch-${resolution.dispatch_id}`,
    },
    ...(resolution.agent_file ? { agent_file_digest: resolution.agent_file_digest } : {}),
    ...extra,
  };
}

function fakeAdapter({ receipt = receiptFor, extra = {}, onLaunch, validateGeneratedAgent, ...options } = {}) {
  return {
    ...options,
    ...(validateGeneratedAgent ? { validateGeneratedAgent } : {
      validateGeneratedAgent: (resolution) => ({
        valid: true,
        exists: true,
        content_verified: true,
        policy_hash: resolution.policy_hash,
        agent_file: resolution.agent_file,
        agent_file_digest: 'a'.repeat(64),
      }),
    }),
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
    recorder: (trace) => {
      recorded.push(trace);
      return true;
    },
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
  assert.deepStrictEqual(result.trace.map((step) => step.stage), ['resolve', 'validate', 'launch', 'record', 'receipt']);
  assert.equal(result.trace.at(-1).status, 'passed');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].receipt.compliance, undefined);
  assert.equal(result.receipt.compliance, 'verified');
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
    recorder: () => true,
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
    recorder: () => true,
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
    recorder: () => true,
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

test('durable recording requires affirmative acknowledgement before repair provenance exists', () => {
  let launchedReceipt;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        receipt: (resolution) => {
          launchedReceipt = receiptFor(resolution);
          return launchedReceipt;
        },
      }),
    },
    recorder: () => undefined,
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'ci-fix', signals: { signatureState: 'first' } }),
    (error) => error.code === 'RECORD_FAILED' && /affirmative/.test(error.message),
  );
  assert.throws(
    () => boundary.dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: launchedReceipt },
      previous_dispatch_id: launchedReceipt.dispatch_id,
    }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('a caller cannot replay a reserved dispatch id', () => {
  let launches = 0;
  let records = 0;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({ onLaunch: () => { launches++; } }),
    },
    recorder: () => {
      records++;
      return true;
    },
  });
  const input = { runtime: 'codex', role: 'executor', dispatch_id: 'dispatch-replay' };
  const first = boundary.dispatch(input);
  assert.equal(first.dispatch_id, 'dispatch-replay');
  assert.throws(
    () => boundary.dispatch(input),
    (error) => error.code === 'DUPLICATE_DISPATCH_ID' && /replay/.test(error.message),
  );
  assert.equal(launches, 1);
  assert.equal(records, 1);
});

test('repair escalations require the boundary receipt chain and consume each predecessor once', () => {
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: () => true,
  });
  const base = boundary.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
  });
  const repeat = boundary.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
    previous_dispatch_id: base.dispatch_id,
  });
  assert.equal(base.applied_model, 'gpt-5.6-luna');
  assert.equal(repeat.applied_model, 'gpt-5.6-sol');
  assert.throws(
    () => boundary.dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: base.receipt },
      previous_dispatch_id: base.dispatch_id,
    }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
  const exhausted = boundary.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat_exhausted', priorApplied: repeat.receipt },
    previous_dispatch_id: repeat.dispatch_id,
  });
  assert.equal(exhausted.applied_model, 'gpt-6-astra');
  assert.equal(exhausted.applied_effort, 'medium');
});

test('production dispatch refuses to launch without durable recording', () => {
  let launched = false;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter({ onLaunch: () => { launched = true; } }) },
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor' }),
    (error) => error.code === 'RECORD_UNAVAILABLE',
  );
  assert.equal(launched, false);
});

test('custom policies and raw launch paths are unavailable', () => {
  assert.throws(
    () => boundaryModule.createDispatchBoundary({ policy: { ...policy } }),
    (error) => error.code === 'NONCANONICAL_POLICY',
  );
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: () => true,
  });
  const resolution = boundary.resolve({ runtime: 'codex', role: 'executor' });
  assert.equal(boundary.launch, undefined);
  assert.equal(boundaryModule.launchDispatch, undefined);
  assert.ok(resolution);
});

test('the boundary keeps using the canonical policy if an exported method is replaced', () => {
  const originalResolve = policy.resolveDispatch;
  const originalValidate = policy.validateResolution;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: () => true,
  });
  let replacementCalled = false;
  try {
    policy.resolveDispatch = () => {
      replacementCalled = true;
      return { runtime: 'codex', role: 'executor', model: 'caller-model' };
    };
    policy.validateResolution = () => true;
  } catch (error) {
    // The canonical export is frozen; this is the expected protection.
  }
  const result = boundary.dispatch({ runtime: 'codex', role: 'executor' });
  assert.equal(replacementCalled, false);
  assert.equal(result.applied_model, 'gpt-5.6-luna');
  assert.equal(policy.resolveDispatch, originalResolve);
  assert.equal(policy.validateResolution, originalValidate);
});

test('static Codex dispatch requires generated-agent evidence and a digest', () => {
  const missing = boundaryModule.createDispatchBoundary({
    adapters: { codex: { launch: () => receiptFor(policy.resolveDispatch({ runtime: 'codex', role: 'research' })) } },
    recorder: () => true,
  });
  assert.throws(
    () => missing.dispatch({ runtime: 'codex', role: 'research' }),
    (error) => error.code === 'STALE_GENERATED_AGENT',
  );
  const stale = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        validateGeneratedAgent: (resolution) => ({
          valid: true,
          exists: true,
          content_verified: false,
          policy_hash: resolution.policy_hash,
          agent_file: resolution.agent_file,
          agent_file_digest: 'b'.repeat(64),
        }),
      }),
    },
    recorder: () => true,
  });
  assert.throws(
    () => stale.dispatch({ runtime: 'codex', role: 'research' }),
    (error) => error.code === 'STALE_GENERATED_AGENT',
  );
});

test('requested values copied without adapter-applied evidence are not a receipt', () => {
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: {
        launch: (resolution) => ({
          receipt_type: 'adr-014.application',
          runtime: resolution.runtime,
          role: resolution.role,
          dispatch_id: resolution.dispatch_id,
          launch_id: 'copy-only',
          requested_model: resolution.model,
          requested_effort: resolution.effort,
          observed_model: resolution.model,
          observed_effort: resolution.effort,
          policy_hash: resolution.policy_hash,
          compliance: 'verified',
          compliance_proof: {
            status: 'verified',
            boundary: 'adr-014.dispatch-boundary',
            policy_hash: resolution.policy_hash,
            dispatch_id: resolution.dispatch_id,
            launch_id: 'copy-only',
          },
        }),
      },
    },
    recorder: () => true,
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
      recorder: () => true,
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
          receipt_type: 'adr-014.application',
          runtime: resolution.runtime,
          role: resolution.role,
          dispatch_id: resolution.dispatch_id,
          launch_id: 'unobserved',
          requested_model: resolution.model,
          requested_effort: resolution.effort,
          applied_model: resolution.model,
          applied_effort: resolution.effort,
          policy_hash: resolution.policy_hash,
          compliance: 'verified',
          compliance_proof: {
            status: 'verified',
            boundary: 'adr-014.dispatch-boundary',
            policy_hash: resolution.policy_hash,
            dispatch_id: resolution.dispatch_id,
            launch_id: 'unobserved',
          },
        }),
      }),
    },
    recorder: () => true,
  });
  const result = boundary.dispatch({ runtime: 'codex', role: 'executor' });
  assert.equal(result.observed_model, 'unknown');
  assert.equal(result.observed_effort, 'unknown');
});

test('an async launch cannot change observation capability after dispatch begins', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const adapter = {
    observationUnavailable: false,
    launch(resolution) {
      return pending.then(() => {
        this.observationUnavailable = true;
        return receiptFor(resolution, { observed_model: 'unknown', observed_effort: 'unknown' });
      });
    },
  };
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: adapter },
    recorder: () => true,
  });
  const result = boundary.dispatch({ runtime: 'codex', role: 'executor' });
  adapter.observationUnavailable = true;
  release();
  await assert.rejects(
    result,
    (error) => error.code === 'NONCOMPLIANT_RECEIPT' && /observed_model/.test(error.message),
  );
});

test('a receipt cannot self-authorize unavailable observations', () => {
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        receipt: (resolution) => ({
          receipt_type: 'adr-014.application',
          runtime: resolution.runtime,
          role: resolution.role,
          dispatch_id: resolution.dispatch_id,
          launch_id: 'caller-claimed-unobserved',
          requested_model: resolution.model,
          requested_effort: resolution.effort,
          applied_model: resolution.model,
          applied_effort: resolution.effort,
          policy_hash: resolution.policy_hash,
          compliance: 'verified',
          compliance_proof: {
            status: 'verified',
            boundary: 'adr-014.dispatch-boundary',
            policy_hash: resolution.policy_hash,
            dispatch_id: resolution.dispatch_id,
            launch_id: 'caller-claimed-unobserved',
          },
          observation_unavailable: true,
        }),
      }),
    },
    recorder: () => true,
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'executor' }),
    (error) => error.code === 'MISSING_RECEIPT',
  );
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
  assert.throws(
    () => boundaryModule.verifyApplicationReceipt(
      resolution,
      { ...receipt, observed_model: 'unknown', observed_effort: 'unknown' },
      { adapter: { observationUnavailable: true } },
    ),
    (error) => error.code === 'UNSUPPORTED_SELECTION' && /boundary-owned/.test(error.message),
  );
  const direct = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
  });
  assert.equal(direct.validate(resolution), true);
});

done();
