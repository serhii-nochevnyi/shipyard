'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-single-hint-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function world(name) {
  const root = path.join(scratch, name);
  const project = path.join(root, 'project');
  const provenance = path.join(project, '.planning/graph/provenance');
  fs.mkdirSync(provenance, { recursive: true });
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(path.join(root, 'xdg'));
  fs.writeFileSync(path.join(project, '.planning/graph/tickets.json'), '{"tickets":{}}\n');
  fs.writeFileSync(path.join(root, 'target.json'), '{}');
  fs.symlinkSync(path.join(root, 'target.json'), path.join(provenance, 'member.json'));
  execFileSync('git', ['-C', project, 'init', '-q']);
  return { root, project };
}

function run(file, args, w, runtime) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, file), ...args], {
    cwd: w.project, encoding: 'utf8', timeout: 60000,
    env: { PATH: '/usr/bin:/bin', HOME: path.join(w.root, 'home'), XDG_STATE_HOME: path.join(w.root, 'xdg'),
      XDG_CONFIG_HOME: path.join(w.root, 'xdg'), SHIPYARD_RUNTIME: runtime },
  });
}

const scope = (w) => ({ run_id: 'run-hint', ticket: 'T-50-99', phase: 50, worktree: fs.realpathSync(w.project),
  runtime: 'codex', provider: 'openai' });

const HOSTS = [
  { file: 'claude-role-host.cjs', runtime: 'claude', args: (file) => ['--args-file', file],
    request: (w) => ({ schema: 'shipyard.claude-role-request.v1', role: 'integrator', worktree: fs.realpathSync(w.project), phase: '50' }) },
  { file: 'claude-delivery-host.cjs', runtime: 'claude', args: (file) => ['--workflow', 'investigation-research', '--request-file', file],
    request: (w) => {
      const worktree = fs.realpathSync(w.project);
      return { schema: 'shipyard.claude-delivery-request.v1',
        scope: { run_id: 'cli-inv-50', ticket: 'INV-TEST', phase: 50, worktree },
        args: { invId: 'INV-TEST', invPath: path.join(worktree, '.planning/investigations/INV-TEST'), worktreePath: worktree,
          lines: ['system-state', 'alternatives', 'constraints', 'risks'].map((id) => ({ id })) } };
    } },
  { file: 'codex-decompose-host.cjs', runtime: 'codex', args: (file) => ['--args-file', file],
    request: (w) => ({ scope: scope(w), gsd_role: 'gsd-plan-checker', prompt: 'Check.' }) },
  { file: 'codex-planning-context-host.cjs', runtime: 'codex', args: (file) => ['--args-file', file],
    request: (w) => ({ scope: scope(w), gsd_role: 'gsd-plan-checker', prompt: 'Check.' }) },
];

for (const host of HOSTS) {
  test(`${host.file} prints each preflight hint once when a launch is refused`, () => {
    const w = world(`launch-${host.file}`);
    const file = path.join(w.root, 'request.json');
    fs.writeFileSync(file, JSON.stringify(host.request(w)));
    const outcome = run(host.file, host.args(file), w, host.runtime);
    assert.notEqual(outcome.status, 0, outcome.stderr);
    const count = Number(/preflight: (\d+) incompatibilities/.exec(outcome.stderr)?.[1]);
    assert.ok(count >= 1, `${host.file}: no preflight refusal in ${outcome.stderr}`);
    const hints = outcome.stderr.split('\n').filter((line) => line.startsWith('hint['));
    assert.equal(hints.length, count, `${host.file}: expected one hint per finding\n${outcome.stderr}`);
    assert.equal(outcome.stderr.includes('the host script'), false, `${host.file}: a degraded hint was printed`);
  });
}

function capabilityEvidence(file) {
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat()
    .map((rung) => ({ model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort }));
  fs.writeFileSync(file, JSON.stringify({
    supportedModels: [...new Set(selections.map((item) => item.model))],
    supportedEfforts: [...new Set(selections.map((item) => item.effort))],
    supportedSelections: selections,
  }));
}

test('codex-decompose-host calls an injected probe function and keeps a probe value', () => {
  const { runHostPreflight } = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
  const w = world('probe-injection');
  capabilityEvidence(path.join(w.root, 'capabilities.json'));
  const env = { PATH: '/usr/bin:/bin', HOME: path.join(w.root, 'home'), XDG_STATE_HOME: path.join(w.root, 'xdg'),
    SHIPYARD_RUNTIME: 'codex', SHIPYARD_CODEX_CAPABILITIES_FILE: path.join(w.root, 'capabilities.json') };
  const unavailable = { status: 'unavailable', reason: 'codex binary missing' };
  const codes = (probe) => runHostPreflight({ env, probe, stderr: { write() {} } },
    { host: 'codex-decompose-host.cjs', worktree: w.project, graphDir: null, stdout: { write() {} } })
    .findings.map((finding) => finding.code);
  assert.deepEqual(codes(unavailable), ['RUNTIME_UNAVAILABLE']);
  let calls = 0;
  assert.deepEqual(codes(() => { calls += 1; return unavailable; }), ['RUNTIME_UNAVAILABLE']);
  assert.equal(calls, 1);
  assert.deepEqual(codes(() => ({ status: 'available' })), []);
});

test('codex-delivery-host --preflight reports each finding detail once', () => {
  const w = world('detail-once');
  const outcome = run('codex-delivery-host.cjs', ['--preflight'], w, 'codex');
  const report = outcome.stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((value) => value && value.schema === 'shipyard.host-preflight.v1');
  assert.ok(report && report.findings.length >= 1, outcome.stderr);
  for (const finding of report.findings) {
    assert.equal(outcome.stderr.split(finding.detail).length - 1, 1, `${finding.code} detail repeated:\n${outcome.stderr}`);
  }
  assert.equal(outcome.stderr.includes('preflight: detail['), false);
});
