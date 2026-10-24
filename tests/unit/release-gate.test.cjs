'use strict';

const { suite, test, done, assert } = require('./assert-harness.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-live-'));
process.env.SHIPYARD_LIVE_STATE_DIR = stateDir;
process.on('exit', () => fs.rmSync(stateDir, { recursive: true, force: true }));

const liveReceipt = require('../../plugins/delivery-pipeline/scripts/live-receipt.cjs');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const RUNG = { model: 'opus', effort: 'high' };

function stages(overrides = {}) {
  return liveReceipt.REQUIRED_STAGES.map((stage) => ({
    stage, ok: true, detail: '', dispatch_id: `dd-${stage}`, role: stage,
    requested: RUNG, applied: RUNG, ...(overrides[stage] || {}),
  }));
}

function writeReceipt(tree, runtime, list, now = NOW, version = '1.2.3') {
  return liveReceipt.write({ version, tree_sha: tree, head_sha: 'h', runtime, stages: list, cli_version: 'x' }, { now });
}

function checkTree(tree, version = '1.2.3') {
  return liveReceipt.check({ version, tree_sha: tree, runtimes: ['claude', 'codex'], maxAgeDays: 7, now: NOW });
}

suite('live-receipt check');

test('both runtimes passing and fresh → ok', () => {
  writeReceipt('t-ok', 'claude', stages());
  writeReceipt('t-ok', 'codex', stages());
  const result = checkTree('t-ok');
  assert.deepStrictEqual(result, { ok: true, missing: [], stale: [], failed: [] });
});

test('non-model stages such as push pass without a rung', () => {
  const extra = [{ stage: 'push', ok: true, detail: '', requested: null, applied: null },
    { stage: 'bootstrap', ok: true, detail: '', requested: null, applied: null }];
  writeReceipt('t-push', 'claude', [...extra, ...stages()]);
  writeReceipt('t-push', 'codex', [...extra, ...stages()]);
  assert.deepStrictEqual(checkTree('t-push'), { ok: true, missing: [], stale: [], failed: [] });
});

test('one runtime missing → refused naming it', () => {
  writeReceipt('t-miss', 'claude', stages());
  const result = checkTree('t-miss');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.missing, ['codex']);
});

test('an 8-day-old receipt → stale', () => {
  writeReceipt('t-stale', 'claude', stages());
  writeReceipt('t-stale', 'codex', stages(), NOW - 8 * DAY);
  const result = checkTree('t-stale');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.stale, ['codex']);
});

test('a failed stage → failed', () => {
  writeReceipt('t-fail', 'claude', stages({ publish: { ok: false, detail: 'hygiene' } }));
  writeReceipt('t-fail', 'codex', stages());
  const result = checkTree('t-fail');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.failed.map((f) => f.runtime), ['claude']);
});

test('applied rung differing from requested → failed', () => {
  writeReceipt('t-rung', 'claude', stages());
  writeReceipt('t-rung', 'codex', stages({ executor: { applied: { model: 'haiku', effort: 'low' } } }));
  const result = checkTree('t-rung');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.failed.map((f) => f.runtime), ['codex']);
});

test('receipt missing the sentinel stage → failed', () => {
  writeReceipt('t-nosent', 'claude', stages().filter((s) => s.stage !== 'sentinel'));
  writeReceipt('t-nosent', 'codex', stages());
  const result = checkTree('t-nosent');
  assert.strictEqual(result.ok, false);
  assert.ok(result.failed[0].reasons.includes('missing stage sentinel'));
});

test('a receipt for another tree sha is ignored', () => {
  writeReceipt('t-other', 'claude', stages());
  writeReceipt('t-other', 'codex', stages());
  const result = checkTree('t-mine');
  assert.deepStrictEqual(result.missing, ['claude', 'codex']);
});

suite('release.sh');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function copyInto(root, rel) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(REPO, rel), dest);
}

test('refuses without receipts and tags with them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-release-'));
  try {
    for (const rel of ['scripts/release.sh', 'plugins/delivery-pipeline/scripts/live-receipt.cjs', 'plugins/delivery-pipeline/scripts/lock.cjs']) {
      copyInto(root, rel);
    }
    fs.mkdirSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'), '{"version":"9.9.9"}\n');
    fs.mkdirSync(path.join(root, 'tests/smoke'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/smoke/release-notes-smoke.sh'), '#!/usr/bin/env bash\nexit 0\n');
    git(root, ['init', '-q']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'tag.gpgsign', 'false']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    const env = { ...process.env, SHIPYARD_LIVE_STATE_DIR: stateDir };
    const run = (version) => spawnSync('bash', ['scripts/release.sh', version], { cwd: root, env, encoding: 'utf8' });

    const wrongVersion = run('1.0.0');
    assert.notStrictEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /differs from plugin\.json/);

    const refused = run('9.9.9');
    assert.notStrictEqual(refused.status, 0, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /live-round\.sh --runtime claude/);
    assert.match(refused.stderr, /live-round\.sh --runtime codex/);
    assert.throws(() => git(root, ['rev-parse', '-q', '--verify', 'refs/tags/v9.9.9']));

    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    writeReceipt(tree, 'claude', stages(), Date.now(), '9.9.9');
    writeReceipt(tree, 'codex', stages(), Date.now(), '9.9.9');
    const tagged = run('9.9.9');
    assert.strictEqual(tagged.status, 0, tagged.stdout + tagged.stderr);
    assert.match(tagged.stdout, /git push origin v9\.9\.9/);
    assert.strictEqual(git(root, ['cat-file', '-t', 'v9.9.9']), 'tag');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the live round checks the Codex home it was pointed at', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'live', 'live-round.sh'), 'utf8');
  assert.match(script, /doctor_args\+=\(--codex-home "\$CODEX_HOME"\)/);
  assert.match(script, /shipyard-doctor\.cjs" \$\{doctor_args\[@\]\+"\$\{doctor_args\[@\]\}"\}/);
});

suite('live executor admission and publication');

function liveBoundary(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-boundary-'));
  try {
    const worktree = path.join(root, 'project');
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(path.join(worktree, '.planning/graph'), { recursive: true });
    fs.mkdirSync(scripts);
    fs.copyFileSync(path.join(REPO, 'tests/fixtures/live-project/planning/config.json'), path.join(worktree, '.planning/config.json'));
    if (options.config !== undefined) fs.writeFileSync(path.join(worktree, '.planning/config.json'), options.config);
    const plan = '## Verification commands\n' + (options.command === undefined ? '- `node --test tests/greeting.test.cjs`\n' : options.command);
    fs.writeFileSync(path.join(worktree, '.planning/PLAN.md'), plan);
    fs.writeFileSync(path.join(worktree, '.planning/graph/tickets.json'), JSON.stringify({ tickets: {
      'T-01-01': { plan: '.planning/PLAN.md', title: 'Greeting', branch: 'ticket', pr_base: 'base' },
    } }));
    fs.writeFileSync(path.join(worktree, '.planning/graph/delivery-state.json'), JSON.stringify({ 'T-01-01': { branch: 'ticket', base: 'base' } }));
    fs.copyFileSync(path.join(REPO, 'plugins/delivery-pipeline/scripts/ticket-base.cjs'), path.join(scripts, 'ticket-base.cjs'));
    fs.writeFileSync(path.join(worktree, 'greeting.cjs'), 'original\n');
    git(worktree, ['init', '-q']);
    git(worktree, ['config', 'user.name', 'Controlled fixture']);
    git(worktree, ['config', 'user.email', 'fixture@example.invalid']);
    git(worktree, ['config', 'commit.gpgsign', 'false']);
    git(worktree, ['add', '.']);
    git(worktree, ['commit', '-qm', 'base']);
    git(worktree, ['branch', '-M', 'base']);
    git(worktree, ['checkout', '-qb', 'ticket']);
    const base = git(worktree, ['rev-parse', 'HEAD']);
    const calls = path.join(root, 'calls');
    fs.writeFileSync(calls, '');
    for (const name of ['host-verification.cjs', 'pipeline-config.cjs', 'development-artifacts.cjs', 'model-policy.cjs']) {
      fs.writeFileSync(path.join(scripts, name), `module.exports = require(${JSON.stringify(path.join(REPO, 'plugins/delivery-pipeline/scripts', name))});\n`
        + (name === 'model-policy.cjs' ? `if (require.main === module) console.log(JSON.stringify(module.exports.resolveDispatch(JSON.parse(process.argv[3]))));\n` : ''));
    }
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const runtime = options.runtime || 'claude';
    const rung = policy.resolveDispatch({ runtime, role: 'executor', signals: {} });
    const receipt = { runtime, role: 'executor', requested_model: rung.model, applied_model: rung.model,
      requested_effort: rung.effort ?? null, applied_effort: rung.effort ?? null };
    fs.writeFileSync(path.join(root, 'options.json'), JSON.stringify({ ...options, runtime, receipt, base }));
    fs.writeFileSync(path.join(scripts, 'deliver-dispatch.cjs'), `
      const fs = require('fs');
      const { execFileSync } = require('child_process');
      const o = require(process.env.CONTROL_OPTIONS);
      const log = value => fs.appendFileSync(process.env.CONTROL_CALLS, value + '\\n');
      if (process.argv[2] === 'launch') { log('launch'); console.log(JSON.stringify({dispatch_id:'controlled'})); }
      else {
        const git = (...args) => execFileSync('git', ['-C', process.env.CONTROL_WORKTREE, ...args], {encoding:'utf8'}).trim();
        if (o.change !== 'unchanged') {
          fs.writeFileSync(process.env.CONTROL_WORKTREE + (o.change === 'development' ? '/.planning/note' : '/greeting.cjs'), 'changed\\n');
          if (o.change !== 'dirty') { git('add', '.'); git('commit', '-qm', 'controlled product'); }
        }
        const commit = git('rev-parse', 'HEAD');
        if (o.change === 'wrong-branch') git('checkout', '-qb', 'other');
        if (o.change === 'base-head') git('branch', '-f', 'base', commit);
        if (o.change === 'remote-base-head') git('update-ref', 'refs/remotes/origin/base', commit);
        if (o.change === 'diverged') { git('checkout', '--orphan', 'unrelated'); git('commit', '-qm', 'unrelated'); git('branch', '-M', 'ticket'); }
        const artifact = { schema:'shipyard.codex-delivery-artifact.v1', status:'committed', ticket:'T-01-01', commit,
          changed:['greeting.cjs'] };
        let result = o.runtime === 'claude' ? [{ id:'T-01-01', branch:'ticket', status:'committed', receipt:o.receipt,
          artifact_ref:'controlled-artifact', artifact_digest:'controlled-digest', evidence_index:{},
          artifact:{ ref:'controlled-artifact', digest:'controlled-digest', envelope:{role:'executor', ticket:'T-01-01', outcome:'committed'}, evidence_index:{} } }]
          : { ticket:'T-01-01', runtime:'codex', role:'executor', receipt:o.receipt, artifact };
        const entry = Array.isArray(result) ? result[0] : result;
        if (o.status) {
          entry.status = o.status;
          if (o.runtime === 'claude') {
            delete entry.branch; delete entry.artifact; delete entry.artifact_ref;
            delete entry.artifact_digest; delete entry.evidence_index;
          }
        }
        if (o.bad === 'ticket') entry[Array.isArray(result) ? 'id' : 'ticket'] = 'T-99-99';
        if (o.bad === 'branch') entry.branch = 'other';
        if (o.bad === 'runtime') entry.runtime = 'other';
        if (o.bad === 'role') entry.role = 'research';
        if (o.bad === 'receipt') delete entry.receipt;
        if (o.bad === 'rung') entry.receipt.applied_model = 'wrong';
        if (o.bad === 'artifact') delete entry.artifact;
        if (o.bad === 'envelope' && o.runtime === 'claude') entry.artifact.envelope.outcome = 'blocked';
        if (o.bad === 'artifact-ticket') artifact.ticket = 'T-99-99';
        if (o.bad === 'artifact-status') artifact.status = 'blocked';
        if (o.bad === 'artifact-commit') artifact.commit = o.base;
        if (o.bad === 'commit') entry.commit = o.base;
        if (o.bad === 'array') result = [entry, entry];
        if (o.bad === 'null') result = null;
        if (o.bad === 'empty') result = [];
        if (o.bad === 'object') result = {};
        if (o.bad === 'input') result = { receipt:o.receipt, status:'input-only' };
        if (o.bad === 'malformed') { console.log('{broken'); process.exit(0); }
        console.log(JSON.stringify({status:o.outer || 'exited-ok', exit_code:0, runtime:o.runtime,
          ticket:'T-01-01', role:'executor', result}));
      }
    `);
    fs.writeFileSync(path.join(scripts, 'pr-hygiene.cjs'), `
      require('fs').appendFileSync(process.env.CONTROL_CALLS, process.argv[2] + '\\n');
      if (process.argv[2] === 'format') console.log('feat: greeting');
      if (process.env.CONTROL_RECHECK === 'yes' && process.argv[2] === 'format') {
        require('child_process').execFileSync('git', ['-C', process.env.CONTROL_WORKTREE, 'checkout', '-qb', 'changed-after-admission']);
      }
    `);
    fs.writeFileSync(path.join(scripts, 'pr-ledger.cjs'), '');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *" push "*) echo push >> "$CONTROL_CALLS"; exit 0;; esac\nexec ${JSON.stringify(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho pr >> "$CONTROL_CALLS"\necho https://example.invalid/pull/1\n', { mode: 0o755 });
    const source = fs.readFileSync(path.join(REPO, 'tests/live/live-round.sh'), 'utf8');
    const functions = source.slice(source.indexOf('stage_json()'), source.indexOf('command -v "$runtime"'));
    const boundary = source.slice(source.indexOf('verification_preflight()'), source.indexOf('\nsleep 20'));
    assert.ok(boundary.startsWith('verification_preflight()'), 'actual preflight boundary exists');
    const script = path.join(root, 'boundary.sh');
    fs.writeFileSync(script, 'set -euo pipefail\n' + functions + '\ntrap - EXIT\n' + boundary);
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      SCRIPTS: scripts, project: worktree, ticket_worktree: worktree, work: root,
      stages_file: path.join(root, 'stages'), graph_dir: path.join(worktree, '.planning/graph'),
      runtime, ticket: 'T-01-01', ticket_branch: 'ticket', ticket_base: 'base', repo: 'fixture/repo',
      CONTROL_OPTIONS: path.join(root, 'options.json'), CONTROL_CALLS: calls, CONTROL_WORKTREE: worktree,
      CONTROL_RECHECK: options.recheck ? 'yes' : 'no' };
    const result = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 30000 });
    return { ...result, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
      stages: fs.existsSync(env.stages_file) ? fs.readFileSync(env.stages_file, 'utf8').trim().split('\n').map(JSON.parse) : [] };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const command of ['## Other section\n- `node --test tests/greeting.test.cjs`\n', '- `node --test tests/greeting.test.cjs` trailing explanation\n', '', '- `npm test`\n']) {
  test('refuses generated command before executor: ' + JSON.stringify(command), () => {
    const result = liveBoundary({ command });
    assert.notStrictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(result.calls, []);
    assert.ok(result.stages.some(stage => stage.stage === 'executor' && !stage.ok));
  });
}
for (const config of ['{broken', 'null', '{}', '{"delivery_pipeline":{"verification_commands":{"default":[{"argv":["node"],"profile":"invalid"}]}}}']) {
  test('refuses invalid or absent approval: ' + config, () => {
    const result = liveBoundary({ config });
    assert.notStrictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(result.calls, []);
    assert.ok(result.stages.some(stage => stage.stage === 'executor' && !stage.ok));
  });
}
for (const runtime of ['claude', 'codex']) {
  test(runtime + ' committed native shape with real product commit publishes', () => {
    const result = liveBoundary({ runtime });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.calls.includes('push'));
    assert.ok(result.calls.includes('pr'));
    assert.ok(result.stages.some(stage => stage.stage === 'executor' && stage.ok));
  });
  const cases = [
    ...['verification_failed', 'blocked', 'input-only'].map(status => ({ status })),
    ...['ticket', 'branch', 'runtime', 'role', 'receipt', 'rung', 'artifact', 'commit', 'null', 'empty', 'object', 'input', 'malformed'].map(bad => ({ bad })),
    ...['unchanged', 'dirty', 'development', 'wrong-branch', 'base-head', 'remote-base-head', 'diverged'].map(change => ({ change })),
    { outer: 'blocked' },
    ...(runtime === 'codex' ? ['artifact-ticket', 'artifact-status', 'artifact-commit'].map(bad => ({ bad })) : [{ bad: 'array' }, { bad: 'envelope' }]),
  ];
  for (const options of cases) {
    test(runtime + ' refuses before success/publication: ' + JSON.stringify(options), () => {
      const result = liveBoundary({ runtime, ...options });
      assert.notStrictEqual(result.status, 0, result.stderr);
      assert.ok(result.calls.includes('launch'));
      assert.ok(!result.calls.includes('push') && !result.calls.includes('pr'));
      assert.ok(result.stages.some(stage => stage.stage === 'executor' && !stage.ok), result.stderr);
      assert.ok(!result.stages.some(stage => ['executor', 'publish'].includes(stage.stage) && stage.ok));
    });
  }
  test(runtime + ' rechecks branch immediately before publication', () => {
    const result = liveBoundary({ runtime, recheck: true });
    assert.notStrictEqual(result.status, 0, result.stderr);
    assert.ok(!result.calls.includes('push') && !result.calls.includes('pr'));
    assert.ok(result.stages.some(stage => stage.stage === 'executor' && !stage.ok));
    assert.ok(!result.stages.some(stage => ['executor', 'publish'].includes(stage.stage) && stage.ok));
  });
}

done();
