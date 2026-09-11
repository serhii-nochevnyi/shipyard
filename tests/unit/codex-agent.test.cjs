'use strict';

// The Codex runtime carries its model choice in a static agent file. These
// tests exercise the selector at the point where a dispatch chooses that file,
// rather than only testing the generator's output in isolation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'codex-agent.cjs');
const { selectAgent, parseArgs, signalsFrom, candidateSuffix, projectDirFrom } = require(SCRIPT);

function fixture(mode = 'adaptive', files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-agent-'));
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'agents');
  fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(project, '.planning', 'config.json'),
    JSON.stringify({ delivery_pipeline: { model_ladder: mode } }, null, 2),
  );
  for (const [name, spec] of Object.entries(files)) {
    fs.writeFileSync(path.join(agentDir, `${name}.toml`), [
      `name = "${name}"`,
      `model = "${spec.model || 'gpt-5.6-terra'}"`,
      `model_reasoning_effort = "${spec.effort || 'high'}"`,
      '',
    ].join('\n'));
  }
  return { project, agentDir };
}

const STANDARD_FILES = {
  'shipyard-inv-research': { model: 'gpt-5.6-terra' },
  'shipyard-arch-review': { model: 'gpt-5.6-terra' },
  'shipyard-arch-review-critical': { model: 'gpt-6-astra' },
  'shipyard-arch-review-deep': { model: 'gpt-6-astra' },
  'shipyard-ci-fix': { model: 'gpt-5.6-terra' },
  'shipyard-ci-fix-deep': { model: 'gpt-6-astra' },
  'shipyard-integrator': { model: 'gpt-6-astra' },
};

suite('codex-agent — dispatch-time static model selection');

test('routine research selects the ordinary floor file', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('research', {
    cwd: f.project, agentDir: f.agentDir, signals: { risk: 'low', files: 2 },
  });
  assert.strictEqual(result.task_level, 'routine');
  assert.strictEqual(result.agent_file, 'shipyard-inv-research');
  assert.strictEqual(result.model, 'gpt-5.6-terra');
  assert.strictEqual(result.model_tier, 'sonnet');
  assert.strictEqual(result.requested_effort, 'high');
  assert.strictEqual(result.fallback, undefined);
});

test('critical work selects the generated critical file', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('arch-review', {
    cwd: f.project, agentDir: f.agentDir, signals: { risk: 'high' },
  });
  assert.strictEqual(result.task_level, 'critical');
  assert.strictEqual(result.agent_file, 'shipyard-arch-review-critical');
  assert.strictEqual(result.model, 'gpt-6-astra');
  assert.strictEqual(result.model_tier, 'sonnet');
  assert.ok(result.route.includes('level:critical'), result.route);
});

test('an exhausted repair signature selects the recovery file', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('ci-fix', {
    cwd: f.project, agentDir: f.agentDir, signals: { signatureState: 'repeat_exhausted' },
  });
  assert.strictEqual(result.task_level, 'recovery');
  assert.strictEqual(result.agent_file, 'shipyard-ci-fix-deep');
  assert.strictEqual(result.model, 'gpt-6-astra');
});

test('a contested architecture judgement selects the recovery file', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('arch-review', {
    cwd: f.project, agentDir: f.agentDir, signals: { contested: true },
  });
  assert.strictEqual(result.task_level, 'recovery');
  assert.strictEqual(result.task_level_rule, 'auto:recovery:contested');
  assert.strictEqual(result.agent_file, 'shipyard-arch-review-deep');
  assert.strictEqual(result.model, 'gpt-6-astra');
});

test('a missing variant falls back to the ordinary file with an explicit reason', () => {
  const f = fixture('adaptive', {
    'shipyard-arch-review': { model: 'gpt-5.6-terra' },
  });
  const result = selectAgent('arch-review', {
    cwd: f.project, agentDir: f.agentDir, signals: { checkpoint: true },
  });
  assert.strictEqual(result.task_level, 'critical');
  assert.strictEqual(result.agent_file, 'shipyard-arch-review');
  assert.strictEqual(result.fallback.requested, 'shipyard-arch-review-critical');
  assert.ok(/unavailable/.test(result.fallback.reason), result.fallback.reason);
});

test('conservative mode does not name a critical variant even if a stale file exists', () => {
  const f = fixture('conservative', STANDARD_FILES);
  const result = selectAgent('arch-review', {
    cwd: f.project, agentDir: f.agentDir, signals: { taskLevel: 'critical' },
  });
  assert.strictEqual(result.task_level, 'critical');
  assert.strictEqual(result.ladder_mode, 'conservative');
  assert.strictEqual(result.agent_file, 'shipyard-arch-review');
  assert.strictEqual(result.model, 'gpt-5.6-terra');
  assert.strictEqual(candidateSuffix('arch-review', 'critical', 'conservative'), '');
  assert.strictEqual(result.fallback.requested, 'shipyard-arch-review-critical');
  assert.ok(/conservative/.test(result.fallback.reason), result.fallback.reason);
});

test('integrator always reads its ceiling file and has no generated variant', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('integrator', {
    cwd: f.project, agentDir: f.agentDir, signals: { risk: 'high' },
  });
  assert.strictEqual(result.agent_file, 'shipyard-integrator');
  assert.strictEqual(result.model, 'gpt-6-astra');
  assert.strictEqual(candidateSuffix('integrator', 'critical', 'adaptive'), '');
});

test('executor resolves the floor model dynamically because it has no static file', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('executor', {
    cwd: f.project,
    agentDir: f.agentDir,
    env: { SHIPYARD_CODEX_CLI_VERSION: '0.999.0' },
    signals: { risk: 'low', files: 2 },
  });
  assert.strictEqual(result.task_level, 'routine');
  assert.strictEqual(result.agent_file, null);
  assert.strictEqual(result.model, 'gpt-5.6-terra');
  assert.strictEqual(result.model_tier, 'sonnet');
  assert.strictEqual(result.palette_lane, 'floor');
});

test('executor resolves the ceiling model dynamically for critical work', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const result = selectAgent('executor', {
    cwd: f.project,
    agentDir: f.agentDir,
    env: { SHIPYARD_CODEX_CLI_VERSION: '0.999.0' },
    signals: { risk: 'high', files: 2 },
  });
  assert.strictEqual(result.task_level, 'critical');
  assert.strictEqual(result.agent_file, null);
  assert.strictEqual(result.model, 'gpt-6-astra');
  assert.strictEqual(result.palette_lane, 'ceiling');
});

test('conservative executor keeps automatic high-risk work on the floor', () => {
  const f = fixture('conservative', STANDARD_FILES);
  const result = selectAgent('executor', {
    cwd: f.project,
    agentDir: f.agentDir,
    env: { SHIPYARD_CODEX_CLI_VERSION: '0.999.0' },
    signals: { risk: 'high', files: 2 },
  });
  assert.strictEqual(result.task_level, 'critical');
  assert.strictEqual(result.model, 'gpt-5.6-terra');
  assert.strictEqual(result.palette_lane, 'floor');
});

test('an explicit critical request can raise conservative executor work', () => {
  const f = fixture('conservative', STANDARD_FILES);
  const result = selectAgent('executor', {
    cwd: f.project,
    agentDir: f.agentDir,
    env: { SHIPYARD_CODEX_CLI_VERSION: '0.999.0' },
    signals: { taskLevel: 'critical', risk: 'low', files: 2 },
  });
  assert.strictEqual(result.task_level, 'critical');
  assert.strictEqual(result.model, 'gpt-6-astra');
  assert.strictEqual(result.palette_lane, 'ceiling');
});

test('invalid selector flags fail instead of silently becoming a different lane', () => {
  assert.throws(() => signalsFrom(parseArgs(['--signature-state', 'repeat?']).flags), /not a signature state/);
  assert.throws(() => signalsFrom(parseArgs(['--task-level', 'cheap']).flags), /not a task level/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /unknown option/);
  assert.throws(
    () => signalsFrom(parseArgs(['--code-change', '--no-code-change']).flags),
    /cannot be used together/,
  );
});

test('the CLI returns JSON with the selected file and concrete model', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const r = spawnSync(process.execPath, [
    SCRIPT, 'select', 'arch-review', '--json', '--agent-dir', f.agentDir, '--risk', 'high',
  ], { cwd: f.project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.strictEqual(json.agent_file, 'shipyard-arch-review-critical');
  assert.strictEqual(json.model, 'gpt-6-astra');
  assert.strictEqual(json.task_level, 'critical');
  assert.strictEqual(fs.realpathSync(json.project_dir), fs.realpathSync(f.project));
});

test('the CLI can read the project policy while launched from a worktree', () => {
  const f = fixture('adaptive', STANDARD_FILES);
  const r = spawnSync(process.execPath, [
    SCRIPT, 'select', 'arch-review', '--json', '--project-dir', f.project,
    '--agent-dir', f.agentDir, '--risk', 'high',
  ], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.strictEqual(json.agent_file, 'shipyard-arch-review-critical');
  assert.strictEqual(json.ladder_mode, 'adaptive');
  assert.strictEqual(fs.realpathSync(json.project_dir), fs.realpathSync(f.project));
  assert.strictEqual(projectDirFrom(parseArgs(['--project-dir', f.project]).flags), f.project);
});

done();
