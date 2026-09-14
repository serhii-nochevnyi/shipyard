'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins/delivery-pipeline/scripts/codex-agent.cjs');
const { selectAgent, parseArgs, signalsFrom, projectDirFrom } = require(SCRIPT);
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createCodexRemapper, readProjectConfig } = require('../../plugins/delivery-pipeline/scripts/codex-model-remap.cjs');

const capabilities = {
  supportedModels: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra'],
  supportedEfforts: ['high', 'medium', 'max'], cliVersion: '0.200.0',
};
function fixture(raw = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-codex-agent-'));
  const agentDir = path.join(root, 'agents');
  fs.mkdirSync(path.join(root, '.planning'));
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(root, '.planning/config.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(root, 'capabilities.json'), JSON.stringify(capabilities));
  const manifest = { policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION,
    policy_hash: policy.POLICY_HASH, agent_files: [], agent_digests: {} };
  for (const [role, signals] of [['research', {}], ['research', { type: 'alternatives' }], ['arch-review', {}], ['arch-review', { critical: true }]]) {
    const r = policy.resolveDispatch({ runtime: 'codex', role, signals });
    const text = [
      '# shipyard-policy-id = "ADR-014"',
      '# shipyard-policy-version = "' + r.policy_version + '"',
      '# shipyard-policy-hash = "' + r.policy_hash + '"',
      '# shipyard-policy-runtime = "codex"',
      '# shipyard-policy-role = "' + role + '"',
      '# shipyard-policy-rung = "' + r.rung + '"',
      'name = "' + r.agent_file.replace(/\.toml$/, '') + '"',
      'model = "' + r.model + '"',
      'model_reasoning_effort = "' + r.effort + '"',
      "developer_instructions = '''\nRole body\n'''\n",
    ].join('\n');
    fs.writeFileSync(path.join(agentDir, r.agent_file), text);
    manifest.agent_files.push(r.agent_file);
    manifest.agent_digests[r.agent_file] = crypto.createHash('sha256').update(text).digest('hex');
  }
  fs.writeFileSync(path.join(agentDir, '.shipyard-manifest.json'), JSON.stringify(manifest));
  return { root, agentDir, options: { cwd: root, agentDir, capabilities, env: {} } };
}
function clean(f) { fs.rmSync(f.root, { recursive: true, force: true }); }

suite('strict Codex selector and named model palette');

test('static selections expose exact policy filename, identity, model and effort', () => {
  const f = fixture();
  try {
    const r = selectAgent('inv-research', f.options);
    assert.equal(r.role, 'research');
    assert.equal(r.agent_file, 'shipyard-inv-research.toml');
    assert.equal(r.agent_path, path.join(f.agentDir, r.agent_file));
    assert.equal(r.model, 'gpt-5.6-terra');
    assert.equal(r.effort, 'high');
    assert.equal(r.policy_hash, policy.POLICY_HASH);
    assert.match(r.agent_file_digest, /^[a-f0-9]{64}$/);
    assert.equal(r.fallback, undefined);
    assert.ok(Object.isFrozen(r));
  } finally { clean(f); }
});

test('dynamic executor and decomposition always expose both explicit arguments', () => {
  const f = fixture();
  try {
    for (const [role, model, effort] of [['executor', 'gpt-5.6-luna', 'max'], ['decomposition', 'gpt-5.6-sol', 'medium']]) {
      const r = selectAgent(role, f.options);
      assert.equal(r.agent_file, null);
      assert.equal(r.agent_path, null);
      assert.deepEqual(r.launch_arguments, { model, reasoning_effort: effort });
      const critical = selectAgent(role, { ...f.options, signals: { critical: true } });
      assert.deepEqual(critical.launch_arguments, { model: 'gpt-6-astra', reasoning_effort: 'medium' });
    }
  } finally { clean(f); }
});

test('risk and context pressure cannot promote an executor without explicit critical/checkpoint evidence', () => {
  const f = fixture();
  try {
    const r = selectAgent('executor', { ...f.options, signals: { risk: 'high', inputTokens: 300000 } });
    assert.equal(r.model, 'gpt-5.6-luna');
    assert.equal(r.effort, 'max');
  } finally { clean(f); }
});

test('missing escalation file refuses instead of selecting the existing ordinary file', () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.agentDir, 'shipyard-arch-review-critical.toml'));
    assert.throws(() => selectAgent('arch-review', { ...f.options, signals: { critical: true } }),
      /exact generated file.*install-shipyard-codex/);
  } finally { clean(f); }
});

test('unverified repair escalation cannot be manufactured by the selector', () => {
  const f = fixture();
  try {
    assert.throws(() => selectAgent('ci-fix', { ...f.options, signals: { signatureState: 'repeat' } }),
      (error) => error.code === 'MISSING_RECEIPT');
  } finally { clean(f); }
});

for (const raw of [
  { pipeline: { models: { executor: 'gpt-5.6-terra' } } },
  { delivery_pipeline: { effort: { executor: 'high' } } },
  { model_overrides: { 'gsd-executor': 'gpt-5.6-terra' } },
  { model_policy: { runtime_tiers: { codex: { luna: 'gpt-6-astra' } } } },
  { model_profile_overrides: { codex: { sonnet: 'gpt-5.6-luna' } } },
  { model_policy: { runtime_tiers: { codex: { luna: { model: 'gpt-5.6-luna', effort: 'medium' } } } } },
  { delivery_pipeline: { codex_models: [] } },
  { delivery_pipeline: { codex_models: [{ model: 'gpt-5.6-terra' }] } },
  { delivery_pipeline: { codex_models: [{ model: 'gpt-5.6-luna', effort: 'high' }] } },
]) {
  test('configuration conflicts are not normalized away: ' + JSON.stringify(raw), () => {
    const f = fixture(raw);
    try {
      assert.throws(() => selectAgent('executor', f.options), (error) => error.code === 'CONFLICTING_OVERRIDE');
    } finally { clean(f); }
  });
}

test('matching named configuration is an assertion, independent of palette order', () => {
  const f = fixture({
    model_policy: { runtime_tiers: { codex: { luna: 'gpt-5.6-luna' } } },
    model_profile_overrides: { codex: { luna: 'gpt-5.6-luna' } },
    delivery_pipeline: { codex_models: [{ model: 'gpt-6-astra' }, { model: 'gpt-5.6-luna' }] },
  });
  try {
    assert.equal(selectAgent('executor', f.options).model, 'gpt-5.6-luna');
    assert.equal(selectAgent('executor', { ...f.options, signals: { checkpoint: true } }).model, 'gpt-6-astra');
  } finally { clean(f); }
});

test('a matching remap cannot hide a contradictory lower-precedence remap', () => {
  const f = fixture({
    model_policy: { runtime_tiers: { codex: { luna: 'gpt-5.6-luna' } } },
    model_profile_overrides: { codex: { luna: 'gpt-6-astra' } },
  });
  try {
    assert.throws(() => selectAgent('executor', f.options), /model_profile_overrides.codex.luna contradicts/);
  } finally { clean(f); }
});

test('model, effort and inheritance overrides cannot replace canonical launch arguments', () => {
  const f = fixture();
  try {
    for (const override of [
      { model: 'gpt-5.6-terra' }, { reasoning_effort: 'high' }, { inherit: true },
      { session: { model: 'gpt-6-astra' } },
      { launch_arguments: { model: 'gpt-5.6-luna', reasoning_effort: 'medium' } },
    ]) assert.throws(() => selectAgent('executor', { ...f.options, ...override }));
  } finally { clean(f); }
});

test('unknown or old CLI version refuses the requested model instead of falling back', () => {
  const f = fixture({ delivery_pipeline: { codex_models: [
    { model: 'gpt-5.6-luna' }, { model: 'gpt-6-astra', min_cli: '0.153.1' },
  ] } });
  try {
    for (const cliVersion of [undefined, '0.100.0', '0.999.0-local']) {
      assert.throws(() => selectAgent('executor', {
        ...f.options, capabilities: { ...capabilities, cliVersion }, signals: { critical: true },
      }), /requires Codex CLI 0.153.1/);
    }
    assert.equal(selectAgent('executor', { ...f.options, signals: { critical: true } }).model, 'gpt-6-astra');
  } finally { clean(f); }
});

test('availability is mandatory for static and dynamic selections', () => {
  const f = fixture();
  try {
    for (const role of ['research', 'executor']) {
      assert.throws(() => selectAgent(role, { ...f.options, capabilities: undefined }), /capabilities-file/);
      assert.throws(() => selectAgent(role, { ...f.options, capabilities: { ...capabilities, supportedModels: [] } }), /explicitly support/);
    }
  } finally { clean(f); }
});

test('malformed project config does not fall through to defaults or the GSD catalog', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, '.planning/config.json'), '{broken');
    assert.throws(() => selectAgent('executor', f.options), (error) => error.code === 'INVALID_CONFIG');
    assert.throws(() => readProjectConfig(f.root), /cannot read project model configuration/);
    assert.throws(() => createCodexRemapper({ cwd: f.root }), /cannot read project model configuration/);
  } finally { clean(f); }
});

test('named remapper exposes exactly the canonical palette without loading GSD', () => {
  const f = fixture();
  try {
    const remap = createCodexRemapper({ cwd: f.root, codexHome: '/nonexistent-gsd' });
    assert.equal(remap('terra'), 'gpt-5.6-terra');
    assert.equal(remap('sol'), 'gpt-5.6-sol');
    assert.equal(remap('luna'), 'gpt-5.6-luna');
    assert.equal(remap('astra'), 'gpt-6-astra');
    for (const key of ['sonnet', 'unknown', '', undefined]) assert.throws(() => remap(key), /unknown named Codex model/);
  } finally { clean(f); }
});

test('CLI accepts canonical signals and refuses obsolete fallback-era inputs', () => {
  const parsed = parseArgs(['select', 'research', '--type', 'alternatives', '--complexity', 'very-complex', '--critical']);
  assert.deepEqual(signalsFrom(parsed.flags), { type: 'alternatives', complexity: 'very-complex', critical: true });
  assert.deepEqual(signalsFrom(new Map()), {});
  for (const args of [['--attempt', '2'], ['--task-level', 'critical'], ['--critical', '--critical'], ['--complexity']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.throws(() => signalsFrom(new Map([['risk', 'urgent']])));
  assert.equal(projectDirFrom(new Map([['project-dir', '/tmp/project']])), '/tmp/project');
});

test('CLI plain and JSON output both preserve explicit dynamic model and effort', () => {
  const f = fixture();
  try {
    for (const flags of [[], ['--json']]) {
      const result = spawnSync(process.execPath, [SCRIPT, 'select', 'executor',
        '--project-dir', f.root, '--capabilities-file', path.join(f.root, 'capabilities.json'), ...flags],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GSD_RUNTIME: 'codex' } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).launch_arguments, { model: 'gpt-5.6-luna', reasoning_effort: 'max' });
    }
    const refused = spawnSync(process.execPath, [SCRIPT, 'select', 'executor', '--project-dir', f.root],
      { encoding: 'utf8', env: { ...process.env, GSD_RUNTIME: 'codex' } });
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /capabilities-file/);
  } finally { clean(f); }
});

done();
