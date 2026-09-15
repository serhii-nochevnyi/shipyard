'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createDispatchBoundary } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createCodexDispatchAdapter, CODEX_MODEL_IDS } = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');

const capabilities = {
  supportedModels: Object.values(CODEX_MODEL_IDS), supportedEfforts: ['high', 'medium', 'max'],
  observedModel: false, observedEffort: false,
};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-codex-adapter-'));
  const manifest = { policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION,
    policy_hash: policy.POLICY_HASH, agent_files: [], agent_digests: {} };
  for (const role of policy.CODEX_STATIC_ROLES) {
    for (const rung of policy.CODEX_ROLE_RUNG_DEFINITIONS[role]) {
      const file = policy.codexAgentFile(role, rung.name);
      const content = [
        '# shipyard-policy-id = "' + policy.POLICY.id + '"',
        '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
        '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
        '# shipyard-policy-runtime = "codex"',
        '# shipyard-policy-role = "' + role + '"',
        '# shipyard-policy-rung = "' + rung.name + '"',
        'name = "' + file.replace(/\.toml$/, '') + '"',
        'model = "' + CODEX_MODEL_IDS[rung.model_key] + '"',
        'model_reasoning_effort = "' + rung.effort + '"',
        "developer_instructions = '''\nRun the exact role.\n'''\n",
      ].join('\n');
      fs.writeFileSync(path.join(root, file), content);
      manifest.agent_files.push(file);
      manifest.agent_digests[file] = crypto.createHash('sha256').update(content).digest('hex');
    }
  }
  fs.writeFileSync(path.join(root, '.shipyard-manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}
function applied(selection, extra = {}) {
  return {
    launch_id: crypto.randomUUID(), applied_model: selection.model,
    applied_effort: selection.reasoning_effort,
    ...(selection.agent_file ? { agent_file_digest: selection.agent_file_digest } : {}),
    ...extra,
  };
}
function setup(extra = {}) {
  const f = fixture();
  const calls = [];
  const host = {
    capabilities,
    launch: (selection) => { calls.push(selection); return applied(selection); },
    launchStatic: (selection) => { calls.push(selection); return applied(selection); },
    ...(extra.host || {}),
  };
  const adapter = createCodexDispatchAdapter({ agentsDir: f.root, ...extra, host });
  const boundary = createDispatchBoundary({ adapters: { codex: adapter }, recorder: () => true });
  return { ...f, calls, adapter, boundary };
}
function clean(f) { fs.rmSync(f.root, { recursive: true, force: true }); }
function rejected(fn, code) {
  assert.throws(fn, (error) => error.code === code && /install-shipyard-codex/.test(error.message));
}

suite('strict Codex adapter — canonical launches and application evidence');

test('all base roles receive explicit ADR-014 selections', () => {
  const f = setup();
  const expected = {
    research: ['gpt-5.6-terra', 'high'], decomposition: ['gpt-5.6-sol', 'medium'],
    executor: ['gpt-5.6-luna', 'max'], 'pr-sentinel': ['gpt-5.6-luna', 'medium'],
    integrator: ['gpt-5.6-sol', 'medium'], 'drift-check': ['gpt-5.6-luna', 'max'],
    'arch-review': ['gpt-5.6-sol', 'medium'], 'ci-fix': ['gpt-5.6-luna', 'max'],
    'review-fix': ['gpt-5.6-luna', 'max'],
  };
  try {
    for (const [role, [model, effort]] of Object.entries(expected)) {
      const result = f.boundary.dispatch({ runtime: 'codex', role });
      const launch = f.calls.at(-1);
      assert.equal(launch.model, model);
      assert.equal(launch.reasoning_effort, effort);
      assert.equal(result.applied_model, model);
      assert.equal(result.applied_effort, effort);
      assert.equal(result.observed_model, 'unknown');
      assert.equal(result.receipt.compliance, 'verified');
      assert.ok(Object.isFrozen(launch));
      if (policy.DYNAMIC_ROLES.includes(role)) {
        assert.deepEqual(Object.keys(launch).sort(), ['model', 'reasoning_effort']);
      } else {
        assert.ok(launch.agent_file_content.includes('Run the exact role.'));
        assert.equal(result.receipt.agent_file_digest, f.manifest.agent_digests[launch.agent_file]);
      }
    }
  } finally { clean(f); }
});

test('research, dynamic and judgement escalation use exact canonical files/arguments', () => {
  const f = setup();
  try {
    for (const [role, signals, model, suffix] of [
      ['research', { type: 'alternatives' }, 'gpt-5.6-sol', '-alternatives.toml'],
      ['research', { complexity: 'very-complex' }, 'gpt-6-astra', '-critical.toml'],
      ['executor', { critical: true }, 'gpt-6-astra', null],
      ['decomposition', { checkpoint: true }, 'gpt-6-astra', null],
      ['integrator', { contested: true }, 'gpt-6-astra', '-critical.toml'],
      ['arch-review', { inputTokens: 250001 }, 'gpt-6-astra', '-critical.toml'],
    ]) {
      const result = f.boundary.dispatch({ runtime: 'codex', role, signals });
      assert.equal(result.applied_model, model);
      assert.equal(result.applied_effort, 'medium');
      if (suffix) assert.ok(f.calls.at(-1).agent_file.endsWith(suffix));
    }
  } finally { clean(f); }
});

test('repair escalation consumes boundary-verified predecessor receipts through all three rungs', () => {
  const f = setup();
  try {
    for (const role of ['ci-fix', 'review-fix']) {
      const base = f.boundary.dispatch({ runtime: 'codex', role });
      const repeat = f.boundary.dispatch({ runtime: 'codex', role, previous_dispatch_id: base.dispatch_id, signals: { signatureState: 'repeat', priorApplied: base.receipt } });
      const deep = f.boundary.dispatch({ runtime: 'codex', role, previous_dispatch_id: repeat.dispatch_id, signals: { signatureState: 'repeat_exhausted', priorApplied: repeat.receipt } });
      assert.equal(repeat.applied_model, 'gpt-5.6-sol');
      assert.equal(deep.applied_model, 'gpt-6-astra');
      assert.equal(deep.applied_effort, 'medium');
    }
  } finally { clean(f); }
});

for (const [name, mutate] of [
  ['missing variant', (f, file) => fs.unlinkSync(path.join(f.root, file))],
  ['missing manifest', (f) => fs.unlinkSync(path.join(f.root, '.shipyard-manifest.json'))],
  ['legacy manifest', (f) => { delete f.manifest.policy_hash; }],
  ['stale manifest', (f) => { f.manifest.policy_version = 'old'; }],
  ['missing digest', (f) => { delete f.manifest.agent_digests; }],
  ['unregistered file', (f, file) => { f.manifest.agent_files = f.manifest.agent_files.filter((entry) => entry !== file); }],
  ['tampered body', (f, file) => fs.appendFileSync(path.join(f.root, file), '# tampered\n')],
  ['wrong file identity', (f, file) => fs.writeFileSync(path.join(f.root, file), fs.readFileSync(path.join(f.root, file), 'utf8').replace('shipyard-arch-review-critical"', 'shipyard-arch-review"'))],
]) {
  test(name + ' refuses before launching, even with an ordinary file present', () => {
    const f = setup();
    try {
      const file = 'shipyard-arch-review-critical.toml';
      mutate(f, file);
      if (!['missing manifest', 'tampered body', 'wrong file identity', 'missing variant'].includes(name)) {
        fs.writeFileSync(path.join(f.root, '.shipyard-manifest.json'), JSON.stringify(f.manifest));
      }
      rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'arch-review', signals: { critical: true } }), 'STALE_GENERATED_AGENT');
      assert.equal(f.calls.length, 0);
    } finally { clean(f); }
  });
}

for (const [name, change] of [
  ['duplicate model', (text) => text.replace('developer_instructions', 'model = "gpt-5.6-terra"\ndeveloper_instructions')],
  ['nested model table', (text) => text.replace('model = ', '[other]\nmodel = ')],
  ['model only inside instructions', (text) => text.replace('model = "gpt-5.6-sol"\n', '').replace('Run the exact role.', 'model = "gpt-5.6-sol"')],
  ['policy only inside instructions', (text) => text.replace('# shipyard-policy-role = "arch-review"\n', '').replace('Run the exact role.', '# shipyard-policy-role = "arch-review"')],
  ['duplicate policy comment', (text) => '# shipyard-policy-role = "arch-review"\n' + text],
  ['configuration after instructions', (text) => text + 'model = "gpt-5.6-terra"\n'],
]) {
  test(name + ' cannot spoof static identity even with an updated digest', () => {
    const f = setup();
    try {
      const file = 'shipyard-arch-review.toml';
      const text = change(fs.readFileSync(path.join(f.root, file), 'utf8'));
      fs.writeFileSync(path.join(f.root, file), text);
      f.manifest.agent_digests[file] = crypto.createHash('sha256').update(text).digest('hex');
      fs.writeFileSync(path.join(f.root, '.shipyard-manifest.json'), JSON.stringify(f.manifest));
      rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'arch-review' }), 'STALE_GENERATED_AGENT');
      assert.equal(f.calls.length, 0);
    } finally { clean(f); }
  });
}

test('unavailable model, effort or pair never selects a lower tuple', () => {
  for (const advertised of [
    {}, { ...capabilities, supportedModels: ['gpt-5.6-terra'] },
    { ...capabilities, supportedEfforts: ['high'] },
    { ...capabilities, supportedSelections: [{ model: 'gpt-5.6-luna', effort: 'medium' }] },
  ]) {
    const f = setup({ capabilities: advertised });
    try {
      rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'executor' }), 'UNSUPPORTED_SELECTION');
      assert.equal(f.calls.length, 0);
    } finally { clean(f); }
  }
});

test('a dynamic remap records canonical requested values beside the applied model', () => {
  const model = 'vendor/codex-runtime-model';
  const f = setup({
    capabilities: { ...capabilities, supportedModels: [...capabilities.supportedModels, model] },
  });
  try {
    const resolution = f.boundary.resolve({ runtime: 'codex', role: 'decomposition' });
    const selected = { ...resolution, effective_model: model };
    const result = f.adapter.launch(selected);
    assert.equal(f.calls.at(-1).model, model);
    assert.equal(f.calls.at(-1).reasoning_effort, 'medium');
    assert.equal(result.requested_model, resolution.requested_model);
    assert.equal(result.requested_effort, resolution.requested_effort);
    assert.equal(result.applied_model, model);
    assert.equal(result.applied_effort, 'medium');
  } finally { clean(f); }
});

test('a forged outer model cannot borrow a canonical resolution without an explicit remap', () => {
  const f = setup();
  try {
    const resolution = f.boundary.resolve({ runtime: 'codex', role: 'executor' });
    const forged = { ...resolution, model: 'gpt-6-astra' };
    Object.defineProperty(forged, 'canonical_resolution', { value: resolution });
    rejected(() => f.adapter.launch(forged), 'CONFLICTING_OVERRIDE');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('an explicit remap beside a canonical resolution preserves requested and applied receipt values', () => {
  const f = setup();
  try {
    const resolution = f.boundary.resolve({ runtime: 'codex', role: 'decomposition' });
    const remapped = { ...resolution, model: 'gpt-6-astra', effective_model: 'gpt-6-astra' };
    Object.defineProperty(remapped, 'canonical_resolution', { value: resolution });
    const result = f.adapter.launch(remapped);
    assert.equal(f.calls.at(-1).model, 'gpt-6-astra');
    assert.equal(f.calls.at(-1).reasoning_effort, resolution.effort);
    assert.equal(result.requested_model, resolution.requested_model);
    assert.equal(result.requested_effort, resolution.requested_effort);
    assert.equal(result.applied_model, 'gpt-6-astra');
    assert.equal(result.applied_effort, resolution.effort);
  } finally { clean(f); }
});

test('static generated evidence cannot be bypassed by an effective remap', () => {
  const model = 'vendor/codex-static-model';
  const f = setup({
    capabilities: { ...capabilities, supportedModels: [...capabilities.supportedModels, model] },
  });
  try {
    const resolution = f.boundary.resolve({ runtime: 'codex', role: 'research' });
    assert.throws(() => f.adapter.validate({ ...resolution, effective_model: model }),
      (error) => error.code === 'CONFLICTING_OVERRIDE' && /static Codex selections/.test(error.message));
  } finally { clean(f); }
});

test('missing native launch method refuses without any ordinary-agent fallback', () => {
  const f = setup({ host: { launch: undefined } });
  try {
    rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'executor' }), 'MISSING_ADAPTER');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('launch context cannot override explicit selection or request inheritance', () => {
  const f = setup();
  try {
    for (const context of [
      { model: 'gpt-5.6-terra' }, { reasoning_effort: 'medium' },
      { launch_arguments: { model: 'gpt-6-astra' } }, { session: { inherit: true } },
    ]) {
      assert.throws(() => f.boundary.dispatch({ runtime: 'codex', role: 'executor' }, context),
        /launch context.*install-shipyard-codex/);
    }
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('forged or stale resolutions are rejected before the host is called', () => {
  const f = setup();
  try {
    const r = f.boundary.resolve({ runtime: 'codex', role: 'executor' });
    for (const change of [
      { policy_hash: 'old' }, { model: 'gpt-6-astra' },
      { launch_arguments: { model: 'gpt-5.6-luna' } },
    ]) assert.throws(() => f.adapter.launch({ ...r, ...change }));
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a successful exit or requested values alone cannot produce application evidence', () => {
  for (const response of [{ status: 0 }, { launch_id: 'ok', requested_model: 'gpt-5.6-luna', requested_effort: 'max' }]) {
    const f = setup({ host: { launch: () => response } });
    try {
      rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'executor' }), 'MISSING_RECEIPT');
    } finally { clean(f); }
  }
});

test('host downgrade and effort mismatch are refused instead of copying requested values', () => {
  for (const extra of [{ applied_model: 'gpt-5.6-terra' }, { applied_effort: 'medium' }]) {
    const f = setup({ host: { launch: (selection) => applied(selection, extra) } });
    try {
      rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'executor' }), 'NONCOMPLIANT_RECEIPT');
    } finally { clean(f); }
  }
});

test('static application must attest the exact content digest', () => {
  const f = setup({ host: { launchStatic: (selection) => applied(selection, { agent_file_digest: '0'.repeat(64) }) } });
  try {
    rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'research' }), 'NONCOMPLIANT_RECEIPT');
  } finally { clean(f); }
});

test('static handoff is mandatory and revalidated immediately before launch', () => {
  const f = setup();
  try {
    const resolution = f.boundary.resolve({ runtime: 'codex', role: 'research' });
    const evidence = f.adapter.validateGeneratedAgent(resolution);
    const selected = { ...resolution, agent_file_digest: evidence.agent_file_digest };
    rejected(() => f.adapter.launchStatic(selected, {}), 'STALE_GENERATED_AGENT');
    fs.appendFileSync(path.join(f.root, resolution.agent_file), '# changed\n');
    rejected(() => f.adapter.launchStatic(selected, {}, evidence), 'STALE_GENERATED_AGENT');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('host receives validated immutable content even if it replaces the on-disk file', () => {
  const f = setup({ host: { launchStatic: (selection) => {
    assert.ok(Object.isFrozen(selection));
    fs.writeFileSync(path.join(f.root, selection.agent_file), 'changed after handoff');
    return applied(selection);
  } } });
  try {
    const result = f.boundary.dispatch({ runtime: 'codex', role: 'research' });
    assert.equal(result.receipt.agent_file_digest, f.manifest.agent_digests['shipyard-inv-research.toml']);
  } finally { clean(f); }
});

test('observations cannot be unknown unless the host explicitly declares them unavailable', () => {
  const f = setup({ capabilities: { ...capabilities, observedModel: true } });
  try {
    rejected(() => f.boundary.dispatch({ runtime: 'codex', role: 'executor' }), 'NONCOMPLIANT_RECEIPT');
  } finally { clean(f); }
});

test('asynchronous native application evidence is verified and recorded', async () => {
  const f = setup({ host: { launch: async (selection) => applied(selection) } });
  try {
    const result = await f.boundary.dispatch({ runtime: 'codex', role: 'executor' });
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.applied_effort, 'max');
  } finally { clean(f); }
});

done();
