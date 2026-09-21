#!/usr/bin/env bash
set -euo pipefail

# Hermetic installed-runtime contract. Only GSD conversion/capability registration
# and native host launches are fixtures; Shipyard generation, installation,
# adapters, validation and durable receipts are production code. The companion
# codex-shipyard smoke separately checks the official GSD converter.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node - "$ROOT" <<'NODE'
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = process.argv[2];
const source = path.join(root, 'plugins/delivery-pipeline');
const policy = require(path.join(source, 'scripts/model-policy.cjs'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ladder-smoke-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const snapshot = (dir) => fs.readdirSync(dir).sort().map((name) => {
  const file = path.join(dir, name);
  return [name, fs.statSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
});
try {
  const fixtureHome = path.join(work, 'home');
  const codexDir = path.join(fixtureHome, '.codex');
  const claudeDir = path.join(fixtureHome, '.claude');
  const project = path.join(work, 'project');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const cli of ['npx', 'npm', 'codex', 'claude', 'curl', 'wget']) {
    write(path.join(bin, cli), '#!/bin/sh\necho "unexpected external CLI" >&2\nexit 99\n');
    fs.chmodSync(path.join(bin, cli), 0o755);
  }
  const converter = path.join(codexDir, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  write(converter, 'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n');
  write(path.join(codexDir, 'gsd-core/bin/gsd-tools.cjs'), `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (args[0] !== 'capability' || args[1] !== 'install') process.exit(99);
fs.cpSync(args[2], path.join(process.env.GSD_CAPABILITIES_DIR, 'delivery-pipeline'), { recursive: true });
`);
  // Preserve the native Claude palette and an operator's provider settings,
  // including formatting. No real credentials or host configuration are read.
  fs.cpSync(source, path.join(claudeDir, 'plugins/shipyard'), { recursive: true });
  fs.copyFileSync(path.join(root, 'docker-compose.yml'), path.join(claudeDir, 'provider-compose.yml'));
  write(path.join(claudeDir, 'settings.json'), '{\n  "model": "sonnet",\n  "env": {"ANTHROPIC_BASE_URL": "https://provider.invalid", "ANTHROPIC_DEFAULT_OPUS_MODEL": "native-opus"}\n}\n');
  const claudeBefore = snapshot(claudeDir);
  const paletteBefore = fs.readFileSync(path.join(source, 'scripts/runtime-adapters.cjs'));
  assert.deepEqual(policy.CLAUDE_MODEL_ALIASES, { sonnet: 'sonnet', opus: 'opus', fable: 'fable' });
  const capabilities = {};
  for (const runtime of policy.SUPPORTED_RUNTIMES) {
    const models = runtime === 'codex' ? policy.CODEX_MODEL_IDS : policy.CLAUDE_MODEL_ALIASES;
    const pairs = Object.values(policy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime]).flat()
      .map((rung) => ({ model: models[rung.model_key], effort: rung.effort }));
    capabilities[runtime] = {
      supportedModels: [...new Set(pairs.map((pair) => pair.model))],
      supportedEfforts: [...new Set(pairs.map((pair) => pair.effort))], supportedSelections: pairs,
    };
  }
  const capabilitiesFile = path.join(work, 'capabilities.json');
  write(capabilitiesFile, JSON.stringify(capabilities.codex));
  const env = {
    HOME: fixtureHome, CODEX_HOME: codexDir, GSD_HOME: fixtureHome,
    PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    TMPDIR: work, LANG: 'C', SHIPYARD_GSD_AUTO_INSTALL: '0',
    SHIPYARD_CODEX_CAPABILITIES_FILE: capabilitiesFile,
    AGENTS_SKILLS_DIR: path.join(fixtureHome, '.agents/skills'),
    GSD_CAPABILITIES_DIR: path.join(fixtureHome, '.gsd/capabilities'),
    GSD_DEFAULTS_PATH: path.join(fixtureHome, '.gsd/defaults.json'),
    CODEX_AGENTS_MD: path.join(codexDir, 'AGENTS.md'),
  };
  const run = (command, args, overrides = {}) => spawnSync(command, args, {
    cwd: project, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 120000,
  });
  const installArgs = [path.join(root, 'scripts/install-shipyard-codex.sh'), '--phase', '2', '--project-dir', project];
  const installed = run('/bin/bash', installArgs);
  assert.equal(installed.status, 0, installed.stderr || String(installed.error));
  const bundle = path.join(codexDir, 'shipyard');
  const agentsDir = path.join(codexDir, 'agents');
  const manifestFile = path.join(agentsDir, '.shipyard-manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.policy_hash, policy.POLICY_HASH);
  assert.equal(manifest.policy_version, policy.POLICY_VERSION);
  assert.equal(manifest.gsd_lib_digest, hash(fs.readFileSync(converter)));
  assert.equal(require(path.join(bundle, 'scripts/model-policy.cjs')).POLICY_HASH, policy.POLICY_HASH);
  for (const [dir, digests] of [[agentsDir, manifest.agent_digests], [bundle, manifest.bundle_digests],
    [env.AGENTS_SKILLS_DIR, manifest.skill_file_digests]]) {
    assert.ok(Object.keys(digests).length > 0);
    for (const [file, digest] of Object.entries(digests)) assert.equal(hash(fs.readFileSync(path.join(dir, file))), digest, file);
  }
  assert.deepEqual(fs.readFileSync(path.join(bundle, manifest.capabilities_file)), fs.readFileSync(capabilitiesFile));
  const expectedFiles = policy.CODEX_STATIC_ROLES.flatMap((role) =>
    policy.CODEX_ROLE_RUNG_DEFINITIONS[role].map((rung) => policy.codexAgentFile(role, rung.name)));
  assert.deepEqual([...manifest.agent_files].sort(), expectedFiles.sort());
  const config = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  for (const file of expectedFiles) assert.ok(config.includes('[agents.' + file.replace(/\.toml$/, '') + ']'));

  // Exercise the same staged-bundle validator invoked by the installer.
  const stage = path.join(work, 'generated');
  const generated = run(process.execPath, [path.join(root, 'scripts/gen-codex-shipyard.cjs'),
    '--out', stage, '--codex-home', codexDir, '--project-dir', project, '--phase', '2']);
  assert.equal(generated.status, 0, generated.stderr);
  const validateArgs = [path.join(source, 'scripts/gsd-tune.cjs'), '--validate-codex-bundle', stage,
    '--codex-home', codexDir, '--phase', '2', '--capabilities', capabilitiesFile];
  assert.equal(run(process.execPath, validateArgs).status, 0);
  const stagedManifest = path.join(stage, 'manifest.json');
  const stale = JSON.parse(fs.readFileSync(stagedManifest));
  stale.policy_hash = 'stale-policy';
  write(stagedManifest, JSON.stringify(stale));
  const rejected = run(process.execPath, validateArgs);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr + rejected.stdout, /policy|stale/i);
  const destinationBefore = snapshot(codexDir);
  const incapable = path.join(work, 'incapable.json');
  write(incapable, '{"supportedModels":[],"supportedEfforts":[]}');
  const refusedInstall = run('/bin/bash', installArgs, { SHIPYARD_CODEX_CAPABILITIES_FILE: incapable });
  assert.notEqual(refusedInstall.status, 0);
  assert.match(refusedInstall.stderr + refusedInstall.stdout, /cannot apply required/);
  assert.deepEqual(snapshot(codexDir), destinationBefore, 'installer refusal is non-mutating');

  const installedScripts = path.join(bundle, 'scripts');
  const { createDispatchBoundary, createDurableRecorder } = require(path.join(installedScripts, 'dispatch-boundary.cjs'));
  const { createCodexDispatchAdapter } = require(path.join(installedScripts, 'codex-dispatch-adapter.cjs'));
  const { createClaudeDispatchAdapter } = require(path.join(claudeDir, 'plugins/shipyard/scripts/claude-dispatch-adapter.cjs'));
  // Each runtime uses its own installed boundary/policy instance so authenticated
  // repair provenance stays within the runtime that minted it.
  const claudeBoundary = require(path.join(claudeDir, 'plugins/shipyard/scripts/dispatch-boundary.cjs'));
  let launches = 0;
  let missingEvidence = false;
  const calls = [];
  const host = (runtime) => ({
    launch(selection) {
      launches++;
      const effort = runtime === 'codex' ? selection.reasoning_effort : selection.effort;
      assert.ok(selection.model && effort);
      assert.notEqual(selection.model, 'inherit');
      assert.notEqual(effort, 'inherit');
      calls.push({ runtime, model: selection.model, effort });
      if (missingEvidence) return undefined;
      return { launch_id: 'smoke-' + launches, applied_model: selection.model, applied_effort: effort,
        observed_model: selection.model, observed_effort: effort,
        ...(selection.agent_file_digest ? { agent_file_digest: selection.agent_file_digest } : {}) };
    },
    launchStatic(selection) {
      assert.equal(hash(selection.agent_file_content), selection.agent_file_digest);
      assert.ok(selection.agent_file_content.includes('model = ' + JSON.stringify(selection.model) + '\n'));
      assert.ok(selection.agent_file_content.includes('model_reasoning_effort = ' + JSON.stringify(selection.reasoning_effort) + '\n'));
      return this.launch(selection);
    },
  });
  const recorders = {
    codex: createDurableRecorder(path.join(work, 'codex-receipts')),
    claude: claudeBoundary.createDurableRecorder(path.join(work, 'claude-receipts')),
  };
  const boundaries = {
    codex: createDispatchBoundary({ recorder: recorders.codex, adapters: {
      codex: createCodexDispatchAdapter({ agentsDir, capabilities: capabilities.codex, host: host('codex') }),
    } }),
    claude: claudeBoundary.createDispatchBoundary({ recorder: recorders.claude, adapters: {
      claude: createClaudeDispatchAdapter({ capabilities: capabilities.claude, host: host('claude') }),
    } }),
  };
  const rungSignals = {
    base: {}, alternatives: { type: 'alternatives' }, 'very-complex': { complexity: 'very-complex' },
    critical: { critical: true }, ceiling: { inputTokens: policy.WINDOW_THRESHOLD_TOKENS + 1 },
    repeat: { signatureState: 'repeat' }, repeat_exhausted: { signatureState: 'repeat_exhausted' },
  };
  const smokeContext = { ticket: 'T-36-11-runtime-ladder-smoke' };
  let cases = 0;
  for (const runtime of policy.SUPPORTED_RUNTIMES) {
    const boundary = boundaries[runtime];
    const models = runtime === 'codex' ? policy.CODEX_MODEL_IDS : policy.CLAUDE_MODEL_ALIASES;
    for (const [role, rungs] of Object.entries(policy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime])) {
      let previous;
      for (const rung of rungs) {
        assert.ok(Object.hasOwn(rungSignals, rung.name), 'new rung needs an explicit smoke trigger');
        const repair = rung.name.startsWith('repeat');
        const result = boundary.dispatch({ runtime, role, dispatch_id: `${runtime}-${role}-${rung.name}`,
          signals: { ...rungSignals[rung.name], ...(repair ? { priorApplied: previous.receipt } : {}) },
          ...(repair ? { previous_dispatch_id: previous.dispatch_id } : {}),
        }, smokeContext);
        assert.deepEqual([result.resolution.logical_rung, result.applied_model, result.applied_effort],
          [rung.name, models[rung.model_key], rung.effort], `${runtime}/${role}/${rung.name}`);
        assert.deepEqual(calls.at(-1), { runtime, model: models[rung.model_key], effort: rung.effort });
        assert.equal(result.receipt.compliance, 'verified');
        assert.deepEqual(recorders[runtime].getVerifiedRecord(result.dispatch_id).receipt, result.receipt);
        assert.equal(boundary.reconcile(result.dispatch_id, smokeContext).applied_effort, rung.effort);
        previous = result;
        cases++;
      }
    }
    const expectRefusal = (id, input, code) => {
      assert.throws(() => boundary.dispatch({ runtime, role: 'executor', dispatch_id: id, ...input }),
        (error) => error.code === code, id);
      assert.equal(recorders[runtime].getVerifiedRecord(id), null, id + ' must not create a compliant record');
    };
    const before = launches;
    expectRefusal(`${runtime}-inherit`, { selection: { inherit: true } }, 'UNSUPPORTED_SELECTION');
    expectRefusal(`${runtime}-repair-without-receipt`, { role: 'ci-fix', signals: { signatureState: 'repeat' } }, 'MISSING_RECEIPT');
    assert.equal(launches, before, 'invalid selections must fail before launch');
    missingEvidence = true;
    expectRefusal(`${runtime}-missing-receipt`, {}, 'MISSING_RECEIPT');
    missingEvidence = false;
    assert.equal(launches, before + 1, 'missing host evidence must fail after the host call');
  }
  const beforeStale = launches;
  write(manifestFile, JSON.stringify({ ...manifest, policy_hash: 'stale-policy' }));
  assert.throws(() => boundaries.codex.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'stale-bundle' }),
    (error) => error.code === 'STALE_GENERATED_AGENT');
  assert.equal(launches, beforeStale);
  assert.equal(recorders.codex.getVerifiedRecord('stale-bundle'), null);
  write(manifestFile, manifestBytes);
  const agentFile = path.join(agentsDir, policy.codexAgentFile('research', 'base'));
  const agentBytes = fs.readFileSync(agentFile);
  write(agentFile, agentBytes.toString().replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "xhigh"'));
  assert.throws(() => boundaries.codex.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'tampered-agent' }),
    (error) => error.code === 'STALE_GENERATED_AGENT');
  assert.equal(launches, beforeStale);
  assert.equal(recorders.codex.getVerifiedRecord('tampered-agent'), null);
  write(agentFile, agentBytes);
  assert.deepEqual(snapshot(claudeDir), claudeBefore, 'Claude palette/provider configuration must remain byte-identical');
  assert.deepEqual(fs.readFileSync(path.join(source, 'scripts/runtime-adapters.cjs')), paletteBefore);
  assert.deepEqual(fs.readFileSync(path.join(root, 'docker-compose.yml')),
    fs.readFileSync(path.join(claudeDir, 'provider-compose.yml')), 'canonical provider configuration is unchanged');
  assert.deepEqual(snapshot(source), snapshot(path.join(claudeDir, 'plugins/shipyard')), 'canonical Claude plugin is unchanged');
  console.log(`model-ladder runtime smoke: OK (${cases} installed runtime rungs; fingerprints, installer validation, native Claude bytes, refusal cases)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
NODE
