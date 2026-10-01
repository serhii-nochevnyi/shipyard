'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const canonicalInternalPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
const runtimeAdapters = require('../../plugins/delivery-pipeline/scripts/runtime-adapters.cjs');

const PRE_EDIT_PLANNING_CONFIG = JSON.parse(String.raw`
{
  "model_profile": "balanced",
  "commit_docs": true,
  "parallelization": true,
  "search_gitignored": false,
  "brave_search": false,
  "firecrawl": false,
  "exa_search": false,
  "tavily_search": false,
  "ref_search": false,
  "perplexity": false,
  "jina": false,
  "git": {
    "branching_strategy": "none",
    "create_tag": true,
    "phase_branch_template": "gsd/phase-{phase}-{slug}",
    "milestone_branch_template": "gsd/{milestone}-{slug}",
    "quick_branch_template": null
  },
  "workflow": {
    "research": true,
    "plan_check": true,
    "verifier": true,
    "nyquist_validation": true,
    "auto_advance": true,
    "node_repair": true,
    "node_repair_budget": 2,
    "ui_phase": true,
    "ui_safety_gate": true,
    "ai_integration_phase": true,
    "api_coverage_gate": true,
    "human_verify_mode": "end-of-phase",
    "context_guard_mode": "warn",
    "text_mode": false,
    "research_before_questions": false,
    "discuss_mode": "discuss",
    "skip_discuss": false,
    "code_review": true,
    "code_review_depth": "deep",
    "code_review_command": null,
    "pattern_mapper": true,
    "plan_bounce": false,
    "plan_bounce_script": null,
    "plan_bounce_passes": 2,
    "auto_prune_state": false,
    "post_planning_gaps": true,
    "security_enforcement": true,
    "security_asvs_level": 1,
    "security_block_on": "high",
    "tdd_mode": true,
    "ui_review": true,
    "use_worktrees": true
  },
  "ship": {
    "pr_body_sections": []
  },
  "hooks": {
    "context_warnings": true
  },
  "project_code": null,
  "phase_naming": "sequential",
  "agent_skills": {
    "gsd-executor": [
      ".shipyard/generated/gsd-delivery-rules"
    ],
    "gsd-planner": [
      ".shipyard/generated/gsd-delivery-rules"
    ]
  },
  "claude_md_path": "./.claude/CLAUDE.md",
  "plan_review": {
    "source_grounding": true,
    "source_grounding_authority": "grep"
  },
  "mode": "standard",
  "granularity": "standard",
  "intel": {
    "enabled": false
  },
  "graphify": {
    "enabled": false
  },
  "resolve_model_ids": "omit",
  "models": {
    "planning": "opus",
    "execution": "opus",
    "research": "sonnet",
    "verification": "sonnet"
  },
  "effort": {
    "routing_tier_defaults": {
      "light": "low",
      "standard": "high",
      "heavy": "xhigh"
    },
    "agent_overrides": {
      "gsd-code-reviewer": "xhigh"
    }
  },
  "model_overrides": {
    "gsd-code-reviewer": "opus"
  },
  "delivery_pipeline": {
    "max_concurrent_agents": 4,
    "model_ladder": "adaptive",
    "gsd_sync": true
  },
  "pipeline": {
    "jira": {
      "enabled": false
    }
  }
}
`);

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
  research: ['sol', 'gpt-6.1-sol', 'high'],
  decomposition: ['sol', 'gpt-6.1-sol', 'high'],
  executor: ['sol', 'gpt-6.1-sol', 'low'],
  'pr-sentinel': ['luna', 'gpt-6-luna', 'medium'],
  integrator: ['sol', 'gpt-6.1-sol', 'high'],
  'drift-check': ['sol', 'gpt-6.1-sol', 'low'],
  'arch-review': ['sol', 'gpt-6.1-sol', 'high'],
  'ci-fix': ['sol', 'gpt-6.1-sol', 'low'],
  'review-fix': ['sol', 'gpt-6.1-sol', 'low'],
};

suite('ADR-014 canonical policy');

test('exposes exactly the nine routed roles and the concrete Codex palette', () => {
  assert.deepStrictEqual([...policy.ROLES], Object.keys(CODEx_BASE));
  assert.deepStrictEqual(policy.CODEX_MODEL_IDS, {
    luna: 'gpt-6-luna',
    astra: 'gpt-6-astra',
    sol: 'gpt-6.1-sol',
  });
  assert.deepStrictEqual(policy.CLAUDE_MODEL_ALIASES, {
    sonnet: 'claude-sonnet-5-5',
    opus: 'claude-opus-5-5',
    fable: 'fable',
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
  const alteredClaudeRung = JSON.parse(JSON.stringify(policy.POLICY));
  alteredClaudeRung.role_rungs.claude.executor[0].effort = 'low';
  assert.notEqual(policy.fingerprintPolicy(alteredClaudeRung), policy.POLICY_HASH);
  const alteredClaudeSignal = JSON.parse(JSON.stringify(policy.POLICY));
  alteredClaudeSignal.runtime_signal_rules.claude.executor.critical.any.push({ contested: true });
  assert.notEqual(policy.fingerprintPolicy(alteredClaudeSignal), policy.POLICY_HASH);
  const alteredClaudePredecessor = JSON.parse(JSON.stringify(policy.POLICY));
  alteredClaudePredecessor.runtime_repair_prerequisites.claude['ci-fix'].repeat.model = 'wrong-predecessor';
  assert.notEqual(policy.fingerprintPolicy(alteredClaudePredecessor), policy.POLICY_HASH);
  assert.notEqual(policy.POLICY_HASH, '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968');
});

test('ordinary executor requests resolve through the canonical resolver with fresh native identities', () => {
  for (const [runtime, resolve, model, effort] of [
    ['codex', codex, 'gpt-6.1-sol', 'low'],
    ['claude', claude, 'claude-sonnet-5-5', 'medium'],
  ]) {
    const result = resolve('executor');
    assert.deepStrictEqual(
      [result.runtime, result.logical_rung, result.model, result.requested_model, result.effort, result.requested_effort],
      [runtime, 'base', model, model, effort, effort],
    );
    assert.equal(result.policy_version, 'adr-014.v7');
    assert.equal(result.policy_hash, policy.fingerprintPolicy(policy.POLICY));
    assert.notEqual(result.policy_hash, '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968');
  }
});

test('reviewer compatibility config removes only the two copied reviewer overrides, excluding independently owned verification profiles', () => {
  const expected = JSON.parse(JSON.stringify(PRE_EDIT_PLANNING_CONFIG));
  delete expected.model_overrides['gsd-code-reviewer'];
  delete expected.effort.agent_overrides['gsd-code-reviewer'];
  const actual = JSON.parse(JSON.stringify(require('../../.planning/config.json')));
  assert.equal(Object.hasOwn(actual.model_overrides, 'gsd-code-reviewer'), false);
  assert.equal(Object.hasOwn(actual.effort.agent_overrides, 'gsd-code-reviewer'), false);
  delete actual.delivery_pipeline.verification_commands;
  assert.deepStrictEqual(actual, expected);
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

test('resolves Claude through its pinned native grid while preserving Fable window routing', () => {
  const cases = [
    ['research', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'xhigh'],
    ['research', { type: 'alternatives' }, 'base', 'sonnet', 'claude-sonnet-5-5', 'xhigh'],
    ['research', { complexity: 'very-complex' }, 'very-complex', 'opus', 'claude-opus-5-5', 'high'],
    ['decomposition', { checkpoint: true }, 'critical', 'opus', 'claude-opus-5-5', 'high'],
    ['decomposition', { critical: true }, 'critical', 'opus', 'claude-opus-5-5', 'high'],
    ['executor', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'medium'],
    ['executor', { critical: true }, 'critical', 'sonnet', 'claude-sonnet-5-5', 'xhigh'],
    ['pr-sentinel', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'low'],
    ['integrator', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'xhigh'],
    ['integrator', { contested: true }, 'critical', 'opus', 'claude-opus-5-5', 'high'],
    ['drift-check', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'medium'],
    ['arch-review', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'xhigh'],
    ['arch-review', { contested: true }, 'critical', 'opus', 'claude-opus-5-5', 'high'],
    ['arch-review', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'ceiling', 'fable', 'fable', 'medium'],
    ['ci-fix', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'high'],
    ['review-fix', {}, 'base', 'sonnet', 'claude-sonnet-5-5', 'high'],
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
    sonnet: 'claude-sonnet-5-5',
    opus: 'claude-opus-5-5',
    fable: 'fable',
  });
  assert.equal(runtimeAdapters.modelFor('codex', 'sonnet'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(runtimeAdapters.modelFor('claude', 'terra'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'sol'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'luna'), undefined);
  assert.equal(runtimeAdapters.modelFor('claude', 'astra'), undefined);
  assert.equal(runtimeAdapters.matchesModelObservation('claude', 'claude-sonnet-5-5', 'claude-sonnet-5-5'), true);
  assert.equal(runtimeAdapters.matchesModelObservation('claude', 'claude-sonnet-5-4', 'claude-sonnet-5-5'), false);
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.codex.executor[0], {
    name: 'base', model_key: 'sol', logical_model: 'sol', effort: 'low',
  });
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.claude.executor[0], {
    name: 'base', model_key: 'sonnet', effort: 'medium',
  });
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.claude.research, [
    { name: 'base', model_key: 'sonnet', effort: 'xhigh' },
    { name: 'very-complex', model_key: 'opus', effort: 'high' },
  ]);
  assert.deepStrictEqual(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.claude.decomposition[1], {
    name: 'critical', model_key: 'opus', effort: 'high',
  });
});

test('repair prerequisites bind every repair rung to its immediately preceding native pair', () => {
  for (const [runtime, expected] of [
    ['codex', {
      rungs: [
        ['base', 'sol', 'gpt-6.1-sol', 'low'],
        ['repeat', 'sol', 'gpt-6.1-sol', 'high'],
        ['repeat_exhausted', 'sol', 'gpt-6.1-sol', 'xhigh'],
      ],
    }],
    ['claude', {
      rungs: [
        ['base', 'sonnet', 'claude-sonnet-5-5', 'high'],
        ['repeat', 'sonnet', 'claude-sonnet-5-5', 'xhigh'],
        ['repeat_exhausted', 'opus', 'claude-opus-5-5', 'high'],
      ],
    }],
  ]) {
    for (const role of ['ci-fix', 'review-fix']) {
      const rungs = policy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime][role];
      assert.deepStrictEqual(
        rungs.map(({ name, model_key, effort }) => [name, model_key, policy[runtime === 'codex' ? 'CODEX_MODEL_IDS' : 'CLAUDE_MODEL_ALIASES'][model_key], effort]),
        expected.rungs,
        `${runtime}/${role} rung grid`,
      );
      for (const [index, [rung]] of expected.rungs.entries()) {
        if (index === 0) continue;
        const predecessor = policy.RUNTIME_REPAIR_PREREQUISITES[runtime][role][rung];
        assert.deepStrictEqual(
          [predecessor.model_key, predecessor.model, predecessor.effort],
          expected.rungs[index - 1].slice(1),
          `${runtime}/${role}/${rung}`,
        );
        assert.equal(
          policy.RUNTIME_ROLE_SIGNAL_RULES[runtime][role][rung].rung,
          rung,
          `${runtime}/${role}/${rung} remains signal-reachable`,
        );
        assert.deepStrictEqual(
          policy.RUNTIME_ROLE_SIGNAL_RULES[runtime][role][rung].any,
          [{ signatureState: rung }],
          `${runtime}/${role}/${rung} keeps its authenticated repair signal`,
        );
      }
    }
  }
});

test('Codex research promotes only explicit very-complex and retains inert alternatives evidence', () => {
  const result = codex('research', {
    type: 'alternatives',
    complexity: 'very-complex',
  });
  assert.equal(result.logical_rung, 'very-complex');
  assert.equal(result.model, 'gpt-6.1-sol');
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
      assert.equal(result.model, 'gpt-6.1-sol');
      assert.equal(result.effort, 'xhigh');
    }
    const riskOnly = codex(role, { risk: 'high' });
    assert.equal(riskOnly.logical_rung, 'base', `${role}/risk`);
    assert.equal(riskOnly.model, 'gpt-6.1-sol');
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

test('executor uses Sol/low by default and escalates to Sol/high on explicit critical evidence', () => {
  const base = codex('executor', { risk: 'high', inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 });
  assert.equal(base.logical_rung, 'base');
  assert.equal(base.logical_model, 'sol');
  assert.equal(base.model, 'gpt-6.1-sol');
  assert.equal(base.effort, 'low');
  assert.ok(base.signal_reasons.some((item) => item.signal === 'risk' && item.applies === false));
  assert.ok(base.signal_reasons.some((item) => item.signal === 'window' && item.applies === false));

  for (const signal of ['critical', 'checkpoint']) {
    const result = codex('executor', { [signal]: true });
    assert.equal(result.logical_rung, 'critical', signal);
    assert.equal(result.logical_model, 'sol', signal);
    assert.equal(result.model, 'gpt-6.1-sol', signal);
    assert.equal(result.effort, 'high', signal);
    assert.ok(result.signal_reasons.some((item) => item.signal === signal && item.applies === true));
  }
});

test('fixed roles ignore global risk, critical, checkpoint, and window promotion', () => {
  const expected = {
    'pr-sentinel': ['luna', 'gpt-6-luna', 'medium'],
    'drift-check': ['sol', 'gpt-6.1-sol', 'low'],
  };
  for (const [role, [logicalModel, concreteModel, effort]] of Object.entries(expected)) {
    const result = codex(role, {
      risk: 'high',
      critical: true,
      checkpoint: true,
      inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1,
    });
    assert.equal(result.logical_rung, 'base', role);
    assert.equal(result.logical_model, logicalModel, role);
    assert.equal(result.model, concreteModel, role);
    assert.equal(result.effort, effort, role);
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
  const prior = priorReceipt('ci-fix', 'gpt-6.1-sol', 'low', 'sol-low-1');
  assert.throws(
    () => codex('ci-fix', {
      signatureState: 'repeat',
      priorApplied: prior,
    }, { previous_dispatch_id: 'sol-low-1' }),
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
      priorApplied: prior,
    }, { previous_dispatch_id: 'sol-low-1' }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
  assert.throws(
    () => codex('ci-fix', {
      signatureState: 'repeat',
      priorApplied: { model: 'gpt-6.1-sol', effort: 'low', dispatchId: 'forged' },
    }, { previous_dispatch_id: 'forged' }),
    (error) => error.code === 'MISSING_RECEIPT' || error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('matching overrides are harmless but conflicting or unsupported selections fail closed', () => {
  const matching = codex('executor', {
    risk: 'high',
  }, {
    override: { model: 'gpt-6.1-sol', effort: 'low', runtime: 'codex' },
  });
  assert.deepStrictEqual([matching.model, matching.effort], ['gpt-6.1-sol', 'low']);
  assert.throws(
    () => codex('executor', {}, { override: { model: 'gpt-5.6-luna' } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => codex('executor', {}, { override: { model: 'gpt-6-astra' } }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => codex('executor', {}, { override: { effort: 'high' } }),
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
      model: 'gpt-6.1-sol',
      requested_model: 'gpt-6-astra',
    }),
    (error) => error.code === 'CONFLICTING_OVERRIDE',
  );
  assert.throws(
    () => policy.resolveDispatch({
      runtime: 'codex',
      role: 'executor',
      effort: 'low',
      requested_effort: 'high',
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
  const priorApplied = priorReceipt('ci-fix', 'gpt-6.1-sol', 'low', 'sol-low-owned-by-caller');
  assert.equal(Object.isFrozen(priorApplied), false);
  assert.throws(
    () => codex('ci-fix', { signatureState: 'repeat', priorApplied }, { previous_dispatch_id: 'sol-low-owned-by-caller' }),
    (error) => error.code === 'UNVERIFIED_RECEIPT',
  );
});

test('internal resolver rejects a receipt-shaped copy without durable boundary identity', () => {
  const priorApplied = priorReceipt('ci-fix', 'gpt-6.1-sol', 'low', 'forged-internal-receipt');
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
  const priorApplied = priorReceipt('ci-fix', 'gpt-6.1-sol', 'low', 'caller-forged');
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
  const originalCodexSol = runtimeAdapters.CODEX_MODEL_IDS.sol;
  try {
    runtimeAdapters.adapterForRuntime = () => ({ modelFor: () => 'caller-controlled-model' });
    runtimeAdapters.CODEX_MODEL_IDS.sol = 'caller-controlled-model';
  } catch (error) {
    // Frozen compatibility exports are the expected protection.
  }
  const result = codex('executor');
  assert.equal(result.model, 'gpt-6.1-sol');
  assert.equal(runtimeAdapters.adapterForRuntime, originalAdapterForRuntime);
  assert.equal(runtimeAdapters.CODEX_MODEL_IDS.sol, originalCodexSol);
});

test('exhaustive runtime matrix covers every native base tuple and scoped escalation rung', () => {
  const base = {
    codex: {
      research: ['gpt-6.1-sol', 'high'],
      decomposition: ['gpt-6.1-sol', 'high'],
      executor: ['gpt-6.1-sol', 'low'],
      'pr-sentinel': ['gpt-6-luna', 'medium'],
      integrator: ['gpt-6.1-sol', 'high'],
      'drift-check': ['gpt-6.1-sol', 'low'],
      'arch-review': ['gpt-6.1-sol', 'high'],
      'ci-fix': ['gpt-6.1-sol', 'low'],
      'review-fix': ['gpt-6.1-sol', 'low'],
    },
    claude: {
      research: ['claude-sonnet-5-5', 'xhigh'],
      decomposition: ['claude-sonnet-5-5', 'xhigh'],
      executor: ['claude-sonnet-5-5', 'medium'],
      'pr-sentinel': ['claude-sonnet-5-5', 'low'],
      integrator: ['claude-sonnet-5-5', 'xhigh'],
      'drift-check': ['claude-sonnet-5-5', 'medium'],
      'arch-review': ['claude-sonnet-5-5', 'xhigh'],
      'ci-fix': ['claude-sonnet-5-5', 'high'],
      'review-fix': ['claude-sonnet-5-5', 'high'],
    },
  };
  const escalations = [
    ['codex', 'research', { type: 'alternatives' }, 'base', 'gpt-6.1-sol', 'high'],
    ['codex', 'research', { complexity: 'very-complex' }, 'very-complex', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'decomposition', { critical: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'decomposition', { checkpoint: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'executor', { critical: true }, 'critical', 'gpt-6.1-sol', 'high'],
    ['codex', 'executor', { checkpoint: true }, 'critical', 'gpt-6.1-sol', 'high'],
    ['codex', 'integrator', { critical: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'integrator', { checkpoint: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'integrator', { contested: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'integrator', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'arch-review', { critical: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'arch-review', { checkpoint: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'arch-review', { contested: true }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['codex', 'arch-review', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'critical', 'gpt-6.1-sol', 'xhigh'],
    ['claude', 'research', { type: 'alternatives' }, 'base', 'claude-sonnet-5-5', 'xhigh'],
    ['claude', 'research', { complexity: 'very-complex' }, 'very-complex', 'claude-opus-5-5', 'high'],
    ['claude', 'decomposition', { critical: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'decomposition', { checkpoint: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'executor', { critical: true }, 'critical', 'claude-sonnet-5-5', 'xhigh'],
    ['claude', 'executor', { checkpoint: true }, 'critical', 'claude-sonnet-5-5', 'xhigh'],
    ['claude', 'integrator', { critical: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'integrator', { checkpoint: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'integrator', { contested: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'integrator', { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'arch-review', { critical: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'arch-review', { checkpoint: true }, 'critical', 'claude-opus-5-5', 'high'],
    ['claude', 'arch-review', { contested: true }, 'critical', 'claude-opus-5-5', 'high'],
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
      selected: ['very-complex'],
      inert: ['type'],
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
    ['codex', { 'pr-sentinel': ['gpt-6-luna', 'medium'], 'drift-check': ['gpt-6.1-sol', 'low'] }],
    ['claude', { 'pr-sentinel': ['claude-sonnet-5-5', 'low'], 'drift-check': ['claude-sonnet-5-5', 'medium'] }],
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
    ['codex', { model: 'gpt-6.1-sol', otherModel: 'gpt-6-astra', effort: 'low', otherEffort: 'high' }],
    ['claude', { model: 'claude-sonnet-5-5', otherModel: 'claude-opus-5-5', effort: 'medium', otherEffort: 'xhigh' }],
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
