'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { transcriptEvidence } = require('./claude-test-evidence.cjs');
const { ROLES, canonicalRequest, inlineReferences, trustedAgent, parseArguments, runDecomposition } = require('../../plugins/delivery-pipeline/scripts/claude-decompose-host.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-decompose-host-'));
  const worktree = path.join(root, 'project');
  const config = path.join(root, 'claude');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(config, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(config, 'gsd-core', 'references'), { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  for (const role of Object.keys(ROLES)) {
    fs.writeFileSync(path.join(config, 'agents', `${role}.md`),
      `---\nname: ${role}\ndescription: Test agent\ntools: Bash, Read, Edit, Write, Glob, Grep\nmodel: claude-sonnet-5\neffort: xhigh\n---\nUse @gsd-core/references/required.md\n`);
  }
  fs.writeFileSync(path.join(config, 'gsd-core', 'references', 'required.md'), 'Required GSD instruction.\n');
  return { root, worktree, config, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function request(worktree, role) {
  return { phase: 38, worktree, role, prompt: 'Create the phase plan.' };
}

test('accepts exactly three canonical typed roles and rejects injected request authority', () => {
  const f = fixture();
  try {
    for (const role of Object.keys(ROLES)) {
      const scope = canonicalRequest(request(f.worktree, role));
      assert.equal(scope.ticket, 'T-38-DECOMPOSE');
      assert.equal(scope.role, role);
      assert.equal(scope.worktree, fs.realpathSync(f.worktree));
    }
    assert.equal(canonicalRequest({ ...request(f.worktree, 'gsd-planner'),
      prompt: 'Read CONTEXT.md\nPlan the phase.\n' }).prompt,
    'Read CONTEXT.md\nPlan the phase.\n');
    assert.throws(() => canonicalRequest(request(f.worktree, 'claude')), { code: 'UNSUPPORTED_ROLE' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), model: 'sonnet' }), { code: 'INVALID_INPUT' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), effort: 'low' }), { code: 'INVALID_INPUT' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), agentFile: '/tmp/evil' }), { code: 'INVALID_INPUT' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), signals: { critical: 'true' } }), { code: 'INVALID_SIGNAL' });
    assert.deepEqual(parseArguments(['--capability-only']), { capabilityOnly: true });
    assert.throws(() => parseArguments(['--host-module', 'evil.js']), { code: 'INVALID_INPUT' });
  } finally { f.clean(); }
});

test('inlines only bounded trusted GSD references and refuses missing or symlinked sources', () => {
  const f = fixture();
  try {
    const prompt = trustedAgent('gsd-planner', f.config);
    assert.match(prompt, /Required GSD instruction/);
    assert.doesNotMatch(prompt, /@gsd-core\/references\/required\.md/);
    assert.throws(() => inlineReferences('@gsd-core/references/../secrets.md', path.join(f.config, 'gsd-core')), { code: 'REFERENCE_UNAVAILABLE' });
    fs.rmSync(path.join(f.config, 'gsd-core', 'references', 'required.md'));
    fs.symlinkSync('/etc/hosts', path.join(f.config, 'gsd-core', 'references', 'required.md'));
    assert.throws(() => trustedAgent('gsd-planner', f.config), { code: 'REFERENCE_UNAVAILABLE' });
  } finally { f.clean(); }
});

test('removes inert source model and effort fields before building the explicit typed agent', () => {
  const f = fixture();
  try {
    for (const role of Object.keys(ROLES)) {
      const agent = trustedAgent(role, f.config);
      assert.doesNotMatch(agent, /^model:/m);
      assert.doesNotMatch(agent, /^effort:/m);
      assert.match(agent, new RegExp(`name: ${role}`));
      assert.match(agent, /Required GSD instruction/);
    }
  } finally { f.clean(); }
});

test('routes each role through the boundary and durably records exact-role evidence', async () => {
  const f = fixture();
  try {
    for (const role of Object.keys(ROLES)) {
      const calls = [];
      const output = await runDecomposition(request(f.worktree, role), {
        configRoot: f.config,
        store: path.join(f.root, `store-${role}`),
        resolveDispatch: ({ runtime, role: boundaryRole, dispatch_id }) => ({
          runtime, role: boundaryRole, dispatch_id, model: 'claude-opus-5-5', effort: 'medium',
        }),
        probe: () => ({ status: 'available', executable: 'claude', runtime_version: 'test' }),
        runtimeHostFactory: ({ recorder, controller, scope, gsdAgentRoot }) => ({
          recorder, controller, scope,
          capabilities: { supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true },
          typedGsdCallback: async (prompt, options, launchedRole) => {
            const agent = fs.readFileSync(path.join(gsdAgentRoot, `${launchedRole}.md`), 'utf8');
            assert.doesNotMatch(agent, /^(model|effort):/m);
            calls.push({ prompt, options, launchedRole, gsdAgentRoot });
            return transcriptEvidence({
              launch_id: `launch-${launchedRole}`, applied_model: options.model,
              applied_effort: options.effort, observed_model: options.model,
              observed_effort: options.effort, gsd_role: launchedRole,
              gsd_launch_mechanism: options.gsd_launch_mechanism,
            });
          },
          applicationEvidence: ({ result }) => result,
        }),
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].launchedRole, role);
      assert.equal(calls[0].options.model, 'claude-opus-5-5');
      assert.equal(calls[0].options.effort, 'medium');
      assert.equal(output.receipt.compliance, 'verified');
      assert.equal(output.receipt.gsd_role, role);
      assert.equal(output.receipt.applied_model, 'claude-opus-5-5');
      assert.equal(output.receipt.applied_effort, 'medium');
      assert.equal(fs.existsSync(calls[0].gsdAgentRoot), false);
      const files = fs.readdirSync(path.join(f.root, `store-${role}`, 'receipts'));
      assert.ok(files.some((file) => file.startsWith('record-')));
      const state = JSON.parse(fs.readFileSync(path.join(f.root, `store-${role}`, 'runs', 'runs.json'), 'utf8'));
      assert.equal(state.runs[output.run_id].run.state, 'completed');
    }
  } finally { f.clean(); }
});

test('executable entrypoint rejects unsupported role before invoking Claude', () => {
  const f = fixture();
  try {
    const input = path.join(f.root, 'request.json');
    fs.writeFileSync(input, JSON.stringify(request(f.worktree, 'general-purpose')));
    const result = require('node:child_process').spawnSync(process.execPath,
      ['plugins/delivery-pipeline/scripts/claude-decompose-host.cjs', '--request-file', input],
      { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNSUPPORTED_ROLE/);
    assert.equal(result.stdout, '');
  } finally { f.clean(); }
});

test('refuses missing, wrong, or cross-session typed role evidence', async () => {
  const f = fixture();
  try {
    for (const invalid of [
      (evidence) => { delete evidence.gsd_agent_evidence; },
      (evidence) => { evidence.gsd_agent_evidence.session_start_agent_type = 'gsd-planner'; },
      (evidence) => { evidence.gsd_agent_evidence.transcript_agent_setting = 'gsd-planner'; },
      (evidence) => { evidence.gsd_agent_evidence.session_id = 'other-session'; },
      (evidence) => { evidence.observed_effort = 'high'; },
      (evidence) => { evidence.applied_effort = 'high'; },
      (evidence) => { evidence.observed_model = 'claude-sonnet-5'; },
    ]) {
      const store = path.join(f.root, `invalid-${crypto.randomUUID()}`);
      await assert.rejects(runDecomposition(request(f.worktree, 'gsd-plan-checker'), {
        configRoot: f.config, store,
        resolveDispatch: ({ runtime, role, dispatch_id }) => ({ runtime, role, dispatch_id,
          model: 'claude-opus-5-5', effort: 'medium' }),
        probe: () => ({ status: 'available' }),
        runtimeHostFactory: ({ recorder }) => ({
          recorder,
          capabilities: { supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true },
          typedGsdCallback: async (prompt, options, role) => {
            const evidence = transcriptEvidence({ launch_id: `launch-${crypto.randomUUID()}`,
              applied_model: options.model, applied_effort: options.effort,
              observed_model: options.model, observed_effort: options.effort,
              gsd_role: role, gsd_launch_mechanism: options.gsd_launch_mechanism });
            invalid(evidence);
            return evidence;
          },
          applicationEvidence: ({ result }) => result,
        }),
      }));
      const receiptFiles = fs.existsSync(path.join(store, 'receipts'))
        ? fs.readdirSync(path.join(store, 'receipts')).filter((file) => file.startsWith('record-')) : [];
      assert.equal(receiptFiles.length, 0);
    }
  } finally { f.clean(); }
});
