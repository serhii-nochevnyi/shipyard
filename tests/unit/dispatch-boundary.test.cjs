'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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

function writeStaticAgent(agentsDir, resolution) {
  const name = resolution.agent_file.replace(/\.toml$/, '');
  const text = [
    `# shipyard-policy-id = "${policy.POLICY.id}"`,
    `# shipyard-policy-version = "${resolution.policy_version}"`,
    `# shipyard-policy-hash = "${resolution.policy_hash}"`,
    '# shipyard-policy-runtime = "codex"',
    `# shipyard-policy-role = "${resolution.role}"`,
    `# shipyard-policy-rung = "${resolution.rung}"`,
    `name = "${name}"`,
    `model = "${resolution.model}"`,
    `model_reasoning_effort = "${resolution.effort}"`,
    "developer_instructions = '''\nagent\n'''",
    '',
  ].join('\n');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, resolution.agent_file), text);
  fs.writeFileSync(path.join(agentsDir, '.shipyard-manifest.json'), JSON.stringify({
    policy_id: policy.POLICY.id,
    policy_version: resolution.policy_version,
    policy_hash: resolution.policy_hash,
    agent_files: [resolution.agent_file],
    agent_digests: {
      [resolution.agent_file]: crypto.createHash('sha256').update(text).digest('hex'),
    },
  }) + '\n');
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
  assert.equal(recorded[0].receipt.compliance, 'verified');
  assert.deepStrictEqual(recorded[0].receipt, result.receipt);
  assert.equal(recorded[0].receipt.compliance_proof.boundary, 'adr-014.dispatch-boundary');
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
  assert.throws(
    () => boundary.dispatch({
      runtime: 'codex',
      role: ' ci-fix ',
      signals: { signatureState: 'repeat' },
    }),
    (error) => error.code === 'MISSING_RECEIPT',
  );
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

test('observation capability is enforced independently for model and effort', () => {
  const partiallyUnavailable = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        capabilities: { observedModel: false, observedEffort: true },
        extra: { observed_model: 'unknown', observed_effort: 'unknown' },
      }),
    },
    recorder: () => true,
  });
  assert.throws(
    () => partiallyUnavailable.dispatch({ runtime: 'codex', role: 'executor' }),
    (error) => error.code === 'NONCOMPLIANT_RECEIPT' && /observed_effort/.test(error.message),
  );

  const valid = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        capabilities: { observedModel: false, observedEffort: true },
        extra: { observed_model: 'unknown' },
      }),
    },
    recorder: () => true,
  });
  const result = valid.dispatch({ runtime: 'codex', role: 'executor' });
  assert.equal(result.observed_model, 'unknown');
  assert.equal(result.observed_effort, 'max');
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
  const critical = policy.resolveDispatch({
    runtime: 'codex', role: 'arch-review', signals: { critical: true }, dispatch_id: 'forged-critical',
  });
  const forged = {
    ...critical,
    signals: {},
    signals_fired: [],
    signal_reasons: [],
    selected_signals: [],
    route: 'role=arch-review rung=base model=sol signals=base',
  };
  assert.throws(
    () => boundary.validate(forged),
    (error) => error.code === 'INVALID_RESOLUTION',
  );
});

test('receipt parsing cannot mint boundary trust, while validation remains available', () => {
  const resolution = policy.resolveDispatch({ runtime: 'codex', role: 'executor', dispatch_id: 'dispatch-primitive' });
  const receipt = receiptFor(resolution);
  assert.equal(boundaryModule.verifyApplicationReceipt, undefined);
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
  });
  const evidence = boundary.receipt(resolution, receipt);
  assert.equal(evidence.applied_model, 'gpt-5.6-luna');
  assert.equal(evidence.compliance, undefined);
  assert.equal(evidence.compliance_proof, undefined);
  assert.ok(Object.isFrozen(evidence));
  assert.throws(
    () => boundary.receipt(resolution, { ...receipt, observed_model: 'other' }),
    (error) => error.code === 'NONCOMPLIANT_RECEIPT',
  );
  assert.throws(
    () => boundary.receipt(
      resolution,
      { ...receipt, observed_model: 'unknown', observed_effort: 'unknown' },
    ),
    (error) => error.code === 'NONCOMPLIANT_RECEIPT',
  );
  assert.equal(boundary.validate(resolution), true);
});

test('the boundary validates the actual generated Codex file before launch', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-agents-'));
  let validatorCalled = false;
  const base = policy.resolveDispatch({ runtime: 'codex', role: 'research', dispatch_id: 'actual-agent-file' });
  writeStaticAgent(agentsDir, base);
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        agentsDir,
        validateGeneratedAgent: () => {
          validatorCalled = true;
          throw new Error('the injected validator must not replace file inspection');
        },
      }),
    },
    recorder: () => true,
  });
  const result = boundary.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'actual-agent-file' });
  assert.equal(result.receipt.agent_file, 'shipyard-inv-research.toml');
  assert.match(result.receipt.agent_file_digest, /^[a-f0-9]{64}$/);
  assert.equal(validatorCalled, false);
  fs.appendFileSync(path.join(agentsDir, base.agent_file), '# tampered after generation\n');
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'tampered-agent-file' }),
    (error) => error.code === 'STALE_GENERATED_AGENT' && /manifest digest/.test(error.message),
  );
});

test('separate boundary instances share durable reservation and finalized receipt state', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-store-'));
  const recorderA = boundaryModule.createDurableRecorder(storeDir);
  const recorderB = boundaryModule.createDurableRecorder(storeDir);
  let launches = 0;
  const makeBoundary = (recorder) => boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter({ onLaunch: () => { launches++; } }) },
    recorder,
  });
  const first = makeBoundary(recorderA).dispatch({
    runtime: 'codex', role: 'executor', dispatch_id: 'cross-boundary-id',
  });
  const stored = recorderB.getReceipt('cross-boundary-id');
  assert.equal(stored.receipt.compliance, 'verified');
  assert.deepStrictEqual(stored.receipt, first.receipt);
  assert.throws(
    () => makeBoundary(recorderB).dispatch({
      runtime: 'codex', role: 'executor', dispatch_id: 'cross-boundary-id',
    }),
    (error) => error.code === 'DUPLICATE_DISPATCH_ID',
  );
  assert.equal(launches, 1);
});

test('durable receipt repair survives a fresh boundary instance and consumes once', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-repair-'));
  const firstBoundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  });
  const base = firstBoundary.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'durable-repair-base',
  });
  const makeFreshBoundary = () => boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  });
  const repeat = makeFreshBoundary().dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
    previous_dispatch_id: base.dispatch_id,
    dispatch_id: 'durable-repair-repeat',
  });
  assert.equal(repeat.applied_model, 'gpt-5.6-sol');
  assert.equal(repeat.resolution.prior_applied.dispatch_id, base.dispatch_id);
  assert.throws(
    () => makeFreshBoundary().dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: base.receipt },
      previous_dispatch_id: base.dispatch_id,
      dispatch_id: 'durable-repair-repeat-again',
    }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('a stored record whose identities disagree cannot authorize a repair', () => {
  const base = policy.resolveDispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'identity-base',
  });
  const prior = receiptFor(base);
  const recorder = {
    reserve: () => ({ reserved: true }),
    getReceipt: () => ({
      dispatch_id: 'different-record',
      receipt: prior,
      resolution: base,
    }),
    claim: () => ({ claimed: true }),
    release: () => ({ released: true }),
    consume: () => ({ consumed: true }),
    record: () => ({ recorded: true }),
  };
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder,
  });
  assert.throws(
    () => boundary.dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: prior },
      previous_dispatch_id: base.dispatch_id,
      dispatch_id: 'identity-repeat',
    }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('independent repair chains do not share a global latest receipt lane', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-parallel-repair-'));
  const makeBoundary = () => boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  });
  const baseA = makeBoundary().dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'parallel-base-a',
  });
  const baseB = makeBoundary().dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'parallel-base-b',
  });
  const repeatA = makeBoundary().dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: baseA.receipt },
    previous_dispatch_id: baseA.dispatch_id,
    dispatch_id: 'parallel-repeat-a',
  });
  const repeatB = makeBoundary().dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: baseB.receipt },
    previous_dispatch_id: baseB.dispatch_id,
    dispatch_id: 'parallel-repeat-b',
  });
  assert.equal(repeatA.resolution.prior_applied.dispatch_id, baseA.dispatch_id);
  assert.equal(repeatB.resolution.prior_applied.dispatch_id, baseB.dispatch_id);
});

test('top-level dispatch continues a repair chain with the same durable recorder', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-convenience-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  const options = {
    adapters: { codex: fakeAdapter() },
    recorder,
  };
  const base = boundaryModule.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'convenience-base',
  }, options);
  const repeat = boundaryModule.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
    previous_dispatch_id: base.dispatch_id,
    dispatch_id: 'convenience-repeat',
  }, options);
  assert.equal(repeat.applied_model, 'gpt-5.6-sol');
  assert.equal(repeat.resolution.prior_applied.dispatch_id, base.dispatch_id);
});

test('a failed repair launch releases its predecessor claim for a later attempt', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-retry-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  const baseBoundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder,
  });
  const base = baseBoundary.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'retry-base',
  });
  const failing = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({ onLaunch: () => { throw new Error('launch failed'); } }),
    },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  });
  assert.throws(
    () => failing.dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: base.receipt },
      previous_dispatch_id: base.dispatch_id,
      dispatch_id: 'retry-failed',
    }),
    /launch failed/,
  );
  const retry = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  }).dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
    previous_dispatch_id: base.dispatch_id,
    dispatch_id: 'retry-success',
  });
  assert.equal(retry.applied_model, 'gpt-5.6-sol');
});

test('durable recorder writes require boundary authority', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-authority-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  recorder.reserve('caller-reserved');
  assert.deepStrictEqual(
    recorder.record({
      dispatch_id: 'caller-reserved',
      receipt: { dispatch_id: 'caller-reserved', compliance: 'verified' },
    }),
    { recorded: false },
  );
  assert.equal(recorder.getReceipt('caller-reserved'), null);
});

test('stale durable claims recover, while consumed predecessors cannot be reclaimed', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-claims-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  assert.deepStrictEqual(recorder.claim('claim-id', 'active-owner'), { claimed: true });
  assert.deepStrictEqual(recorder.claim('claim-id', 'other-owner'), { claimed: false });

  const claimName = fs.readdirSync(storeDir).find((name) => name.startsWith('claim-') && name.endsWith('.json'));
  const claimPath = path.join(storeDir, claimName);
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.claimed_at = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
  claim.lease_expires_at = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
  delete claim.owner_pid;
  fs.writeFileSync(claimPath, JSON.stringify(claim) + '\n');

  assert.deepStrictEqual(recorder.claim('claim-id', 'recovered-owner'), { claimed: true });
  assert.deepStrictEqual(recorder.consume('claim-id', 'recovered-owner'), { consumed: true });
  assert.deepStrictEqual(recorder.claim('claim-id', 'late-owner'), { claimed: false });
});

test('a live owner renews its lease and cannot be reclaimed after the nominal TTL', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-live-claim-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  assert.deepStrictEqual(recorder.claim('live-claim-id', 'live-owner'), { claimed: true });
  const claimName = fs.readdirSync(storeDir).find((name) => name.startsWith('claim-') && name.endsWith('.json'));
  const claimPath = path.join(storeDir, claimName);
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.claimed_at = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
  claim.lease_expires_at = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
  fs.writeFileSync(claimPath, JSON.stringify(claim) + '\n');
  assert.deepStrictEqual(recorder.claim('live-claim-id', 'other-owner'), { claimed: false });
  assert.deepStrictEqual(recorder.renewClaim('live-claim-id', 'live-owner'), { renewed: true });
  const renewed = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  assert.ok(Date.parse(renewed.lease_expires_at) > Date.now());
  assert.deepStrictEqual(recorder.claim('live-claim-id', 'other-owner'), { claimed: false });
});

test('file-backed reservation is atomic across Node processes', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-race-'));
  const modulePath = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'dispatch-boundary.cjs');
  const script = [
    'const b = require(process.argv[1]);',
    'const r = b.createDurableRecorder(process.argv[2]);',
    'process.stdout.write(JSON.stringify(r.reserve(process.argv[3])));',
  ].join('\n');
  const first = spawnSync(process.execPath, ['-e', script, modulePath, storeDir, 'atomic-id'], { encoding: 'utf8' });
  const second = spawnSync(process.execPath, ['-e', script, modulePath, storeDir, 'atomic-id'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepStrictEqual(JSON.parse(first.stdout), { reserved: true });
  assert.deepStrictEqual(JSON.parse(second.stdout), { reserved: false });
});

done();
