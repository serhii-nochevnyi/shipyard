'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

// This boundary fixture never starts GPG. Only the existing preflight key lookup
// is controlled; real git, pinned PLAN parsing and native launch remain in use.
const execFileSync = childProcess.execFileSync;
const fingerprint = 'A'.repeat(40);
childProcess.execFileSync = (program, argv, options) => {
  if (program === 'gpg') {
    assert.deepEqual(argv, ['--batch', '--with-colons', '--list-secret-keys', fingerprint]);
    return `sec:::::::::\nfpr:::::::::${fingerprint}:\n`;
  }
  return execFileSync(program, argv, options);
};
const { createCodexDeliveryHost } = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
childProcess.execFileSync = execFileSync;
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hostArgv = ['node', '--test', 'tests/unit/codex-decompose-host.test.cjs',
  'tests/unit/codex-runtime-host.test.cjs', 'tests/unit/codex-delivery-host.test.cjs',
  'tests/unit/dispatch-boundary.test.cjs', 'tests/unit/pipeline-config.test.cjs'];
const sandboxArgv = ['node', '--test', 'tests/unit/phase47-host-assignment.test.cjs',
  'tests/unit/host-verification.test.cjs'];
const planText = '# Approved PLAN\n## Verification commands\n'
  + `- \`${sandboxArgv.join(' ')}\`\n- \`${hostArgv.join(' ')}\`\n`;
const allowList = [{ argv: sandboxArgv, profile: 'sandbox', timeout_s: 600 },
  { argv: hostArgv, profile: 'host', timeout_s: 600 }];

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase47-assignment-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'worktree');
  const project = path.join(temp, 'project');
  const graphDir = path.join(project, '.planning', 'graph');
  const plan = path.join(project, '.planning', 'PLAN.md');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.mkdirSync(graphDir, { recursive: true });
  const git = (...argv) => execFileSync('git', ['-C', root, ...argv], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(temp, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}');
  fs.writeFileSync(path.join(root, 'owned.txt'), 'baseline\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Assignment Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.signingkey', fingerprint);
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  git('checkout', '-qb', 'ticket/T-47-04');
  fs.writeFileSync(plan, planText);
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({
    delivery_pipeline: { verification_commands: { default: allowList } },
  }));
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: {
    'T-47-04': { branch: 'ticket/T-47-04', pr_base: 'main', plan: '.planning/PLAN.md', files: ['owned.txt'] },
  } }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify({
    'T-47-04': { branch: 'ticket/T-47-04', base: 'main', status: 'pending' },
  }));
  const scope = { run_id: 'assignment-fixture', ticket: 'T-47-04', phase: 47,
    worktree: root, runtime: 'codex', provider: 'openai' };
  const calls = [];
  const options = { scope, graphDir, storageRoot: path.join(temp, 'host'),
    env: { CODEX_HOME: path.join(temp, 'codex') },
    probe: { status: 'available', executable: 'controlled-codex', capabilities: {
      supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['low'],
    } },
    spawn(program, argv) {
      const call = { program, argv, prompt: '' };
      calls.push(call);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write(value) { call.prompt += String(value); },
        end() { process.nextTick(() => child.emit('close', 1, null)); } };
      child.pid = 45678;
      return child;
    },
    finalizeCommit() { assert.fail('controlled boundary produces no candidate or signed evidence'); },
    hostVerificationRunner: { run() { assert.fail('pre-dispatch assignment must not execute assertions'); } },
  };
  const run = (context = {}, overrides = {}) => createCodexDeliveryHost({ ...options, ...overrides }).run({
    role: 'executor', context: { prompt: 'Implement the approved ticket.', plan_sha256: digest(planText), ...context },
  });
  return { temp, root, project, plan, git, calls, run, options };
}

test('real native executor prompt assigns pinned exact host argv before launch without running it', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.run(), { code: 'RUNTIME_UNAVAILABLE' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].program, 'controlled-codex');
  const prompt = f.calls[0].prompt;
  assert.match(prompt, /Do not run or retry the host-assigned commands in the sandbox/);
  const assignment = JSON.parse(/<HOST-VERIFICATION-ASSIGNMENT>\n(.*?)\n<\/HOST-VERIFICATION-ASSIGNMENT>/s.exec(prompt)?.[1] || 'null');
  assert.equal(assignment.ticket, 'T-47-04');
  assert.equal(assignment.plan_sha256, digest(planText));
  assert.equal(assignment.expected_head, f.git('rev-parse', 'HEAD'));
  assert.equal(assignment.baseline_tree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(assignment.candidate_tree, null, 'the future candidate is not invented before execution');
  assert.match(assignment.allow_list_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(assignment.files_modified, ['owned.txt']);
  assert.deepEqual(assignment.commands.map(({ argv, profile }) => ({ argv, profile })), allowList.map(({ argv, profile }) => ({ argv, profile })));
  assert.match(prompt, /diagnostic data.*assertion authority/i);
  assert.match(prompt, /Historical GPG cause remains unknown/);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('altered argv, unknown profile and absent exact admission refuse before native dispatch', async (t) => {
  const f = fixture(t);
  for (const entries of [null, [], [{ argv: hostArgv.slice(0, -1), profile: 'host' }],
    allowList.map((entry) => ({ ...entry, profile: 'unknown' }))]) {
    await assert.rejects(() => f.run({}, { verificationAllowList: entries }),
      (error) => error.code === 'VERIFICATION_FAILED' && error.status === 'hold');
  }
  fs.appendFileSync(f.plan, '- `node unapproved.cjs`\n');
  await assert.rejects(() => f.run({ plan_sha256: digest(fs.readFileSync(f.plan)) }),
    (error) => error.code === 'VERIFICATION_FAILED' && error.status === 'hold');
  assert.equal(f.calls.length, 0);
});

test('altered ticket, PLAN, candidate and caller-authored assignment cannot add authority', async (t) => {
  const f = fixture(t);
  for (const context of [{ ticket: 'T-47-99' }, { plan_sha256: 'b'.repeat(64) },
    { verification_assignment: { expected_head: 'f'.repeat(40), commands: [{ argv: ['node', 'stolen.cjs'], profile: 'host' }] } }]) {
    await assert.rejects(() => f.run(context));
  }
  fs.appendFileSync(f.plan, '# altered\n');
  await assert.rejects(() => f.run(), { code: 'PLAN_DIGEST_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('PLAN, approval or candidate changes after assignment refuse before host assertions', async (t) => {
  for (const mutation of ['plan', 'approval', 'head', 'scope']) {
    const f = fixture(t);
    const captured = [];
    const host = { scope: f.options.scope, capabilities: f.options.probe.capabilities,
      recorder: createDurableRecorder(path.join(f.temp, 'controlled-receipts')),
      launch(selection, context) {
        captured.push(context);
        fs.writeFileSync(path.join(f.root, 'owned.txt'), 'changed\n');
        if (mutation === 'plan') fs.appendFileSync(f.plan, '# changed after assignment\n');
        if (mutation === 'approval') fs.writeFileSync(path.join(f.project, '.planning', 'config.json'), '{}');
        if (mutation === 'head') {
          f.git('add', 'owned.txt');
          f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'unexpected candidate');
          fs.writeFileSync(path.join(f.root, 'owned.txt'), 'another change\n');
        }
        if (mutation === 'scope') fs.writeFileSync(path.join(f.root, 'unowned.txt'), 'foreign candidate\n');
        return { launch_id: 'controlled-assignment-launch',
          applied_model: selection.model, applied_effort: selection.reasoning_effort,
          observed_model: selection.model, observed_effort: selection.reasoning_effort };
      },
    };
    await assert.rejects(() => f.run({}, { host }), (error) => {
      if (mutation === 'plan') return error.code === 'PLAN_DIGEST_MISMATCH';
      if (mutation === 'approval') return error.code === 'VERIFICATION_FAILED' && error.status === 'hold';
      return error.code === 'SCOPED_TREE_UNAVAILABLE';
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].verification_assignment.plan_sha256, digest(planText));
    assert.deepEqual(captured[0].verification_assignment.commands[1].argv, hostArgv);
  }
});
