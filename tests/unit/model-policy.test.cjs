'use strict';

const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');

const codex = (role, signals = {}, extra = {}) =>
  policy.resolveDispatch({ runtime: 'codex', role, signals, ...extra });
const claude = (role, signals = {}, extra = {}) =>
  policy.resolveDispatch({ runtime: 'claude', role, signals, ...extra });

function priorReceipt(role, model, effort, dispatchId) {
  const receipt = {
    receipt_type: 'adr-014.application',
    runtime: 'codex',
    role,
    dispatch_id: dispatchId,
    launch_id: `launch-${dispatchId}`,
    requested_model: model,
    requested_effort: effort,
    applied_model: model,
    applied_effort: effort,
    observed_model: model,
    observed_effort: effort,
    policy_hash: policy.POLICY_HASH,
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: policy.POLICY_HASH,
      dispatch_id: dispatchId,
      launch_id: `launch-${dispatchId}`,
    },
  };
  return receipt;
}

const CODEx_BASE = {
  research: ['terra', 'gpt-5.6-terra', 'high'],
  decomposition: ['sol', 'gpt-5.6-sol', 'medium'],
  executor: ['luna', 'gpt-5.6-luna', 'max'],
  'pr-sentinel': ['luna', 'gpt-5.6-luna', 'medium'],
  integrator: ['sol', 'gpt-5.6-sol', 'medium'],
  'drift-check': ['luna', 'gpt-5.6-luna', 'max'],
  'arch-review': ['sol', 'gpt-5.6-sol', 'medium'],
  'ci-fix': ['luna', 'gpt-5.6-luna', 'max'],
  'review-fix': ['luna', 'gpt-5.6-luna', 'max'],
};

suite('ADR-014 canonical policy');

test('exposes exactly the nine routed roles and the concrete Codex palette', () => {
  assert.deepStrictEqual([...policy.ROLES], Object.keys(CODEx_BASE));
  assert.deepStrictEqual(policy.CODEX_MODEL_IDS, {
    terra: 'gpt-5.6-terra',
    sol: 'gpt-5.6-sol',
    luna: 'gpt-5.6-luna',
    astra: 'gpt-6-astra',
  });
  assert.equal(policy.POLICY.version, policy.POLICY_VERSION);
  assert.equal(policy.POLICY_HASH, policy.fingerprintPolicy(policy.POLICY));
  assert.match(policy.POLICY_HASH, /^[0-9a-f]{64}$/);
});

test('fingerprint covers escalation rules and repair prerequisites', () => {
  const altered = JSON.parse(JSON.stringify(policy.POLICY));
  altered.signal_rules.integrator.critical.any.push({ risk: 'high' });
  assert.notEqual(policy.fingerprintPolicy(altered), policy.POLICY_HASH);
  const alteredRepair = JSON.parse(JSON.stringify(policy.POLICY));
  alteredRepair.repair_prerequisites['ci-fix'].repeat.effort = 'medium';
  assert.notEqual(policy.fingerprintPolicy(alteredRepair), policy.POLICY_HASH);
});

test('resolves every base role to the ADR-014 logical and concrete tuple on Codex', () => {
  for (const [role, [logical, model, effort]] of Object.entries(CODEx_BASE)) {
    const result = codex(role);
    assert.equal(result.logical_model, logical, role);
    assert.equal(result.model, model, role);
    assert.equal(result.effort, effort, role);
    assert.equal(result.logical_rung, 'base', role);
    assert.equal(result.requested_model, model, role);
    assert.equal(result.requested_effort, effort, role);
    assert.equal(result.policy_version, policy.POLICY_VERSION, role);
    assert.equal(result.policy_hash, policy.POLICY_HASH, role);
    assert.ok(result.route, `${role} route`);
    assert.ok(result.backend, `${role} backend`);
    assert.ok(result.mechanism, `${role} mechanism`);
    assert.ok(Array.isArray(result.signals_fired), `${role} fired signals`);
    if (policy.DYNAMIC_ROLES.includes(role)) {
      assert.equal(result.agent_file, null, `${role} is dynamic`);
      assert.deepStrictEqual(result.launch_arguments, { model, reasoning_effort: effort });
    } else {
      assert.match(result.agent_file, /^shipyard-.*\.toml$/, `${role} static file`);
    }
  }
});

test('maps logical rungs through the existing Claude palette without changing Codex ids', () => {
  const cases = [
    ['research', {}, 'base', 'terra', 'sonnet', 'high'],
    ['research', { type: 'alternatives' }, 'alternatives', 'sol', 'opus', 'medium'],
    ['research', { complexity: 'very-complex' }, 'very-complex', 'astra', 'fable', 'medium'],
    ['decomposition', { checkpoint: true }, 'critical', 'astra', 'fable', 'medium'],
    ['decomposition', { critical: true }, 'critical', 'astra', 'fable', 'medium'],
    ['executor', {}, 'base', 'luna', 'opus', 'max'],
  ];
  for (const [role, signals, rung, logical, model, effort] of cases) {
    const result = claude(role, signals);
    assert.deepStrictEqual(
      [result.logical_rung, result.logical_model, result.model, result.effort],
      [rung, logical, model, effort],
      `${role}/${JSON.stringify(signals)}`,
    );
    assert.equal(result.backend, 'workflow');
    assert.equal(result.mechanism, 'workflow-explicit-selection');
    assert.deepStrictEqual(result.launch_arguments, { model, effort });
  }
});

test('research promotes alternatives and explicit very-complex, retaining both reasons', () => {
  const result = codex('research', {
    type: 'alternatives',
    complexity: 'very-complex',
  });
  assert.equal(result.logical_rung, 'very-complex');
  assert.equal(result.model, 'gpt-6-astra');
  assert.deepStrictEqual(result.signals_fired, ['alternatives', 'very-complex']);
  assert.deepStrictEqual(result.selected_signals.map((item) => item.signal), ['alternatives', 'very-complex']);
  assert.equal(result.signal_reasons.length, 2);
  assert.ok(result.signal_reasons.every((item) => item.applies === true));
});

test('decomposition uses only explicit checkpoint evidence, not global risk', () => {
  assert.equal(codex('decomposition', { risk: 'high' }).logical_rung, 'base');
  assert.equal(codex('decomposition', { checkpoint: true }).logical_rung, 'critical');
  assert.equal(codex('decomposition', { critical: true }).logical_rung, 'critical');
  const result = codex('decomposition', { risk: 'high', checkpoint: true });
  assert.equal(result.logical_rung, 'critical');
  assert.ok(result.signals_fired.includes('risk'));
  assert.ok(result.signals_fired.includes('checkpoint'));
  assert.ok(result.signal_reasons.some((item) => item.signal === 'risk' && item.applies === false));
});

test('judgement roles promote only on ADR-014 scoped signals and preserve all fired reasons', () => {
  for (const role of ['integrator', 'arch-review']) {
    for (const signals of [
      { critical: true },
      { contested: true },
      { checkpoint: true },
      { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 },
    ]) {
      const result = codex(role, signals);
      assert.equal(result.logical_rung, 'critical', `${role}/${JSON.stringify(signals)}`);
      assert.equal(result.model, 'gpt-6-astra');
      assert.equal(result.effort, 'medium');
    }
    const riskOnly = codex(role, { risk: 'high' });
    assert.equal(riskOnly.logical_rung, 'base', `${role}/risk`);
    assert.equal(riskOnly.model, 'gpt-5.6-sol');
    assert.ok(riskOnly.signal_reasons.some((item) => item.signal === 'risk' && item.applies === false));
    const combined = codex(role, {
      risk: 'high',
      checkpoint: true,
      contested: true,
      inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
    });
    assert.ok(combined.signals_fired.includes('risk'));
    assert.ok(combined.signals_fired.includes('checkpoint'));
    assert.ok(combined.signals_fired.includes('contested'));
    assert.ok(combined.signals_fired.includes('window'));
    assert.equal(combined.signal_reasons.length, 4);
    assert.ok(combined.signal_reasons.some((item) => item.signal === 'risk' && item.applies === false));
    assert.equal(combined.selected_signals.some((item) => item.signal === 'risk'), false);
  }
});

test('window escalation uses only measured input against the fingerprinted threshold', () => {
  const threshold = policy.WINDOW_THRESHOLD_TOKENS;
  assert.equal(policy.POLICY.window_threshold_tokens, threshold);
  assert.equal(codex('integrator', { inputTokens: threshold }).logical_rung, 'base');
  assert.equal(codex('integrator', { inputTokens: threshold + 1 }).logical_rung, 'critical');
  assert.throws(
    () => codex('integrator', { inputTokens: 1, windowThresholdTokens: 0 }),
    (error) => error.code === 'UNSUPPORTED_SIGNAL',
  );
  assert.throws(
    () => policy.evaluateSignals('integrator', { inputTokens: 1 }, { windowThresholdTokens: 0 }),
    (error) => error.code === 'UNSUPPORTED_SELECTION',
  );
  assert.throws(
    () => codex('integrator', { windowExceeded: true }),
    (error) => error.code === 'UNSUPPORTED_SIGNAL',
  );
});

test('fixed Luna roles ignore global risk, critical, checkpoint, and window promotion', () => {
  for (const role of ['executor', 'pr-sentinel', 'drift-check']) {
    const result = codex(role, {
      risk: 'high',
      critical: true,
      checkpoint: true,
      inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
    });
    assert.equal(result.logical_rung, 'base', role);
    assert.equal(result.logical_model, 'luna', role);
    assert.equal(result.model, 'gpt-5.6-luna', role);
    assert.ok(result.signals_fired.includes('risk'), `${role} retains risk`);
    assert.ok(result.signals_fired.includes('critical'), `${role} retains critical`);
    assert.ok(result.signals_fired.includes('checkpoint'), `${role} retains checkpoint`);
    assert.ok(result.signals_fired.includes('window'), `${role} retains window`);
    assert.ok(result.signal_reasons.every((item) => item.applies === false), `${role} has no promotion reason`);
  }
});

test('direct policy repair resolution fails closed without boundary provenance', () => {
  assert.equal(codex('ci-fix', { signatureState: 'first' }).logical_rung, 'base');
  assert.equal(codex('review-fix', { signatureState: 'progress' }).logical_rung, 'base');
  const luna = priorReceipt('ci-fix', 'gpt-5.6-luna', 'max', 'luna-1');
  assert.throws(
    () => codex('ci-fix', {
      signatureState: 'repeat',
      priorApplied: luna,
    }, { previous_dispatch_id: 'luna-1' }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
  assert.equal(codex('review-fix', { signatureState: 'flake' }).logical_rung, 'base');
  assert.throws(
    () => codex('ci-fix', { signatureState: 'repeat' }),
    (error) => error.code === 'MISSING_RECEIPT' && /preceding/.test(error.message),
  );
  assert.throws(
    () => codex('ci-fix', {
      signatureState: 'repeat_exhausted',
      priorApplied: luna,
    }, { previous_dispatch_id: 'luna-1' }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
  assert.throws(
    () => codex('ci-fix', {
      signatureState: 'repeat',
      priorApplied: { model: 'gpt-5.6-luna', effort: 'max', dispatchId: 'forged' },
    }, { previous_dispatch_id: 'forged' }),
    (error) => error.code === 'MISSING_RECEIPT' || error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('matching overrides are harmless but conflicting or unsupported selections fail closed', () => {
  const matching = codex('executor', {
    risk: 'high',
  }, {
    override: { model: 'gpt-5.6-luna', effort: 'max', runtime: 'codex' },
  });
  assert.equal(matching.model, 'gpt-5.6-luna');
  assert.throws(
    () => codex('executor', {}, { override: { model: 'gpt-5.6-terra' } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => codex('executor', {}, { override: { effort: 'low' } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', model: 'inherit' }),
    (error) => error.code === 'CONFLICTING_OVERRIDE' || error.code === 'UNSUPPORTED_SELECTION',
  );
  assert.throws(
    () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', override: { runtime: 'claude' } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
});

test('unknown runtime, malformed signals, and unsupported signal names fail closed', () => {
  assert.throws(
    () => policy.resolveDispatch({ role: 'executor', signals: {} }),
    (error) => error.code === 'UNKNOWN_RUNTIME',
  );
  assert.throws(
    () => policy.resolveDispatch({ runtime: 'both', role: 'executor', signals: {} }),
    (error) => error.code === 'UNKNOWN_RUNTIME',
  );
  assert.throws(
    () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals: { type: 'implementation' } }),
    (error) => error.code === 'UNSUPPORTED_SIGNAL',
  );
  assert.throws(
    () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals: { mystery: true } }),
    (error) => error.code === 'UNSUPPORTED_SIGNAL',
  );
  for (const signals of [{ alternatives: true }, { veryComplex: true }, { complexity: 'critical' }]) {
    assert.throws(
      () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals }),
      (error) => error.code === 'UNSUPPORTED_SIGNAL',
      JSON.stringify(signals),
    );
  }
  assert.equal(policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals: { critical: true } }).logical_rung, 'base');
});

test('resolution is immutable and exposes route, backend, mechanism, and reason provenance', () => {
  const result = codex('executor', { risk: 'high', checkpoint: true });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.signals_fired));
  assert.ok(Object.isFrozen(result.signal_reasons));
  assert.equal(result.backend, 'agent');
  assert.equal(result.mechanism, 'explicit-launch-arguments');
  assert.match(result.route, /role=executor/);
  assert.match(result.route, /rung=base/);
  assert.match(result.signal_reasons.find((item) => item.signal === 'risk').reason, /inert|not a role-scoped/);
});

test('direct repair resolution does not accept caller-owned receipt evidence', () => {
  const priorApplied = priorReceipt('ci-fix', 'gpt-5.6-luna', 'max', 'luna-owned-by-caller');
  assert.equal(Object.isFrozen(priorApplied), false);
  assert.throws(
    () => codex('ci-fix', { signatureState: 'repeat', priorApplied }, { previous_dispatch_id: 'luna-owned-by-caller' }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('public resolver rejects caller-supplied receipt verifiers', () => {
  let verifierCalled = false;
  const priorApplied = priorReceipt('ci-fix', 'gpt-5.6-luna', 'max', 'caller-forged');
  assert.throws(
    () => policy.resolveDispatch(
      {
        runtime: 'codex',
        role: 'ci-fix',
        signals: { signatureState: 'repeat', priorApplied },
        previous_dispatch_id: 'caller-forged',
      },
      {
        receiptVerifier: () => {
          verifierCalled = true;
          return priorApplied;
        },
      },
    ),
    (error) => error.code === 'UNVERIFIED_RECEIPT' && /private/.test(error.message),
  );
  assert.equal(verifierCalled, false);
  assert.equal(policy.validatePriorReceipt, undefined);
});

done();
