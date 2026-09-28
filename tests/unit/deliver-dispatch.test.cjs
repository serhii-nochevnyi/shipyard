'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const codexSessionEnv = Object.fromEntries(['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']
  .map((name) => [name, process.env[name]]));
for (const name of Object.keys(codexSessionEnv)) delete process.env[name];
process.on('exit', () => {
  for (const [name, value] of Object.entries(codexSessionEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const deliverDispatch = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
const { validateRequest } = require('../../plugins/delivery-pipeline/scripts/claude-delivery-host.cjs');
const { validateArgs } = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
const { parseRequest, REQUEST_SCHEMA: ROLE_REQUEST_SCHEMA } = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
const { validateContextPacket } = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const modelPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const prHygiene = require('../../plugins/delivery-pipeline/scripts/pr-hygiene.cjs');

suite('deliver-dispatch — front-to-dispatch entry point');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Deliver Dispatch Test');
  git(dir, 'config', 'user.email', 'deliver-dispatch@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const PLAN_TEXT = [
  '---',
  'phase: 1',
  'plan: 1',
  'title: "Demo ticket"',
  'type: implementation',
  '---',
  '',
  '## Context (Reads)',
  '',
  '- `src/helper.js`',
  '',
  '## Acceptance criteria',
  '',
  '- it works',
  '',
  '## Verification commands',
  '',
  '- `node -e "1"`',
  '',
].join('\n');

function ticketRow(overrides = {}) {
  return {
    branch: 'ticket/T-01-01-demo',
    plan: '.planning/phases/01-demo/01-01-PLAN.md',
    type: 'implementation',
    phase: 1,
    risk: 'low',
    human_checkpoint: false,
    critical: false,
    files: ['src/thing.js'],
    pr_base: 'main',
    repo: null,
    ...overrides,
  };
}

function writeShipyardManifest(root) {
  writeJson(path.join(root, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'), { name: 'shipyard' });
}

function shipyardFixture(id = 'T-01-01') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-sy-'));
  initRepo(root);
  writeShipyardManifest(root);
  writeJson(path.join(root, '.planning', 'graph', 'tickets.json'), { tickets: { [id]: ticketRow() } });
  writeJson(path.join(root, '.planning', 'graph', 'delivery-state.json'), { [id]: { ready: true } });
  fs.mkdirSync(path.join(root, '.planning', 'phases', '01-demo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'phases', '01-demo', '01-01-PLAN.md'), PLAN_TEXT);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'thing.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'helper.js'), 'module.exports = 2;\n');
  commitAll(root, 'demo: seed shipyard fixture');
  return { root, id, graphDir: path.join(root, '.planning', 'graph') };
}

function builderFixture(id = 'T-11-11') {
  const fixture = shipyardFixture(id);
  git(fixture.root, 'checkout', '-q', '-b', ticketRow().branch);
  writeJson(path.join(fixture.graphDir, 'delivery-state.json'), {
    [id]: { ready: true, status: 'pr-open', pr: 501, branch: ticketRow().branch, base: 'main' },
  });
  return fixture;
}

function targetProjectFixture(id = 'T-02-02') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-tp-'));
  initRepo(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'thing.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(projectRoot, '.planning', 'phases', '02-demo'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.planning', 'phases', '02-demo', '02-02-PLAN.md'), PLAN_TEXT);
  commitAll(projectRoot, 'demo: seed target project (no .planning tracked)');
  writeJson(path.join(projectRoot, '.planning', 'graph', 'tickets.json'), {
    tickets: { [id]: ticketRow({ branch: 'feat/demo-ticket', plan: '.planning/phases/02-demo/02-02-PLAN.md' }) },
  });
  writeJson(path.join(projectRoot, '.planning', 'graph', 'delivery-state.json'), { [id]: { ready: true } });

  const ticketWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-tp-wt-'));
  initRepo(ticketWorktree);
  fs.writeFileSync(path.join(ticketWorktree, 'README.md'), '# ticket worktree\n');
  commitAll(ticketWorktree, 'demo: seed cross-repo ticket worktree');
  git(ticketWorktree, 'checkout', '-q', '-b', 'feat/demo-ticket');

  return { projectRoot, ticketWorktree, id, graphDir: path.join(projectRoot, '.planning', 'graph') };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const sharedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-state-'));
process.on('exit', () => fs.rmSync(sharedStateDir, { recursive: true, force: true }));

test('Pitfall 1: ticket type never enters signals, and the row shape is accepted by the real resolver', () => {
  const row = ticketRow({ type: 'implementation' });
  const signals = deliverDispatch.buildSignals(row);
  assert.equal(Object.prototype.hasOwnProperty.call(signals, 'type'), false);
  assert.deepEqual(signals, { risk: 'low' });
  assert.deepEqual(modelPolicy.normalizeSignals(signals), { risk: 'low' });
});

test('build emits an arch-review request accepted by the Claude role host', async () => {
  const fixture = builderFixture();
  try {
    let output = '';
    const code = await deliverDispatch.main([
      'build', 'arch-review', fixture.id, '--runtime', 'claude', '--pr', '501',
    ], { write(value) { output += value; } }, { cwd: fixture.root, graphDir: fixture.graphDir });
    assert.equal(code, 0);
    const request = JSON.parse(output);
    const accepted = parseRequest(request);
    assert.equal(request.schema, ROLE_REQUEST_SCHEMA);
    assert.equal(accepted.role, 'arch-review');
    assert.equal(accepted.ticket, fixture.id);
    assert.equal(accepted.pr, 501);
    assert.equal(accepted.worktree, fs.realpathSync(fixture.root));
    assert.equal(Object.prototype.hasOwnProperty.call(request.signals || {}, 'type'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.signals || {}, 'model'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.signals || {}, 'effort'), false);
  } finally {
    cleanup(fixture.root);
  }
});

test('Codex arch-review shape acceptance is not evidence-bound host parity', () => {
  const fixture = builderFixture('T-12-12');
  try {
    const shape = validateArgs({ role: 'arch-review', signals: {}, context: {} });
    assert.equal(shape.request.role, 'arch-review');
    assert.equal(shape.request.context.prompt, undefined);
    assert.throws(
      () => deliverDispatch.build(['arch-review', fixture.id, '--runtime', 'codex', '--pr', '501'], {
        cwd: fixture.root, graphDir: fixture.graphDir,
      }),
      (error) => error.exitCode === 2 && /codex arch-review host contract missing/.test(error.message)
        && /caller-built prompt/.test(error.message),
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('fix builders refuse shape-only hosts after checking evidence paths and digests', () => {
  const fixture = builderFixture('T-13-13');
  const failureFile = path.join(fixture.root, 'failure.log');
  const reviewFile = path.join(fixture.root, 'review.md');
  fs.writeFileSync(failureFile, 'failing test output\n');
  fs.writeFileSync(reviewFile, 'review thread evidence\n');
  try {
    for (const runtime of ['claude', 'codex']) {
      for (const [role, flag, evidence, hostName] of [
        ['ci-fix', '--failure-file', failureFile, 'failure evidence'],
        ['review-fix', '--review-file', reviewFile, 'review evidence'],
      ]) {
        if (runtime === 'codex') {
          const shape = validateArgs({ role, signals: {}, context: { evidence_path: evidence,
            evidence_sha256: crypto.createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') } });
          assert.equal(shape.request.role, role);
        }
        assert.throws(
          () => deliverDispatch.build([role, fixture.id, '--runtime', runtime, '--pr', '501', flag, evidence], {
            cwd: fixture.root, graphDir: fixture.graphDir,
          }),
          (error) => error.exitCode === 2 && new RegExp(`${runtime} ${role} host contract missing`).test(error.message)
            && new RegExp(hostName).test(error.message),
        );
      }
    }
  } finally {
    cleanup(fixture.root);
  }
});

test('build exits 2 and names --failure-file when CI evidence is missing', () => {
  const fixture = builderFixture('T-14-14');
  try {
    const script = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
    const options = {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...process.env, SHIPYARD_GRAPH_DIR: fixture.graphDir },
    };
    const absentFlag = spawnSync(process.execPath, [script, 'build', 'ci-fix', fixture.id,
      '--runtime', 'claude', '--pr', '501'], options);
    const missingFile = spawnSync(process.execPath, [script, 'build', 'ci-fix', fixture.id,
      '--runtime', 'claude', '--pr', '501', '--failure-file', 'missing.log'], options);
    assert.equal(absentFlag.status, 2);
    assert.match(absentFlag.stderr, /--failure-file/);
    assert.equal(missingFile.status, 2);
    assert.match(missingFile.stderr, /--failure-file file is unavailable/);
  } finally {
    cleanup(fixture.root);
  }
});

test('Pitfall 2: planPath satisfies the canonical-plan formula regardless of process.cwd()', async () => {
  const fixture = shipyardFixture();
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        captured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    const expectedPlanPath = path.resolve(fs.realpathSync(fixture.graphDir), '..', '..', ticketRow().plan);
    assert.equal(captured.args.tickets[0].planPath, expectedPlanPath);
    assert.notEqual(path.resolve(fs.realpathSync(fixture.graphDir), '..', '..'), process.cwd());
  } finally {
    cleanup(fixture.root);
  }
});

test('D-43: a Shipyard-shaped fixture resolves the worktree graph and plan exactly as today', async () => {
  const fixture = shipyardFixture();
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        captured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(captured.args.tickets[0].branch, ticketRow().branch);
    assert.equal(captured.args.tickets[0].worktreePath, fs.realpathSync(fixture.root));
    assert.equal(Object.prototype.hasOwnProperty.call(captured.args, 'prBodyGuide'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(captured.args, 'deliveryRulesHint'), false);
    const valid = validateRequest('executors', captured);
    assert.equal(valid.hostScope.ticket, fixture.id);
    const packet = captured.args.tickets[0].contextPacket;
    const validated = validateContextPacket(packet, {
      root: fs.realpathSync(fixture.root), role: 'executor', subject: fixture.id, policyHash: modelPolicy.POLICY_HASH,
    });
    assert.ok(validated.required_refs.some((ref) => ref.path === '.planning/phases/01-demo/01-01-PLAN.md'));
    assert.ok(validated.required_refs.some((ref) => ref.path === 'src/helper.js'));
  } finally {
    cleanup(fixture.root);
  }
});

test('an explicit canonical project graph overrides stale ticket-branch state', async () => {
  const fixture = shipyardFixture();
  const linked = path.join(fixture.root, '..', `${path.basename(fixture.root)}-ticket`);
  try {
    git(fixture.root, 'branch', ticketRow().branch);
    git(fixture.root, 'worktree', 'add', '-q', linked, ticketRow().branch);
    writeJson(path.join(linked, '.planning', 'graph', 'delivery-state.json'), {
      [fixture.id]: { ready: false },
    });
    commitAll(linked, 'ticket: retain an older board');
    let captured;
    await deliverDispatch.launch([
      '--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', fixture.graphDir,
    ], {
      cwd: linked,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        captured = JSON.parse(fs.readFileSync(spawnArgs[spawnArgs.indexOf('--request-file') + 1], 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(captured.args.tickets[0].worktreePath, fs.realpathSync(linked));
    assert.equal(captured.args.tickets[0].planPath,
      path.join(fs.realpathSync(fixture.root), ticketRow().plan));
  } finally {
    try { git(fixture.root, 'worktree', 'remove', '--force', linked); } catch {}
    cleanup(fixture.root, linked);
  }
});

test('D-43: a target-project fixture resolves the project graph, and its packet has no .planning ref', async () => {
  const fixture = targetProjectFixture();
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', fixture.graphDir], {
      cwd: fixture.ticketWorktree,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        captured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    const entry = captured.args.tickets[0];
    const expectedSha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(fixture.projectRoot, '.planning', 'phases', '02-demo', '02-02-PLAN.md'))).digest('hex');
    assert.equal(entry.planSha256, expectedSha256);
    assert.equal(entry.planPath, path.resolve(fs.realpathSync(fixture.projectRoot), '.planning', 'phases', '02-demo', '02-02-PLAN.md'));
    const packet = entry.contextPacket;
    assert.equal(packet.required_refs.length, 0);
    assert.equal(packet.role_context.planSha256, expectedSha256);
    const validated = validateContextPacket(packet, {
      root: fs.realpathSync(fixture.ticketWorktree), role: 'executor', subject: fixture.id, policyHash: modelPolicy.POLICY_HASH,
    });
    assert.equal(validated.required_refs.some((ref) => ref.path.includes('.planning')), false);
    assert.equal(captured.args.prBodyGuide, prHygiene.NEUTRAL_PR_BODY_GUIDE);
    assert.equal(captured.args.deliveryRulesHint, prHygiene.NEUTRAL_DELIVERY_RULES_HINT);
  } finally {
    cleanup(fixture.projectRoot, fixture.ticketWorktree);
  }
});

test('D-43: a --graph-dir copy inside a linked worktree refuses GRAPH_NOT_CANONICAL', async () => {
  const fixture = targetProjectFixture('T-03-03');
  const linked = path.join(fixture.projectRoot, '..', `${path.basename(fixture.projectRoot)}-linked`);
  try {
    git(fixture.projectRoot, 'branch', 'linked-branch');
    git(fixture.projectRoot, 'worktree', 'add', '-q', linked, 'linked-branch');
    const copyDir = path.join(linked, '.planning', 'graph');
    writeJson(path.join(copyDir, 'tickets.json'), { tickets: { [fixture.id]: ticketRow() } });
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', copyDir], {
        cwd: linked,
        stateDir: sharedStateDir,
      }),
      (error) => error.code === 'GRAPH_NOT_CANONICAL',
    );
  } finally {
    cleanup(fixture.projectRoot, fixture.ticketWorktree, linked);
  }
});

test('a --graph-dir naming nothing refuses GRAPH_UNRESOLVED', async () => {
  const fixture = targetProjectFixture('T-04-04');
  const emptyGraphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-empty-'));
  try {
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', emptyGraphDir], {
        cwd: fixture.ticketWorktree,
        stateDir: sharedStateDir,
      }),
      (error) => error.code === 'GRAPH_UNRESOLVED',
    );
  } finally {
    cleanup(fixture.projectRoot, fixture.ticketWorktree, emptyGraphDir);
  }
});

test('a non-actionable ticket refuses', async () => {
  const fixture = shipyardFixture('T-05-05');
  writeJson(path.join(fixture.graphDir, 'tickets.json'), { tickets: { [fixture.id]: ticketRow() } });
  writeJson(path.join(fixture.graphDir, 'delivery-state.json'), { [fixture.id]: { ready: false } });
  try {
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'], {
        cwd: fixture.root,
        stateDir: sharedStateDir,
      }),
      (error) => error.code === 'NOT_ACTIONABLE',
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('a Codex request passes the real validateArgs', async () => {
  const fixture = shipyardFixture('T-06-06');
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const argsFile = spawnArgs[spawnArgs.indexOf('--args-file') + 1];
        captured = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(captured.scope.ticket, fixture.id);
    assert.equal(captured.scope.worktree, fs.realpathSync(fixture.root));
    const { resolution } = validateArgs({ role: captured.role, signals: captured.signals, context: captured.context });
    assert.equal(resolution.role, 'executor');
  } finally {
    cleanup(fixture.root);
  }
});

test('the detached child pid is the host process; status/wait report exit and record a dispatch wake', async () => {
  const fixture = shipyardFixture('T-07-07');
  const stub = path.join(fixture.root, 'stub-host.cjs');
  fs.writeFileSync(stub, "process.stdout.write(JSON.stringify({pid: process.pid}) + '\\n');\n");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-state-'));
  try {
    const launched = await deliverDispatch.launch(
      ['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'],
      { cwd: fixture.root, stateDir, claudeHostScript: stub },
    );
    const waited = await deliverDispatch.waitOnce(launched.dispatch_id, { stateDir, intervalMs: 20, timeoutMs: 5000 });
    assert.equal(waited.status, 'exited-ok');
    assert.equal(typeof waited.result.pid, 'number');
    assert.notEqual(waited.result.pid, process.pid);
    const status = deliverDispatch.statusOnce(launched.dispatch_id, { stateDir });
    assert.equal(status.status, 'exited-ok');
    const events = fs.readFileSync(path.join(fixture.graphDir, 'runs', 'wake-events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.kind === 'dispatch' && event.run_id === launched.dispatch_id));
  } finally {
    cleanup(fixture.root, stateDir);
  }
});

test('an unknown dispatch id reports lost', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-state-'));
  try {
    const status = deliverDispatch.statusOnce('dd-does-not-exist', { stateDir });
    assert.equal(status.status, 'lost');
  } finally {
    cleanup(stateDir);
  }
});

test('pr-sentinel runs the round preflight first, and a stubbed refusal propagates before any spawn', async () => {
  const fixture = shipyardFixture('T-08-08');
  writeJson(path.join(fixture.graphDir, 'tickets.json'), { tickets: { [fixture.id]: ticketRow() } });
  writeJson(path.join(fixture.graphDir, 'delivery-state.json'), {
    [fixture.id]: { status: 'pr-open', pr: 501, pr_base: 'main', checks: { failing: 1, pending: 0 } },
  });
  try {
    let spawnCalled = false;
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'pr-sentinel'], {
        cwd: fixture.root,
        stateDir: sharedStateDir,
        preflightRound() { throw new Error('stubbed preflight refusal'); },
        spawn() { spawnCalled = true; return { pid: 1, unref() {}, on() {} }; },
      }),
      /stubbed preflight refusal/,
    );
    assert.equal(spawnCalled, false);
  } finally {
    cleanup(fixture.root);
  }
});

test('a target-project fixture gets NEUTRAL guides; a fixture with a committed shipyard manifest gets neither', async () => {
  const target = targetProjectFixture('T-09-09');
  const shipyard = shipyardFixture('T-10-10');
  try {
    let targetCaptured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', target.id, '--role', 'executor', '--graph-dir', target.graphDir], {
      cwd: target.ticketWorktree,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        targetCaptured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(targetCaptured.args.prBodyGuide, prHygiene.NEUTRAL_PR_BODY_GUIDE);
    assert.equal(targetCaptured.args.deliveryRulesHint, prHygiene.NEUTRAL_DELIVERY_RULES_HINT);
    validateRequest('executors', targetCaptured);

    let shipyardCaptured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', shipyard.id, '--role', 'executor'], {
      cwd: shipyard.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        shipyardCaptured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(shipyardCaptured.args, 'prBodyGuide'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(shipyardCaptured.args, 'deliveryRulesHint'), false);
    validateRequest('executors', shipyardCaptured);
  } finally {
    cleanup(target.projectRoot, target.ticketWorktree, shipyard.root);
  }
});

done();
