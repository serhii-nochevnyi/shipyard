'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
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
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-chain-'));
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
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

test('static Codex evidence is rechecked after validation hooks and before launch', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-agent-race-'));
  const base = policy.resolveDispatch({ runtime: 'codex', role: 'research', dispatch_id: 'agent-race' });
  writeStaticAgent(agentsDir, base);
  let launched = false;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        agentsDir,
        validate: () => fs.appendFileSync(path.join(agentsDir, base.agent_file), '# changed during validation\n'),
        onLaunch: () => { launched = true; },
      }),
    },
    recorder: () => true,
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'agent-race' }),
    (error) => error.code === 'STALE_GENERATED_AGENT' && /after validation/.test(error.message),
  );
  assert.equal(launched, false);
});

test('adapter-owned static evidence is revalidated before launch without an agents root', () => {
  const base = policy.resolveDispatch({ runtime: 'codex', role: 'research', dispatch_id: 'adapter-agent-race' });
  let validationCalls = 0;
  let launched = false;
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        validateGeneratedAgent: (resolution) => {
          validationCalls += 1;
          return {
            valid: true,
            exists: true,
            content_verified: true,
            policy_hash: resolution.policy_hash,
            agent_file: resolution.agent_file,
            agent_file_digest: validationCalls === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
          };
        },
        onLaunch: () => { launched = true; },
      }),
    },
    recorder: () => true,
  });
  assert.throws(
    () => boundary.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'adapter-agent-race' }),
    (error) => error.code === 'STALE_GENERATED_AGENT' && /after validation/.test(error.message),
  );
  assert.equal(validationCalls, 2);
  assert.equal(launched, false);
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
  assert.deepStrictEqual(stored.trace, first.trace);
  assert.deepStrictEqual(stored, first);
  const modulePath = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'dispatch-boundary.cjs');
  const restarted = spawnSync(process.execPath, [
    '-e',
    'const b=require(process.argv[1]);process.stdout.write(JSON.stringify(b.createDurableRecorder(process.argv[2]).getReceipt(process.argv[3])));',
    modulePath,
    storeDir,
    first.dispatch_id,
  ], { encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepStrictEqual(JSON.parse(restarted.stdout), first);
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

test('an unsigned legacy repair commit cannot recover a successor or block replay', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-repair-crash-'));
  const base = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  }).dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'crash-commit-base',
  });
  const successorId = 'crash-commit-successor';
  const recordInput = {
    dispatch_id: successorId,
    predecessor_dispatch_id: base.dispatch_id,
    predecessor_consumer_id: successorId,
    receipt: {
      dispatch_id: successorId,
      runtime: 'codex',
      role: 'ci-fix',
      compliance: 'verified',
    },
  };
  const commitPath = path.join(storeDir, `repair-commit-${crypto.createHash('sha256').update(base.dispatch_id).digest('hex')}.json`);
  // This is the durable state left by a process dying after the commit marker
  // reaches disk but before it writes the successor record.
  fs.writeFileSync(commitPath, JSON.stringify({
    predecessor_dispatch_id: base.dispatch_id,
    successor_dispatch_id: successorId,
    consumer_id: successorId,
    record_input: recordInput,
  }) + '\n');

  const recoveredRecorder = boundaryModule.createDurableRecorder(storeDir);
  const claim = recoveredRecorder.claim(base.dispatch_id, 'replay-contender');
  assert.equal(claim.claimed, true);
  assert.equal(recoveredRecorder.getReceipt(successorId), null);
  assert.deepStrictEqual(recoveredRecorder.release(base.dispatch_id, 'replay-contender', claim), { released: true });

  const repaired = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  }).dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
    previous_dispatch_id: base.dispatch_id,
    dispatch_id: 'legacy-repair-replacement',
  });
  assert.equal(repaired.dispatch_id, 'legacy-repair-replacement');
});

test('an authenticated repair commit makes its predecessor non-replayable before physical consumption', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-recorded-crash-'));
  const base = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  }).dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'recorded-crash-base',
  });
  const successorId = 'recorded-crash-successor';
  const modulePath = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'dispatch-boundary.cjs');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const b = require(process.argv[1]);
    const recorder = b.createDurableRecorder(process.argv[2]);
    const prior = JSON.parse(process.argv[3]);
    const originalLink = fs.linkSync;
    fs.linkSync = (source, destination) => {
      originalLink(source, destination);
      if (String(destination).includes('repair-commit-')) process.exit(73);
    };
    const receiptFor = ${receiptFor.toString()};
    const boundary = b.createDispatchBoundary({
      recorder,
      adapters: { codex: {
        validateGeneratedAgent: (resolution) => ({
          valid: true,
          exists: true,
          content_verified: true,
          policy_hash: resolution.policy_hash,
          agent_file: resolution.agent_file,
          agent_file_digest: 'a'.repeat(64),
        }),
        launch: (resolution) => receiptFor(resolution),
      } },
    });
    boundary.dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: prior },
      previous_dispatch_id: process.argv[4],
      dispatch_id: ${JSON.stringify(successorId)},
    });
  `, modulePath, storeDir, JSON.stringify(base.receipt), base.dispatch_id], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);

  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const restarted = boundaryModule.createDurableRecorder(storeDir);
  assert.deepStrictEqual(restarted.claim(base.dispatch_id, 'recorded-replay-contender'), { claimed: false });
  assert.equal(fs.existsSync(path.join(storeDir, `consumed-${digest(base.dispatch_id)}.json`)), false);
  assert.equal(restarted.getReceipt(successorId).dispatch_id, successorId);
  assert.throws(
    () => boundaryModule.createDispatchBoundary({
      adapters: { codex: fakeAdapter() },
      recorder: boundaryModule.createDurableRecorder(storeDir),
    }).dispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: base.receipt },
      previous_dispatch_id: base.dispatch_id,
      dispatch_id: 'recorded-crash-replay',
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

test('a self-consistent forged Claude predecessor from a custom recorder cannot authorize repair', () => {
  const forgedResolution = policy.resolveDispatch({
    runtime: 'claude',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'forged-claude-base',
  });
  const forgedReceipt = receiptFor(forgedResolution);
  const forgedRecord = {
    dispatch_id: forgedResolution.dispatch_id,
    resolution: forgedResolution,
    receipt: forgedReceipt,
    trace: [
      { stage: 'resolve', status: 'passed' },
      { stage: 'validate', status: 'passed' },
      { stage: 'launch', status: 'passed', launch_id: forgedReceipt.launch_id },
      { stage: 'record', status: 'passed' },
      { stage: 'receipt', status: 'passed', launch_id: forgedReceipt.launch_id },
    ],
  };
  let launched = false;
  const recorder = {
    reserve: () => ({ reserved: true }),
    record: () => ({ recorded: true }),
    getReceipt: () => forgedRecord,
    claim: () => ({ claimed: true }),
    renewClaim: () => ({ renewed: true }),
    release: () => ({ released: true }),
    consume: () => ({ consumed: true }),
  };
  const boundary = boundaryModule.createDispatchBoundary({
    adapters: { claude: fakeAdapter({ onLaunch: () => { launched = true; } }) },
    recorder,
  });
  assert.throws(
    () => boundary.dispatch({
      runtime: 'claude',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied: forgedReceipt },
      previous_dispatch_id: forgedResolution.dispatch_id,
      dispatch_id: 'forged-claude-repeat',
    }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
  assert.equal(launched, false);
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
  const active = recorder.claim('claim-id', 'active-owner');
  assert.equal(active.claimed, true);
  assert.equal(active.generation, 1);
  assert.equal(typeof active.claim_token, 'string');
  assert.deepStrictEqual(recorder.claim('claim-id', 'other-owner'), { claimed: false });

  const claimName = fs.readdirSync(storeDir).find((name) => name.startsWith('claim-') && name.endsWith('.json'));
  const claimPath = path.join(storeDir, claimName);
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.claimed_at = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
  claim.lease_expires_at = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
  delete claim.owner_pid;
  fs.writeFileSync(claimPath, JSON.stringify(claim) + '\n');

  const recovered = recorder.claim('claim-id', 'recovered-owner');
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.generation, active.generation + 1);
  assert.notEqual(recovered.claim_token, active.claim_token);
  assert.deepStrictEqual(recorder.consume('claim-id', 'recovered-owner', recovered), { consumed: true });
  assert.deepStrictEqual(recorder.claim('claim-id', 'late-owner'), { claimed: false });
});

test('an active owner renews its lease, but expiry permits takeover despite a live PID', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-live-claim-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  const active = recorder.claim('live-claim-id', 'live-owner');
  assert.equal(active.claimed, true);
  assert.deepStrictEqual(recorder.renewClaim('live-claim-id', 'live-owner', active), { renewed: true });
  const claimName = fs.readdirSync(storeDir).find((name) => name.startsWith('claim-') && name.endsWith('.json'));
  const claimPath = path.join(storeDir, claimName);
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  claim.claimed_at = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
  claim.lease_expires_at = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
  fs.writeFileSync(claimPath, JSON.stringify(claim) + '\n');
  const takeover = recorder.claim('live-claim-id', 'other-owner');
  assert.equal(takeover.claimed, true);
  assert.equal(takeover.generation, active.generation + 1);
  assert.notEqual(takeover.claim_token, active.claim_token);
  assert.deepStrictEqual(recorder.renewClaim('live-claim-id', 'live-owner', active), { renewed: false });
  assert.deepStrictEqual(recorder.release('live-claim-id', 'live-owner', active), { released: false });
  assert.deepStrictEqual(recorder.consume('live-claim-id', 'live-owner', active), { consumed: false });
  assert.deepStrictEqual(recorder.renewClaim('live-claim-id', 'other-owner', takeover), { renewed: true });
});

test('a superseded claim owner cannot commit after an expired-lease takeover', async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-fenced-claim-'));
  const base = boundaryModule.createDispatchBoundary({
    adapters: { codex: fakeAdapter() },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  }).dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'first' },
    dispatch_id: 'fenced-base',
  });
  let finishLaunch;
  const pendingLaunch = new Promise((resolve) => { finishLaunch = resolve; });
  const oldOwner = boundaryModule.createDispatchBoundary({
    adapters: {
      codex: fakeAdapter({
        receipt: (resolution) => pendingLaunch.then(() => receiptFor(resolution)),
      }),
    },
    recorder: boundaryModule.createDurableRecorder(storeDir),
  });
  const pendingDispatch = oldOwner.dispatch({
    runtime: 'codex',
    role: 'ci-fix',
    signals: { signatureState: 'repeat', priorApplied: base.receipt },
    previous_dispatch_id: base.dispatch_id,
    dispatch_id: 'fenced-old-successor',
  });

  const claimName = fs.readdirSync(storeDir).find((name) => name.startsWith('claim-') && name.endsWith('.json'));
  const claimPath = path.join(storeDir, claimName);
  const stale = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  stale.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(claimPath, JSON.stringify(stale) + '\n');
  const takeoverRecorder = boundaryModule.createDurableRecorder(storeDir);
  const takeover = takeoverRecorder.claim(base.dispatch_id, 'fenced-new-successor');
  assert.equal(takeover.claimed, true);
  assert.equal(takeover.generation, stale.generation + 1);

  finishLaunch();
  await assert.rejects(
    pendingDispatch,
    (error) => error.code === 'RECORD_FAILED',
  );
  assert.equal(takeoverRecorder.getReceipt('fenced-old-successor'), null);
  assert.deepStrictEqual(
    takeoverRecorder.consume(base.dispatch_id, 'fenced-new-successor', takeover),
    { consumed: true },
  );
});

test('failed temporary writes and fsync never publish a reservation', () => {
  for (const operation of ['writeFileSync', 'fsyncSync', 'linkSync']) {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-create-failure-'));
    const recorder = boundaryModule.createDurableRecorder(storeDir);
    const original = fs[operation];
    fs[operation] = (...args) => {
      if (operation === 'writeFileSync') original(args[0], '{');
      throw new Error(`injected ${operation} failure`);
    };
    try {
      assert.throws(() => recorder.reserve('retry-id'), /injected/);
      assert.deepStrictEqual(fs.readdirSync(storeDir), []);
    } finally {
      fs[operation] = original;
    }
    assert.deepStrictEqual(recorder.reserve('retry-id'), { reserved: true });
    const final = fs.readdirSync(storeDir);
    assert.equal(final.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir, final[0]), 'utf8')).dispatch_id, 'retry-id');
  }
});

test('a process crash during a temporary write leaves the final reservation available', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-temp-crash-'));
  const modulePath = require.resolve('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const b = require(process.argv[1]);
    const recorder = b.createDurableRecorder(process.argv[2]);
    const write = fs.writeFileSync;
    fs.writeFileSync = (fd) => { write(fd, '{'); process.exit(73); };
    recorder.reserve('crash-id');
  `, modulePath, storeDir], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const orphan = fs.readdirSync(storeDir);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].endsWith('.tmp'), true);
  assert.deepStrictEqual(boundaryModule.createDurableRecorder(storeDir).reserve('crash-id'), { reserved: true });
  const final = fs.readdirSync(storeDir).filter((name) => name.endsWith('.json'));
  assert.equal(final.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir, final[0]), 'utf8')).dispatch_id, 'crash-id');
});

test('directory fsync failure preserves a complete exclusive reservation', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-directory-failure-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('injected directory fsync failure');
    return original(fd);
  };
  try {
    assert.throws(() => recorder.reserve('directory-id'), /injected directory/);
  } finally {
    fs.fsyncSync = original;
  }
  const files = fs.readdirSync(storeDir);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir, files[0]), 'utf8')).dispatch_id, 'directory-id');
  assert.deepStrictEqual(recorder.reserve('directory-id'), { reserved: false });
});

test('durable observation capabilities survive process restart independently', () => {
  for (const unavailable of [{ model: true, effort: true }, { model: true, effort: false }, { model: false, effort: true }]) {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-observation-restart-'));
    const base = boundaryModule.createDispatchBoundary({
      adapters: { codex: fakeAdapter({
        capabilities: { observedModel: !unavailable.model, observedEffort: !unavailable.effort },
        extra: {
          ...(unavailable.model ? { observed_model: 'unknown' } : {}),
          ...(unavailable.effort ? { observed_effort: 'unknown' } : {}),
        },
      }) },
      recorder: boundaryModule.createDurableRecorder(storeDir),
    }).dispatch({ runtime: 'codex', role: 'ci-fix', signals: { signatureState: 'first' }, dispatch_id: 'base' });
    assert.deepStrictEqual(base.observation_unavailable, unavailable);
    const child = spawnSync(process.execPath, ['-e', `
      const b = require(process.argv[1]);
      const recorder = b.createDurableRecorder(process.argv[2]);
      const base = recorder.getReceipt('base');
      const receiptFor = ${receiptFor.toString()};
      const fakeAdapter = ${fakeAdapter.toString()};
      const boundary = b.createDispatchBoundary({ recorder, adapters: { codex: fakeAdapter() } });
      const result = boundary.dispatch({ runtime: 'codex', role: 'ci-fix',
        signals: { signatureState: 'repeat', priorApplied: base.receipt },
        previous_dispatch_id: 'base', dispatch_id: 'repeat' });
      process.stdout.write(JSON.stringify(result.resolution));
    `, require.resolve('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs'), storeDir], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).prior_applied.dispatch_id, 'base');

    // Model and effort permissions must come from the stored boundary record.
    // Removing either required permission (or legacy absence of both) fails
    // closed even when the caller presents the otherwise matching receipt.
    const recordPath = path.join(storeDir, `record-${crypto.createHash('sha256').update('base').digest('hex')}.json`);
    for (const field of [...Object.keys(unavailable).filter((key) => unavailable[key]), 'legacy']) {
      const stored = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      stored.payload.observation_unavailable = { ...unavailable, [field]: false };
      if (field === 'legacy') delete stored.payload.observation_unavailable;
      fs.writeFileSync(recordPath, JSON.stringify(stored));
      const freshRecorder = boundaryModule.createDurableRecorder(storeDir);
      assert.throws(() => boundaryModule.createDispatchBoundary({ recorder: freshRecorder }).resolve({
        runtime: 'codex', role: 'ci-fix', signals: { signatureState: 'repeat', priorApplied: base.receipt },
        previous_dispatch_id: 'base', dispatch_id: `missing-${field}`,
      }, freshRecorder), (error) => error.code === 'UNVERIFIED_RECEIPT');
    }
  }
});

test('caller capability claims cannot relax stored observation requirements', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-observation-forged-'));
  const recorder = boundaryModule.createDurableRecorder(storeDir);
  const base = boundaryModule.createDispatchBoundary({ adapters: { codex: fakeAdapter() }, recorder })
    .dispatch({ runtime: 'codex', role: 'ci-fix', signals: { signatureState: 'first' }, dispatch_id: 'base' });
  const forged = { ...base.receipt, observed_model: 'unknown', observed_effort: 'unknown',
    observation_unavailable: { model: true, effort: true } };
  const freshRecorder = boundaryModule.createDurableRecorder(storeDir);
  const fresh = boundaryModule.createDispatchBoundary({ recorder: freshRecorder });
  assert.throws(() => fresh.resolve({ runtime: 'codex', role: 'ci-fix',
    observation_unavailable: { model: true, effort: true },
    signals: { signatureState: 'repeat', priorApplied: forged },
    previous_dispatch_id: base.dispatch_id, dispatch_id: 'forged' }, freshRecorder),
  (error) => error.code === 'UNVERIFIED_RECEIPT');
});

test('file-backed reservation is atomic across concurrent Node processes', async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-boundary-race-'));
  const modulePath = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'dispatch-boundary.cjs');
  const script = [
    'const b = require(process.argv[1]);',
    'const r = b.createDurableRecorder(process.argv[2]);',
    'process.send("ready");',
    'process.once("message", () => { process.stdout.write(JSON.stringify(r.reserve(process.argv[3]))); process.disconnect(); });',
  ].join('\n');
  const children = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ['-e', script, modulePath, storeDir, 'atomic-id'], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('child exited before ready')));
    });
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    });
    return { child, ready, result };
  });
  await Promise.all(children.map(({ ready }) => ready));
  children.forEach(({ child }) => child.send('reserve'));
  const results = await Promise.all(children.map(({ result }) => result));
  assert.equal(results.filter((result) => result.reserved).length, 1);
  assert.equal(results.filter((result) => !result.reserved).length, 7);
  const files = fs.readdirSync(storeDir);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storeDir, files[0]), 'utf8')).dispatch_id, 'atomic-id');
});

done();
