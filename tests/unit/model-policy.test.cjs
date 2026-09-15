'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const canonicalInternalPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
const runtimeAdapters = require('../../plugins/delivery-pipeline/scripts/runtime-adapters.cjs');

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
  research: ['astra', 'gpt-6-astra', 'low'],
  decomposition: ['astra', 'gpt-6-astra', 'low'],
  executor: ['luna', 'gpt-5.6-luna', 'max'],
  'pr-sentinel': ['luna', 'gpt-5.6-luna', 'medium'],
  integrator: ['astra', 'gpt-6-astra', 'low'],
  'drift-check': ['luna', 'gpt-5.6-luna', 'max'],
  'arch-review': ['astra', 'gpt-6-astra', 'low'],
  'ci-fix': ['luna', 'gpt-5.6-luna', 'max'],
  'review-fix': ['luna', 'gpt-5.6-luna', 'max'],
};

suite('ADR-014 canonical policy');

test('exposes exactly the nine routed roles and the concrete Codex palette', () => {
  assert.deepStrictEqual([...policy.ROLES], Object.keys(CODEx_BASE));
  assert.deepStrictEqual(policy.CODEX_MODEL_IDS, {
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

test('resolves Claude through its independent native grid without changing Codex ids', () => {
  const cases = [
    ['research', {}, 'base', 'opus', 'opus', 'medium'],
    ['research', { type: 'alternatives' }, 'base', 'opus', 'opus', 'medium'],
    ['research', { complexity: 'very-complex' }, 'very-complex', 'opus', 'opus', 'max'],
    ['decomposition', { checkpoint: true }, 'critical', 'opus', 'opus', 'max'],
    ['decomposition', { critical: true }, 'critical', 'opus', 'opus', 'max'],
    ['executor', {}, 'base', 'sonnet', 'sonnet', 'max'],
    ['executor', { critical: true }, 'critical', 'opus', 'opus', 'low'],
    ['pr-sentinel', {}, 'base', 'sonnet', 'sonnet', 'high'],
    ['integrator', {}, 'base', 'opus', 'opus', 'medium'],
    ['integrator', { contested: true }, 'critical', 'opus', 'opus', 'high'],
    ['drift-check', {}, 'base', 'opus', 'opus', 'max'],
    ['arch-review', {}, 'base', 'opus', 'opus', 'medium'],
    ['arch-review', { contested: true }, 'critical', 'opus', 'opus', 'max'],
    ['arch-review', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'ceiling', 'fable', 'fable', 'medium'],
    ['ci-fix', {}, 'base', 'opus', 'opus', 'medium'],
    ['review-fix', {}, 'base', 'opus', 'opus', 'medium'],
  ];
  for (const [role, signals, rung, modelKey, model, effort] of cases) {
    const result = claude(role, signals);
    assert.deepStrictEqual(
      [result.logical_rung, result.model_key, result.logical_model, result.model, result.effort],
      [rung, modelKey, modelKey, model, effort],
      `${role}/${JSON.stringify(signals)}`,
    );
    assert.equal(result.backend, 'workflow');
    assert.equal(result.mechanism, 'workflow-explicit-selection');
    assert.deepStrictEqual(result.launch_arguments, { model, effort });
  }
  assert.deepStrictEqual(policy.CLAUDE_MODEL_ALIASES, {
    sonnet: 'sonnet',
    opus: 'opus',
    fable: 'fable',
  });
  assert.equal(runtimeAdapters.modelFor('codex', 'sonnet'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'terra'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'sol'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'luna'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'astra'), undefined);
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.codex.executor[0], {
    name: 'base', model_key: 'luna', logical_model: 'luna', effort: 'max',
  });
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.claude.executor[0], {
    name: 'base', model_key: 'sonnet', effort: 'max',
  });
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.claude.research, [
    { name: 'base', model_key: 'opus', effort: 'medium' },
    { name: 'very-complex', model_key: 'opus', effort: 'max' },
  ]);
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.claude.decomposition[1], {
    name: 'critical', model_key: 'opus', effort: 'max',
  });
});

test('Codex research promotes only explicit very-complex and retains inert alternatives evidence', () => {
  const result = codex('research', {
    type: 'alternatives',
    complexity: 'very-complex',
  });
  assert.equal(result.logical_rung, 'very-complex');
  assert.equal(result.model, 'gpt-6-astra');
  assert.deepStrictEqual(result.signals_fired, ['type', 'very-complex']);
  assert.deepStrictEqual(result.selected_signals.map((item) => item.signal), ['very-complex']);
  assert.equal(result.signal_reasons.length, 2);
  assert.equal(result.signal_reasons.find((item) => item.signal === 'type').applies, false);
  assert.equal(result.signal_reasons.find((item) => item.signal === 'very-complex').applies, true);
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
    assert.equal(riskOnly.model, 'gpt-6-astra');
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

test('signal provenance does not leak one critical condition into another signal', () => {
  const result = codex('decomposition', {
    checkpoint: true,
    contested: true,
    inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
  });
  assert.equal(result.logical_rung, 'critical');
  assert.deepStrictEqual(result.selected_signals.map((item) => item.signal), ['checkpoint']);
  assert.ok(result.signal_reasons.some((item) => item.signal === 'contested' && item.applies === false));
  assert.ok(result.signal_reasons.some((item) => item.signal === 'window' && item.applies === false));
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

test('executor keeps Luna/max by default and escalates to Astra/low on explicit critical evidence', () => {
  const base = codex('executor', { risk: 'high', inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 });
  assert.equal(base.logical_rung, 'base');
  assert.equal(base.logical_model, 'luna');
  assert.equal(base.model, 'gpt-5.6-luna');
  assert.equal(base.effort, 'max');
  assert.ok(base.signal_reasons.some((item) => item.signal === 'risk' && item.applies === false));
  assert.ok(base.signal_reasons.some((item) => item.signal === 'window' && item.applies === false));

  for (const signal of ['critical', 'checkpoint']) {
    const result = codex('executor', { [signal]: true });
    assert.equal(result.logical_rung, 'critical', signal);
    assert.equal(result.logical_model, 'astra', signal);
    assert.equal(result.model, 'gpt-6-astra', signal);
    assert.equal(result.effort, 'low', signal);
    assert.ok(result.signal_reasons.some((item) => item.signal === signal && item.applies === true));
  }
});

test('fixed Luna roles ignore global risk, critical, checkpoint, and window promotion', () => {
  const expected = {
    'pr-sentinel': ['luna', 'gpt-5.6-luna'],
    'drift-check': ['luna', 'gpt-5.6-luna'],
  };
  for (const [role, [logicalModel, concreteModel]] of Object.entries(expected)) {
    const result = codex(role, {
      risk: 'high',
      critical: true,
      checkpoint: true,
      inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
    });
    assert.equal(result.logical_rung, 'base', role);
    assert.equal(result.logical_model, logicalModel, role);
    assert.equal(result.model, concreteModel, role);
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
    () => policy.resolveDispatch({ runtime: 'codex', role: ' ci-fix ', signals: { signatureState: 'repeat' } }),
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
    () => codex('executor', {}, { override: { model: 'gpt-6-astra' } }),
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
    () => policy.resolveDispatch({
      runtime: 'codex',
      role: 'executor',
      dispatchId: 'camel-dispatch-id',
    }),
    (error) => error.code === 'UNSUPPORTED_SELECTION' && /dispatch_id/.test(error.message),
  );
  assert.throws(
    () => policy.resolveDispatch({
      runtime: 'codex',
      role: 'executor',
      dispatch_id: 'snake-dispatch-id',
      dispatchId: 'camel-dispatch-id',
    }),
    (error) => error.code === 'UNSUPPORTED_SELECTION' && /dispatch_id/.test(error.message),
  );
  assert.throws(
    () => policy.resolveDispatch({
      runtime: 'codex',
      role: 'executor',
      model: 'gpt-5.6-luna',
      requested_model: 'gpt-6-astra',
    }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => policy.resolveDispatch({
      runtime: 'codex',
      role: 'executor',
      effort: 'max',
      requested_effort: 'low',
    }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', override: { runtime: 'claude' } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  for (const [field, value] of [
    ['logical_model', 'astra'],
    ['logical_rung', 'critical'],
    ['rung', 'critical'],
    ['rung_index', 1],
  ]) {
    assert.throws(
      () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', [field]: value }),
      (error) => error.code === 'CONFLICTING_OVERRIDE',
      `top-level ${field} override must be rejected when it disagrees with the base executor route`,
    );
  }
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
  assert.equal(policy.resolveDispatch({ runtime: 'codex', role: 'executor', signals: { critical: true } }).logical_rung, 'critical');
});

test('resolution is immutable and exposes route, backend, mechanism, and reason provenance', () => {
  const result = codex('executor', { risk: 'high' });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.signals_fired));
  assert.ok(Object.isFrozen(result.signal_reasons));
  assert.equal(result.backend, 'agent');
  assert.equal(result.mechanism, 'explicit-launch-arguments');
  assert.match(result.route, /role=executor/);
  assert.match(result.route, /rung=base/);
  assert.match(result.signal_reasons.find((item) => item.signal === 'risk').reason, /inert|not a role-scoped/);
});

test('resolution validation covers rung index and every signal-reason field', () => {
  const valid = codex('integrator', { critical: true }, { dispatch_id: 'validation-contract' });
  assert.throws(
    () => policy.validateResolution({ ...valid, rung_index: 0 }),
    (error) => error.code === 'INVALID_RESOLUTION',
  );
  const forgedReasons = valid.signal_reasons.map((reason, index) => (
    index === 0 ? { ...reason, applies: !reason.applies } : { ...reason }
  ));
  assert.throws(
    () => policy.validateResolution({ ...valid, signal_reasons: forgedReasons }),
    (error) => error.code === 'INVALID_RESOLUTION',
  );
});

test('direct repair resolution does not accept caller-owned receipt evidence', () => {
  const priorApplied = priorReceipt('ci-fix', 'gpt-5.6-luna', 'max', 'luna-owned-by-caller');
  assert.equal(Object.isFrozen(priorApplied), false);
  assert.throws(
    () => codex('ci-fix', { signatureState: 'repeat', priorApplied }, { previous_dispatch_id: 'luna-owned-by-caller' }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('internal resolver rejects a receipt-shaped copy without durable boundary identity', () => {
  const priorApplied = priorReceipt('ci-fix', 'gpt-5.6-luna', 'max', 'forged-internal-receipt');
  assert.throws(
    () => canonicalInternalPolicy.resolveDispatch({
      runtime: 'codex',
      role: 'ci-fix',
      signals: { signatureState: 'repeat', priorApplied },
      previous_dispatch_id: priorApplied.dispatch_id,
    }),
    (error) => error.code === 'UNVERIFIED_RECEIPT' && /durable dispatch boundary/.test(error.message),
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

test('runtime catalog and internal CLI reject inherited or receipt-free selections', () => {
  assert.equal(runtimeAdapters.modelFor('codex', 'toString'), undefined);
  assert.equal(runtimeAdapters.adapterForRuntime('toString'), null);
  const internalPolicy = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'model-policy-internal.cjs');
  const repair = spawnSync(process.execPath, [
    internalPolicy,
    'resolve',
    JSON.stringify({ runtime: 'codex', role: 'ci-fix', signals: { signatureState: 'repeat' } }),
  ], { encoding: 'utf8' });
  assert.notEqual(repair.status, 0);
  assert.match(repair.stderr, /usage/);
  assert.throws(
    () => canonicalInternalPolicy.resolveDispatch({ runtime: 'codex', role: 'ci-fix', signals: { signatureState: 'repeat' } }),
    (error) => error.code === 'MISSING_RECEIPT',
  );
});

test('canonical policy ignores caller mutation attempts against runtime adapter exports', () => {
  const originalAdapterForRuntime = runtimeAdapters.adapterForRuntime;
  const originalCodexLuna = runtimeAdapters.CODEX_MODEL_IDS.luna;
  try {
    runtimeAdapters.adapterForRuntime = () => ({ modelFor: () => 'caller-controlled-model' });
    runtimeAdapters.CODEX_MODEL_IDS.luna = 'caller-controlled-model';
  } catch (error) {
    // Frozen compatibility exports are the expected protection.
  }
  const result = codex('executor');
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(runtimeAdapters.adapterForRuntime, originalAdapterForRuntime);
  assert.equal(runtimeAdapters.CODEX_MODEL_IDS.luna, originalCodexLuna);
});

test('exhaustive runtime matrix covers every native base tuple and scoped escalation rung', () => {
  const base = {
    codex: {
      research: ['gpt-6-astra', 'low'],
      decomposition: ['gpt-6-astra', 'low'],
      executor: ['gpt-5.6-luna', 'max'],
      'pr-sentinel': ['gpt-5.6-luna', 'medium'],
      integrator: ['gpt-6-astra', 'low'],
      'drift-check': ['gpt-5.6-luna', 'max'],
      'arch-review': ['gpt-6-astra', 'low'],
      'ci-fix': ['gpt-5.6-luna', 'max'],
      'review-fix': ['gpt-5.6-luna', 'max'],
    },
    claude: {
      research: ['sonnet', 'high'],
      decomposition: ['opus', 'medium'],
      executor: ['sonnet', 'max'],
      'pr-sentinel': ['sonnet', 'high'],
      integrator: ['opus', 'medium'],
      'drift-check': ['opus', 'max'],
      'arch-review': ['opus', 'medium'],
      'ci-fix': ['opus', 'medium'],
      'review-fix': ['opus', 'medium'],
    },
  };
  const escalations = [
    ['codex', 'research', { type: 'alternatives' }, 'base', 'gpt-6-astra', 'low'],
    ['codex', 'research', { complexity: 'very-complex' }, 'very-complex', 'gpt-6-astra', 'medium'],
    ['codex', 'decomposition', { critical: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'decomposition', { checkpoint: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'executor', { critical: true }, 'critical', 'gpt-6-astra', 'low'],
    ['codex', 'executor', { checkpoint: true }, 'critical', 'gpt-6-astra', 'low'],
    ['codex', 'integrator', { critical: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'integrator', { checkpoint: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'integrator', { contested: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'integrator', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'arch-review', { critical: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'arch-review', { checkpoint: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'arch-review', { contested: true }, 'critical', 'gpt-6-astra', 'medium'],
    ['codex', 'arch-review', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'critical', 'gpt-6-astra', 'medium'],
    ['claude', 'research', { type: 'alternatives' }, 'alternatives', 'opus', 'medium'],
    ['claude', 'research', { complexity: 'very-complex' }, 'very-complex', 'fable', 'medium'],
    ['claude', 'decomposition', { critical: true }, 'critical', 'fable', 'medium'],
    ['claude', 'decomposition', { checkpoint: true }, 'critical', 'fable', 'medium'],
    ['claude', 'executor', { critical: true }, 'critical', 'opus', 'high'],
    ['claude', 'executor', { checkpoint: true }, 'critical', 'opus', 'high'],
    ['claude', 'integrator', { critical: true }, 'critical', 'opus', 'high'],
    ['claude', 'integrator', { checkpoint: true }, 'critical', 'opus', 'high'],
    ['claude', 'integrator', { contested: true }, 'critical', 'opus', 'high'],
    ['claude', 'integrator', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'critical', 'opus', 'high'],
    ['claude', 'arch-review', { critical: true }, 'critical', 'opus', 'max'],
    ['claude', 'arch-review', { checkpoint: true }, 'critical', 'opus', 'max'],
    ['claude', 'arch-review', { contested: true }, 'critical', 'opus', 'max'],
    ['claude', 'arch-review', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'ceiling', 'fable', 'medium'],
  ];

  for (const runtime of policy.SUPPORTED_RUNTIMES) {
    for (const role of policy.ROLES) {
      const result = policy.resolveDispatch({ runtime, role, signals: {} });
      assert.deepStrictEqual(
        [result.logical_rung, result.model, result.effort],
        ['base', ...base[runtime][role]],
        `${runtime}/${role} base`,
      );
      assert.deepStrictEqual(result.selected_signals, [], `${runtime}/${role} base has no selected signal`);
    }
  }

  for (const [runtime, role, signals, rung, model, effort] of escalations) {
    const result = policy.resolveDispatch({ runtime, role, signals });
    assert.deepStrictEqual(
      [result.logical_rung, result.model, result.effort],
      [rung, model, effort],
      `${runtime}/${role}/${JSON.stringify(signals)}`,
    );
    for (const source of Object.keys(signals)) {
      const signal = source === 'inputTokens' ? 'window'
        : source === 'type' && runtime === 'claude' && signals[source] === 'alternatives' ? 'alternatives'
          : source === 'complexity' && signals[source] === 'very-complex' ? 'very-complex' : source;
      assert.ok(result.signals_fired.includes(signal), `${runtime}/${role} retains ${source}`);
      const reason = result.signal_reasons.find((item) => item.source === `signals.${source}`);
      assert.ok(reason, `${runtime}/${role} explains ${source}`);
      assert.equal(
        result.selected_signals.some((selected) => selected.signal === signal),
        reason.applies,
        `${runtime}/${role} selects ${source} only when it applies`,
      );
    }
  }
});

test('combined signals retain every reason while the highest authorized rung wins', () => {
  const cases = [
    {
      runtime: 'codex',
      role: 'research',
      signals: { type: 'alternatives', complexity: 'very-complex' },
      rung: 'very-complex',
      selected: ['very-complex'],
      inert: ['type'],
    },
    {
      runtime: 'claude',
      role: 'research',
      signals: { type: 'alternatives', complexity: 'very-complex' },
      rung: 'very-complex',
      selected: ['alternatives', 'very-complex'],
      inert: [],
    },
    {
      runtime: 'codex',
      role: 'integrator',
      signals: {
        risk: 'high',
        critical: true,
        checkpoint: true,
        contested: true,
        inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
      },
      rung: 'critical',
      selected: ['critical', 'checkpoint', 'contested', 'window'],
      inert: ['risk'],
    },
    {
      runtime: 'claude',
      role: 'arch-review',
      signals: {
        risk: 'high',
        critical: true,
        checkpoint: true,
        contested: true,
        inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
      },
      rung: 'ceiling',
      selected: ['critical', 'checkpoint', 'contested', 'window'],
      inert: ['risk'],
    },
  ];
  for (const item of cases) {
    const result = policy.resolveDispatch(item);
    assert.equal(result.logical_rung, item.rung, `${item.runtime}/${item.role} highest rung`);
    for (const source of Object.keys(item.signals)) {
      assert.ok(
        result.signal_reasons.some((reason) => reason.source === `signals.${source}`),
        `${item.runtime}/${item.role} retains ${source} reason`,
      );
    }
    assert.deepStrictEqual(
      result.selected_signals.map((selected) => selected.signal),
      item.selected,
      `${item.runtime}/${item.role} selected signals`,
    );
    for (const signal of item.inert) {
      assert.ok(result.signal_reasons.some((reason) => reason.signal === signal && reason.applies === false), `${signal} remains inert`);
    }
    assert.equal(new Set(result.signals_fired).size, result.signals_fired.length, 'signal names are not silently duplicated');
    assert.equal(result.signal_reasons.length, Object.keys(item.signals).length, 'no supplied signal is omitted');
  }
});

test('global promotion cannot move fixed native roles off their base tuple', () => {
  const signals = {
    risk: 'high',
    critical: true,
    checkpoint: true,
    contested: true,
    inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
  };
  for (const [runtime, expected] of [
    ['codex', { 'pr-sentinel': ['gpt-5.6-luna', 'medium'], 'drift-check': ['gpt-5.6-luna', 'max'] }],
    ['claude', { 'pr-sentinel': ['sonnet', 'high'], 'drift-check': ['opus', 'max'] }],
  ]) {
    for (const [role, [model, effort]] of Object.entries(expected)) {
      const result = policy.resolveDispatch({ runtime, role, signals });
      assert.deepStrictEqual([result.logical_rung, result.model, result.effort], ['base', model, effort], `${runtime}/${role}`);
      assert.deepStrictEqual(result.selected_signals, [], `${runtime}/${role} has no global promotion`);
      assert.equal(result.signal_reasons.length, Object.keys(signals).length, `${runtime}/${role} keeps all global context`);
      assert.ok(result.signal_reasons.every((reason) => reason.applies === false), `${runtime}/${role} has no selected global reason`);
    }
  }
});

test('all override sources reject conflicting, unsupported, inline, and inherited selections', () => {
  for (const [runtime, expected] of [
    ['codex', { model: 'gpt-5.6-luna', otherModel: 'gpt-6-astra', effort: 'max', otherEffort: 'low' }],
    ['claude', { model: 'sonnet', otherModel: 'opus', effort: 'max', otherEffort: 'high' }],
  ]) {
    const base = { runtime, role: 'executor', signals: {} };
    for (const [source, value] of [
      ['override', { model: expected.otherModel }],
      ['overrides', { effort: expected.otherEffort }],
      ['selection', { runtime: runtime === 'codex' ? 'claude' : 'codex' }],
      ['launch_arguments', { model: 'unsupported-model' }],
      ['gsdOverride', { effort: 'unsupported-effort' }],
      ['perRoleOverride', { model: expected.otherModel }],
      ['configOverride', { effort: expected.otherEffort }],
    ]) {
      assert.throws(
        () => policy.resolveDispatch({ ...base, [source]: value }),
        (error) => error.code === 'CONFLICTING_OVERRIDE',
        `${runtime}/${source} must not bypass the resolver`,
      );
    }
    for (const config of [
      { runtime: runtime === 'codex' ? 'claude' : 'codex' },
      { models: { executor: expected.otherModel } },
      { effort: { executor: expected.otherEffort } },
      { model_policy: { models: { executor: 'unsupported-model' } } },
    ]) {
      assert.throws(
        () => policy.resolveDispatch({ ...base, config }),
        (error) => error.code === 'CONFLICTING_OVERRIDE',
        `${runtime}/config override must not bypass the resolver`,
      );
    }
    for (const selection of [
      { inline: true },
      { inherit: true },
      { session_inherited: true },
    ]) {
      assert.throws(
        () => policy.resolveDispatch({ ...base, selection }),
        (error) => error.code === 'UNSUPPORTED_SELECTION',
        `${runtime}/implicit selection must be refused`,
      );
    }
    assert.deepStrictEqual(
      [policy.resolveDispatch({ ...base, model: expected.model, effort: expected.effort }).model,
        policy.resolveDispatch({ ...base, model: expected.model, effort: expected.effort }).effort],
      [expected.model, expected.effort],
      `${runtime}/matching explicit values remain harmless`,
    );
  }
});

test('stale policy fingerprints and versions cannot validate an otherwise shaped resolution', () => {
  for (const runtime of policy.SUPPORTED_RUNTIMES) {
    const valid = policy.resolveDispatch({ runtime, role: 'executor', signals: {} });
    for (const stale of [
      { policy_hash: '0'.repeat(64) },
      { policy_version: 'adr-014.stale' },
    ]) {
      assert.throws(
        () => policy.validateResolution({ ...valid, ...stale }),
        (error) => error.code === 'STALE_POLICY',
        `${runtime}/${JSON.stringify(stale)} must fail before launch`,
      );
    }
  }
});

done();
