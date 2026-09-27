'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { claudeGsdAgentDirectory, installedGsdPluginRoot } = require('../../plugins/delivery-pipeline/scripts/gsd-agent-root.cjs');
const { trustedAgent } = require('../../plugins/delivery-pipeline/scripts/claude-decompose-host.cjs');

function agent(role) {
  return `---\nname: ${role}\ndescription: Test agent\ntools: Bash, Read\n---\nUse @~/.claude/gsd-core/references/required.md\n`;
}

function config({ legacy = false, plugin = true, installPath } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-root-')));
  const pluginRoot = path.join(root, 'plugins', 'cache', 'gsd-core', 'gsd-core', '1.14.0');
  fs.mkdirSync(path.join(root, 'gsd-core', 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gsd-core', 'references', 'required.md'), 'Required GSD instruction.\n');
  if (legacy) {
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'gsd-planner.md'), agent('gsd-planner').replace('Test agent', 'Legacy agent'));
  }
  if (plugin) {
    fs.mkdirSync(path.join(pluginRoot, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'agents', 'gsd-planner.md'), agent('gsd-planner'));
    fs.writeFileSync(path.join(root, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'gsd-core@gsd-core': [{ scope: 'user', installPath: installPath || pluginRoot, version: '1.14.0' }] },
    }));
  }
  return { root, pluginRoot, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a marketplace-only GSD install supplies the Claude agent definition', () => {
  const f = config();
  try {
    assert.equal(installedGsdPluginRoot(f.root), f.pluginRoot);
    assert.equal(claudeGsdAgentDirectory(f.root, 'gsd-planner'), path.join(f.pluginRoot, 'agents'));
    const prompt = trustedAgent('gsd-planner', f.root);
    assert.match(prompt, /name: gsd-planner/);
    assert.match(prompt, /Required GSD instruction/);
  } finally { f.clean(); }
});

test('a legacy <config>/agents definition still wins over the plugin', () => {
  const f = config({ legacy: true });
  try {
    assert.equal(claudeGsdAgentDirectory(f.root, 'gsd-planner'), path.join(f.root, 'agents'));
    assert.match(trustedAgent('gsd-planner', f.root), /Legacy agent/);
  } finally { f.clean(); }
});

test('an installPath outside <config>/plugins/cache is not trusted', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-outside-')));
  fs.mkdirSync(path.join(outside, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'agents', 'gsd-planner.md'), agent('gsd-planner'));
  const f = config({ installPath: outside });
  try {
    assert.equal(installedGsdPluginRoot(f.root), null);
    assert.equal(claudeGsdAgentDirectory(f.root, 'gsd-planner'), path.join(f.root, 'agents'));
    assert.throws(() => trustedAgent('gsd-planner', f.root));
  } finally { f.clean(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('no legacy copy and no installed plugin refuses', () => {
  const f = config({ plugin: false });
  try {
    assert.equal(claudeGsdAgentDirectory(f.root, 'gsd-planner'), path.join(f.root, 'agents'));
    assert.throws(() => trustedAgent('gsd-planner', f.root));
  } finally { f.clean(); }
});

test('a zero-padded GSD phase directory resolves for a single-digit phase', () => {
  const { phaseDirectory } = require('../../plugins/delivery-pipeline/scripts/claude-decompose-host.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-phase-dir-')));
  try {
    fs.mkdirSync(path.join(root, '.planning', 'phases', '01-greeting-formats'), { recursive: true });
    fs.mkdirSync(path.join(root, '.planning', 'phases', '10-other'), { recursive: true });
    assert.equal(phaseDirectory(root, 1), path.join(root, '.planning', 'phases', '01-greeting-formats'));
    assert.equal(phaseDirectory(root, 10), path.join(root, '.planning', 'phases', '10-other'));
    assert.throws(() => phaseDirectory(root, 2), { code: 'PHASE_DIRECTORY_MISSING' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a GSD phase slug in plan frontmatter resolves to its phase number for host scopes', () => {
  const { phaseNumber } = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  assert.equal(phaseNumber('01-greeting-formats'), 1);
  assert.equal(phaseNumber('40'), 40);
  assert.equal(phaseNumber(7), 7);
  assert.throws(() => phaseNumber('greeting'), { code: 'INVALID_PHASE' });
  assert.throws(() => phaseNumber('0-zero'), { code: 'INVALID_PHASE' });
});

test('the Claude executor request built by deliver-dispatch carries the routed model and effort', () => {
  const { buildClaudeExecutorRequest } = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const calls = [];
  const request = buildClaudeExecutorRequest({
    id: 'T-01-01', row: { branch: 'feat/01-01', pr_base: 'feat/greeting-formats', phase: '01-greeting-formats', risk: 'low' },
    worktreePath: '/tmp/wt', planPath: '/tmp/plan.md', planSha256: 'a'.repeat(64), packet: {}, hygiene: false,
    projectRoot: '/tmp/project',
    resolve: (input) => { calls.push(input); return { model: 'sonnet', effort: 'max' }; },
  });
  const entry = request.args.tickets[0];
  assert.equal(entry.model, 'sonnet');
  assert.equal(entry.effort, 'max');
  assert.equal(request.scope.phase, 1);
  assert.deepEqual(calls, [{ root: '/tmp/project', runtime: 'claude', role: 'executor', signals: { risk: 'low' } }]);
});

test('the Codex executor request built by deliver-dispatch carries a task prompt the host accepts', () => {
  const { buildCodexExecutorRequest } = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const codexHost = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const request = buildCodexExecutorRequest({ id: 'T-01-01', row: { title: 'Add styles', phase: '01-greeting-formats', risk: 'low' },
    worktreePath: '/tmp/wt', planSha256: 'a'.repeat(64) });
  assert.match(request.context.prompt, /Implement ticket T-01-01 \(Add styles\)/);
  assert.equal(request.scope.phase, 1);
  codexHost.validateArgs({ role: request.role, signals: request.signals, context: request.context });
});
