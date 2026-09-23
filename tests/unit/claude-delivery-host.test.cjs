'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createClaudeDeliveryHost, runClaudeDeliveryCli, REQUEST_SCHEMA } = require('../../plugins/delivery-pipeline/scripts/claude-delivery-host.cjs');
const { REFERENCE_PATHS } = require('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs');
const { createRunScope } = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const { transcriptEvidence } = require('./claude-test-evidence.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');

suite('claude-delivery-host — registered runtime workflows');

let gpgTail = Promise.resolve();

async function holdGpg() {
  const previous = gpgTail;
  let release;
  gpgTail = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}

function owner(root, worktree, ticket = 'T-38-03', runId = 'run-38-03') {
  const controller = createRunController({
    storeDir: path.join(root, 'controller'), ownerId: `owner-${runId}`,
  });
  controller.begin(createRunScope({
    run_id: runId,
    repository_id: 'shipyard/test',
    phase: 38,
    ticket,
    worktree,
    runtime: 'claude',
    owner_id: `owner-${runId}`,
    dispatch: { dispatch_id: `dispatch-${runId}`, role: 'ci-fix', model: 'claude-opus-5-5', effort: 'medium' },
  }));
  return controller;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function repairFixture(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-repair-host-'));
  const worktreePath = path.join(root, 'worktree');
  const graphDir = path.join(root, '.planning', 'graph');
  const planPath = path.join(root, '.planning', 'phases', '38', '38-03-PLAN.md');
  fs.mkdirSync(worktreePath);
  const worktree = fs.realpathSync(worktreePath);
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, '# Repair plan\n');
  git(worktree, 'init', '-q', '-b', 'ticket/T-38-03');
  git(worktree, 'config', 'user.name', 'Repair Host Test');
  git(worktree, 'config', 'user.email', 'repair@example.test');
  fs.mkdirSync(path.join(worktree, 'src'));
  fs.writeFileSync(path.join(worktree, 'src', 'owned.txt'), 'before\n');
  git(worktree, 'add', 'src/owned.txt');
  git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(worktree, 'branch', 'main');
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({
    tickets: { 'T-38-03': {
      branch: 'ticket/T-38-03', pr_base: 'main',
      plan: '.planning/phases/38/38-03-PLAN.md', files: ['src/owned.txt'], repo: null,
    } },
  }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify({
    'T-38-03': { branch: 'ticket/T-38-03', base: 'main', pr: 303, status: 'pr-open' },
  }));
  const controller = owner(root, worktree);
  const evidence = new WeakMap();
  const prompts = [];
  let launches = 0;
  const runtimeHost = {
    scope: { run_id: 'run-38-03', ticket: 'T-38-03', worktree },
    async agent(prompt, launchOptions) {
      launches++;
      prompts.push(prompt);
      fs.writeFileSync(path.join(worktree, '.shipyard-repair-evidence.md'),
        '# Repair evidence\nVerification: node --test focused.test.cjs, exit 0.\n');
      if (config.changeCode) fs.writeFileSync(path.join(worktree, 'src', 'owned.txt'), 'after\n');
      const result = {
        id: 'T-38-03', pr: 303, pushed: false,
        status: config.status || 'no-op', notes: 'bounded repair synopsis', hypothesis: 'checked the current failure',
        ...(config.result || {}),
      };
      evidence.set(result, transcriptEvidence({
        launch_id: `repair-host-${launches}`,
        applied_model: launchOptions.model,
        applied_effort: launchOptions.effort,
        observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      }));
      return result;
    },
    applicationEvidence: ({ result }) => evidence.get(result),
    capabilities: Object.freeze({ supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true }),
    recorder: createDurableRecorder(path.join(root, 'receipts')),
  };
  const args = {
    prs: [{
      id: 'T-38-03', pr: 303, branch: 'ticket/T-38-03',
      worktreePath: worktree, planPath,
      base: 'main', needsCiFix: true, needsReviewFix: config.needsReviewFix === true,
      model: 'claude-opus-5-5', effort: 'medium',
    }],
  };
  const host = createClaudeDeliveryHost({
    graphDir, controller, runtimeHost,
    ...(config.hostOptions || {}),
  });
  return { root, worktree, graphDir, planPath, host, runtimeHost, args, prompts, launches: () => launches };
}

test('CLI constructs a durable owned run and dispatches a canonical repair', async () => {
  const fixture = repairFixture();
  const requestFile = path.join(fixture.root, 'request.json');
  const storageRoot = path.join(fixture.root, 'cli-storage');
  const runId = 'cli-run-38-03';
  let launched;
  let output = '';
  try {
    fs.writeFileSync(requestFile, JSON.stringify({
      schema: REQUEST_SCHEMA,
      scope: { run_id: runId, ticket: 'T-38-03', phase: 38, worktree: fixture.worktree },
      args: fixture.args,
    }));
    const result = await runClaudeDeliveryCli(
      ['--workflow', 'fix-round', '--request-file', requestFile],
      { write(value) { output += value; } },
      {
        graphDir: fixture.graphDir,
        storageRoot,
        probe: { status: 'available' },
        createRuntimeHost(options) {
          launched = options;
          assert.equal(options.controller.assertOwner(runId), true);
          return {
            ...fixture.runtimeHost,
            scope: options.scope,
            recorder: createDurableRecorder(options.recorderDir),
          };
        },
      },
    );
    assert.equal(result[0].status, 'no-op');
    assert.equal(result[0].pushed, false);
    assert.deepEqual(JSON.parse(output), result);
    assert.equal(fixture.launches(), 1);
    assert.match(fixture.prompts[0], /# ci-fix agent/);
    assert.ok(fs.existsSync(launched.recorderDir));
    const identity = require('node:crypto').createHash('sha256')
      .update(`${runId}\0${fixture.worktree}`).digest('hex');
    const persisted = createRunController({
      storeDir: path.join(storageRoot, identity, 'controller'),
      ownerId: 'inspection-owner',
    }).status(runId);
    assert.equal(persisted.state, 'completed');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('CLI fails closed on a noncanonical PR before launching the runtime', async () => {
  const fixture = repairFixture();
  const requestFile = path.join(fixture.root, 'bad-request.json');
  const runId = 'cli-rejected-38-03';
  try {
    fs.writeFileSync(requestFile, JSON.stringify({
      schema: REQUEST_SCHEMA,
      scope: { run_id: runId, ticket: 'T-38-03', phase: 38, worktree: fixture.worktree },
      args: { prs: [{ ...fixture.args.prs[0], pr: 304 }] },
    }));
    await assert.rejects(() => runClaudeDeliveryCli(
      ['--workflow', 'fix-round', '--request-file', requestFile],
      { write() { throw new Error('rejected CLI must not emit success'); } },
      {
        graphDir: fixture.graphDir,
        storageRoot: path.join(fixture.root, 'cli-storage'),
        probe: { status: 'available', executable: 'claude' },
      },
    ), /canonical delivery board/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('trusted repair host supplies inline references and seals a bounded no-op result', async () => {
  const fixture = repairFixture();
  try {
    const [result] = await fixture.host.run('fix-round', fixture.args);
    assert.equal(fixture.launches(), 1);
    assert.equal(result.pushed, false);
    assert.equal(result.status, 'no-op');
    assert.ok(result.artifact_ref);
    assert.match(fixture.prompts[0], /# ci-fix agent/);
    assert.ok(!fixture.prompts[0].includes(REFERENCE_PATHS['ci-fix']));
    assert.ok(!fixture.prompts[0].includes('reviewers.cjs unresolved'));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('trusted repair host rejects pushed=true before artifact sealing', async () => {
  const fixture = repairFixture({ result: { pushed: true } });
  try {
    await assert.rejects(() => fixture.host.run('fix-round', fixture.args), /pushed=false before sealing/);
    assert.equal(fs.existsSync(path.join(fixture.worktree, '.shipyard-role-artifacts')), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('trusted repair host fetches review feedback and requires a completed host action', async () => {
  const fetched = { pr: 303, threads: [{ id: 'thread-1', comments: ['Check the guard.'] }] };
  let fetches = 0;
  let actions = 0;
  const fixture = repairFixture({
    status: 'fixed', needsReviewFix: true,
    result: { review_dispositions: [{
      thread_id: 'thread-1', action: 'reply-and-resolve', reply: 'Verified the guard.',
      evidence: { command: 'node --test guard.test.cjs', result: 'exit 0' },
    }] },
    hostOptions: {
      fetchReviewFeedback() { fetches++; return fetched; },
      applyReviewActions({ feedback }) {
        actions++;
        assert.deepEqual(feedback, fetched);
        return { applied: true };
      },
    },
  });
  try {
    const [result] = await fixture.host.run('fix-round', fixture.args);
    assert.equal(fetches, 1);
    assert.equal(actions, 1);
    assert.equal(result.pushed, false);
    assert.match(fixture.prompts[0], /thread-1/);
    assert.ok(!fixture.prompts[0].includes(REFERENCE_PATHS['review-fix']));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('default review host replies and resolves only exact fetched thread IDs', async () => {
  const calls = [];
  const fixture = repairFixture({
    status: 'fixed', needsReviewFix: true,
    result: { review_dispositions: [{
      thread_id: 'thread-1', action: 'reply-and-resolve', reply: 'The guard is now checked.',
      evidence: { command: 'node --test guard.test.cjs', result: 'exit 0' },
    }] },
    hostOptions: {
      fetchReviewFeedback() { return { pr: 303, threads: [{ id: 'thread-1', comments: ['Check the guard.'] }] }; },
      execHostCommand(executable, args) {
        calls.push({ executable, args });
        if (executable === 'gh') {
          assert.ok(args.includes('id=thread-1'));
          assert.ok(args.includes('body=The guard is now checked.'));
          return JSON.stringify({ data: { addPullRequestReviewThreadReply: {
            comment: { id: 'reply-1', body: 'The guard is now checked.' },
          } } });
        }
        assert.ok(args.includes('resolve'));
        assert.ok(args.includes('thread-1'));
        return JSON.stringify({ pr: 303, resolved: 1, failed: [] });
      },
    },
  });
  try {
    const [result] = await fixture.host.run('fix-round', fixture.args);
    assert.equal(result.status, 'fixed');
    assert.equal(result.pushed, false);
    assert.equal(calls.length, 2);
    assert.ok(fs.existsSync(path.join(fixture.worktree, '.shipyard-role-artifacts')));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('default review host refuses changed feedback before posting any reply', async () => {
  let reads = 0;
  let commands = 0;
  const fixture = repairFixture({
    status: 'fixed', needsReviewFix: true,
    result: { review_dispositions: [{
      thread_id: 'thread-1', action: 'reply-and-resolve', reply: 'Checked the guard.',
      evidence: { command: 'node --test guard.test.cjs', result: 'exit 0' },
    }] },
    hostOptions: {
      fetchReviewFeedback() {
        reads++;
        return { pr: 303, threads: [{ id: reads === 1 ? 'thread-1' : 'thread-2', comments: ['Check the guard.'] }] };
      },
      execHostCommand() { commands++; throw new Error('must not post'); },
    },
  });
  try {
    await assert.rejects(() => fixture.host.run('fix-round', fixture.args), /review feedback changed after dispatch/);
    assert.equal(reads, 2);
    assert.equal(commands, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('unknown or incomplete review dispositions fail before sealing or external actions', async () => {
  for (const dispositions of [[], [{
    thread_id: 'other-thread', action: 'reply-and-resolve', reply: 'Looks good.',
    evidence: { command: 'node --test guard.test.cjs', result: 'exit 0' },
  }], [{
    thread_id: 'thread-1', action: 'ignore', reply: 'Looks good.',
    evidence: { command: 'node --test guard.test.cjs', result: 'exit 0' },
  }]]) {
    let calls = 0;
    const fixture = repairFixture({
      status: 'fixed', needsReviewFix: true,
      result: { review_dispositions: dispositions },
      hostOptions: {
        fetchReviewFeedback() { return { pr: 303, threads: [{ id: 'thread-1', comments: ['Check the guard.'] }] }; },
        execHostCommand() { calls++; throw new Error('must not mutate'); },
      },
    });
    try {
      await assert.rejects(() => fixture.host.run('fix-round', fixture.args), /review dispositions|review disposition/);
      assert.equal(calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.worktree, '.shipyard-role-artifacts')), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('default review host refuses bot-only findings without a thread action contract', () => {
  const fixture = repairFixture({
    needsReviewFix: true,
    hostOptions: {
      fetchReviewFeedback() {
        return { pr: 303, threads: [], bot_comments: [{ url: 'https://example.test/comment/1', body: 'Change this.' }] };
      },
    },
  });
  try {
    assert.throws(() => fixture.host.run('fix-round', fixture.args), /broader findings need a trusted host action handler/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('trusted repair host blocks a failed signed finalizer before sealing or publishing', async () => {
  let finalized = 0;
  let published = 0;
  const fixture = repairFixture({
    status: 'fixed', changeCode: true,
    hostOptions: {
      signingFingerprint() { return 'A'.repeat(40); },
      finalizeCommit(input) {
        finalized++;
        assert.equal(input.expectedBranch, 'ticket/T-38-03');
        assert.equal(fs.existsSync(path.join(input.worktree, '.shipyard-repair-evidence.md')), false);
        throw new Error('signer unavailable');
      },
      publishRepair() { published++; return { pushed: true }; },
    },
  });
  try {
    await assert.rejects(() => fixture.host.run('fix-round', fixture.args), /signer unavailable/);
    assert.equal(finalized, 1);
    assert.equal(published, 0);
    assert.equal(fs.existsSync(path.join(fixture.worktree, '.shipyard-role-artifacts')), false);
    assert.equal(fs.existsSync(path.join(fixture.worktree, '.shipyard-repair-evidence.md')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('trusted repair host refuses a mismatched canonical PR and caller-supplied reference data', () => {
  const fixture = repairFixture();
  try {
    assert.throws(() => fixture.host.run('fix-round', {
      ...fixture.args, prs: [{ ...fixture.args.prs[0], pr: 304 }],
    }), /canonical delivery board/);
    assert.throws(() => fixture.host.run('fix-round', {
      ...fixture.args, ciFixRefContent: '# forged',
    }), /host-owned/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('drift preflight rejects a base that differs from the canonical ticket graph', () => {
  const fixture = repairFixture();
  try {
    assert.throws(() => fixture.host.run('drift-gate', {
      tickets: [{
        id: 'T-38-03', worktreePath: fixture.worktree,
        planPath: fixture.planPath, baseRef: 'other',
        model: 'claude-opus-5-5', effort: 'medium',
      }],
      driftRefPath: REFERENCE_PATHS['drift-check'],
    }), /base differs from the canonical graph/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('moved repair base fails closed when the trusted host cannot fetch origin', () => {
  const fixture = repairFixture();
  try {
    assert.throws(() => fixture.host.run('fix-round', {
      prs: [{ ...fixture.args.prs[0], needsBaseMerge: true }],
    }), /Git preflight failed/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('trusted base reconciliation rejects unresolved conflict output before model dispatch', () => {
  const fixture = repairFixture({ hostOptions: {
    execHostCommand(executable, args) {
      assert.equal(executable, process.execPath);
      assert.ok(args[0].endsWith('/base-merge.cjs'));
      return JSON.stringify({ ticket: 'T-38-03', requested_base: 'main', base: 'origin/main',
        result: 'conflicts remain', unresolved: ['src/owned.txt'], contested: [] });
    },
  } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git(fixture.worktree, 'remote', 'add', 'origin', origin);
    git(fixture.worktree, 'push', '-q', 'origin', 'main');
    assert.throws(() => fixture.host.run('fix-round', {
      prs: [{ ...fixture.args.prs[0], needsBaseMerge: true }],
    }), /unresolved conflicts or ambiguous evidence/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('default base reconciliation creates a verified signed merge before repair dispatch', async () => {
  const releaseGpg = await holdGpg();
  const fixture = repairFixture({
    status: 'no-op',
    hostOptions: {
      publishRepair(repair, commit) {
        assert.equal(commit.commit, git(repair.worktree, 'rev-parse', 'HEAD'));
        return { pushed: true, commit: commit.commit, reviewer_reinitialized: true };
      },
    },
  });
  const gnupgHome = fs.mkdtempSync('/tmp/crh-base-gpg-');
  fs.chmodSync(gnupgHome, 0o700);
  const previousHome = process.env.GNUPGHOME;
  try {
    const origin = path.join(fixture.root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git(fixture.worktree, 'remote', 'add', 'origin', origin);
    git(fixture.worktree, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(fixture.worktree, 'src', 'base.txt'), 'new base\n');
    git(fixture.worktree, 'add', 'src/base.txt');
    git(fixture.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance base');
    git(fixture.worktree, 'push', '-q', 'origin', 'main');
    git(fixture.worktree, 'checkout', '-q', 'ticket/T-38-03');
    fs.writeFileSync(path.join(fixture.worktree, 'src', 'owned.txt'), 'ticket change\n');
    git(fixture.worktree, 'add', 'src/owned.txt');
    git(fixture.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'ticket change');
    process.env.GNUPGHOME = gnupgHome;
    execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-generate-key', 'Repair Host Test <repair@example.test>', 'ed25519', 'sign', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const keys = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'],
      { encoding: 'utf8' });
    const fingerprint = keys.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
    git(fixture.worktree, 'config', 'user.signingkey', fingerprint);
    const [result] = await fixture.host.run('fix-round', {
      prs: [{ ...fixture.args.prs[0], needsBaseMerge: true }],
    });
    assert.equal(fixture.launches(), 1);
    assert.equal(result.status, 'fixed');
    assert.equal(result.host_publication.pushed, true);
    assert.equal(git(fixture.worktree, 'merge-base', 'main', 'HEAD'), git(fixture.worktree, 'rev-parse', 'main'));
    git(fixture.worktree, 'verify-commit', 'HEAD');
    assert.equal(git(fixture.worktree, 'show', '-s', '--format=%GF', 'HEAD'), fingerprint);
    assert.ok(fs.existsSync(path.join(fixture.worktree, '.shipyard-role-artifacts')));
  } finally {
    if (previousHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previousHome;
    fs.rmSync(gnupgHome, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
    releaseGpg();
  }
});

test('fast-forwarded base receives a host-signed marker before publication', async () => {
  const releaseGpg = await holdGpg();
  const fixture = repairFixture({
    status: 'no-op',
    hostOptions: {
      publishRepair(repair, commit) {
        assert.equal(commit.commit, git(repair.worktree, 'rev-parse', 'HEAD'));
        return { pushed: true, commit: commit.commit, reviewer_reinitialized: true };
      },
    },
  });
  const gnupgHome = fs.mkdtempSync('/tmp/crh-ff-gpg-');
  fs.chmodSync(gnupgHome, 0o700);
  const previousHome = process.env.GNUPGHOME;
  try {
    const origin = path.join(fixture.root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    git(fixture.worktree, 'remote', 'add', 'origin', origin);
    git(fixture.worktree, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(fixture.worktree, 'src', 'base.txt'), 'advanced base\n');
    git(fixture.worktree, 'add', 'src/base.txt');
    git(fixture.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance base');
    git(fixture.worktree, 'push', '-q', 'origin', 'main');
    git(fixture.worktree, 'checkout', '-q', 'ticket/T-38-03');
    process.env.GNUPGHOME = gnupgHome;
    execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-generate-key', 'Repair Host Test <repair@example.test>', 'ed25519', 'sign', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const keys = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'],
      { encoding: 'utf8' });
    const fingerprint = keys.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
    git(fixture.worktree, 'config', 'user.signingkey', fingerprint);
    const [result] = await fixture.host.run('fix-round', {
      prs: [{ ...fixture.args.prs[0], needsBaseMerge: true }],
    });
    assert.equal(result.status, 'fixed');
    assert.equal(result.host_publication.pushed, true);
    assert.equal(git(fixture.worktree, 'rev-parse', 'HEAD^'), git(fixture.worktree, 'rev-parse', 'main'));
    git(fixture.worktree, 'verify-commit', 'HEAD');
    assert.equal(git(fixture.worktree, 'show', '-s', '--format=%GF', 'HEAD'), fingerprint);
  } finally {
    if (previousHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previousHome;
    fs.rmSync(gnupgHome, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
    releaseGpg();
  }
});

test('runs a shipped empty delivery workflow with host-owned resources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-delivery-host-'));
  try {
    const controller = owner(root, root);
    const host = createClaudeDeliveryHost({
      controller,
      runtimeHost: {
        scope: { run_id: 'run-38-03', ticket: 'T-38-03', worktree: root },
        agent() { throw new Error('empty workflow must not launch a model'); },
        applicationEvidence() { throw new Error('empty workflow has no evidence'); },
        capabilities: Object.freeze({ supportedModels: ['claude-opus-5-5'], supportedEfforts: ['low'], observedModel: true, observedEffort: true }),
        recorder: createDurableRecorder(path.join(root, 'receipts')),
      },
    });
    assert.deepEqual(await host.run('executors', { tickets: [] }), []);
    assert.deepEqual(await host.run('fix-round', { prs: [] }), []);
    assert.throws(() => host.run('unknown', {}), /unsupported delivery workflow/);
    assert.throws(() => host.run('executors', { scriptPath: '/tmp/forged.mjs', tickets: [] }), /script path or host resources/);
    assert.throws(() => host.run('executors', { tickets: [{ id: 'T-wrong', worktreePath: root }] }), /contradicts the runtime ticket/);
    assert.throws(() => host.run('executors', { tickets: [{ id: 'T-38-03', worktreePath: root }, { id: 'T-38-03', worktreePath: root }] }), /only one ticket/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing runtime evidence services before dispatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-delivery-missing-'));
  try {
    const controller = owner(root, root);
    assert.throws(() => createClaudeDeliveryHost({ runtimeHost: { agent() {} } }), /real run controller/);
    assert.throws(() => createClaudeDeliveryHost({ controller, runtimeHost: { agent() {} } }),
      /lacks agent, application evidence, capabilities, or a durable recorder/);
    assert.throws(() => createClaudeDeliveryHost({ controller, runtimeHost: {
      scope: { run_id: 'run-38-03', ticket: 'T-38-03', worktree: root },
      agent() {}, applicationEvidence() {}, capabilities: {}, recorder: {},
    } }), /durable recorder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps signing sockets and receipt files outside the launched worktree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-delivery-storage-'));
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  let launched;
  try {
    const controller = owner(root, worktree);
    const host = createClaudeDeliveryHost({
      scope: { run_id: 'run-38-03', ticket: 'T-38-03', phase: 38, worktree },
      controller,
      storageRoot: path.join(root, 'host-storage'),
      probe: { status: 'available' },
      createRuntimeHost(options) {
        launched = options;
        return {
          scope: options.scope,
          agent() { throw new Error('empty workflow must not launch'); },
          applicationEvidence() { throw new Error('empty workflow has no evidence'); },
          capabilities: Object.freeze({ supportedModels: ['claude-opus-5-5'], supportedEfforts: ['low'], observedModel: true, observedEffort: true }),
          recorder: createDurableRecorder(options.recorderDir),
        };
      },
    });
    assert.deepEqual(await host.run('executors', { tickets: [] }), []);
    for (const name of ['GNUPGHOME', 'GPG_AGENT_INFO', 'GPG_TTY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID']) {
      assert.equal(launched.env[name], undefined);
    }
    assert.ok(launched.recorderDir.startsWith(path.join(root, 'host-storage')));
    assert.ok(launched.transcriptDir.startsWith(path.join(root, 'host-storage')));
    assert.ok(!launched.recorderDir.startsWith(worktree));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a ticket whose live branch contradicts the canonical graph before launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-delivery-graph-'));
  const worktree = path.join(root, 'repo');
  const graphDir = path.join(root, 'graph');
  fs.mkdirSync(worktree);
  fs.mkdirSync(graphDir);
  try {
    const controller = owner(root, worktree);
    execFileSync('git', ['-C', worktree, 'init', '-q', '-b', 'ticket/T-38-03'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({
      tickets: { 'T-38-03': { branch: 'ticket/other', pr_base: 'main', files: ['src/file.js'] } },
    }));
    const host = createClaudeDeliveryHost({
      graphDir,
      controller,
      runtimeHost: {
        scope: { run_id: 'run-38-03', ticket: 'T-38-03', worktree },
        agent() { throw new Error('preflight must refuse before launch'); },
        applicationEvidence() { throw new Error('preflight has no evidence'); },
        capabilities: Object.freeze({ supportedModels: ['claude-opus-5-5'], supportedEfforts: ['low'], observedModel: true, observedEffort: true }),
        recorder: createDurableRecorder(path.join(root, 'receipts')),
      },
    });
    assert.throws(() => host.run('executors', { tickets: [{
      id: 'T-38-03', branch: 'ticket/other', prBase: 'main', worktreePath: worktree,
    }] }), /branch differs from the canonical graph/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executor refuses a substituted plan before dispatch', () => {
  const fixture = repairFixture();
  try {
    const other = path.join(fixture.root, 'other-plan.md');
    fs.writeFileSync(other, '# Wrong plan\n');
    assert.throws(() => fixture.host.run('executors', { tickets: [{
      id: 'T-38-03', branch: 'ticket/T-38-03', prBase: 'main',
      worktreePath: fixture.worktree, planPath: other,
      model: 'claude-opus-5-5', effort: 'medium',
    }] }), /workflow plan differs from the canonical graph/);
    assert.equal(fixture.launches(), 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('investigation inlines its approved contract without exposing the plugin path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-investigation-runtime-'));
  const evidence = new WeakMap();
  const prompts = [];
  const labels = {
    'system-state': 'system state',
    alternatives: 'alternatives',
    constraints: 'constraints',
    risks: 'risks and unknowns',
  };
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Investigation Test');
    git(root, 'config', 'user.email', 'investigation@example.test');
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(root, 'add', 'base.txt');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
    const graphDir = path.join(root, '.planning', 'graph');
    const invPath = path.join(root, '.planning', 'investigations', 'INV-TEST');
    const artifactRoot = path.join(invPath, 'research');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{"tickets":{}}');
    const sourceRevision = git(root, 'rev-parse', 'HEAD');
    const policyHash = policy.resolveDispatch({ runtime: 'claude', role: 'research', signals: { type: 'facts' } }).policy_hash;
    const controller = owner(root, root);
    const host = createClaudeDeliveryHost({
      graphDir,
      storageRoot: path.join(root, 'host-state'),
      controller,
      runtimeHost: {
        scope: { run_id: 'run-38-03', ticket: 'T-38-03', worktree: root },
        agent(prompt, options) {
          prompts.push(prompt);
          const id = options.label.split(':').pop();
          const file = path.join(artifactRoot, `${id}.md`);
          const content = `# Research ${id}\n`;
          fs.writeFileSync(file, content);
          const sha256 = crypto.createHash('sha256').update(content).digest('hex');
          const result = { id, status: 'completed', summary: id,
            artifact: { path: file, bytes: Buffer.byteLength(content), content_bytes: Buffer.byteLength(content), sha256, digest: sha256 } };
          evidence.set(result, transcriptEvidence({
            launch_id: `claude-investigation-${id}`,
            applied_model: options.model,
            applied_effort: options.effort,
            observed_model: options.model,
            observed_effort: options.effort,
          }));
          return result;
        },
        applicationEvidence: ({ result }) => evidence.get(result),
        capabilities: Object.freeze({ supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true }),
        recorder: createDurableRecorder(path.join(root, 'receipts')),
      },
    });
    const result = await host.run('investigation-research', {
      invId: 'INV-TEST',
      invPath,
      worktreePath: root,
      artifactContract: 'planning.v1',
      artifactRoot,
      artifactPaths: Object.fromEntries(Object.keys(labels).map((id) => [id, path.join(artifactRoot, `${id}.md`)])),
      sourceRevision,
      repository: 'shipyard/test',
      policyHash,
      problemStatement: 'Inspect the runtime boundary',
      referencePath: REFERENCE_PATHS['inv-research'],
      lines: Object.entries(labels).map(([id, label]) => ({ id, label, model: 'claude-opus-5-5', effort: 'medium', signals: { type: 'facts' } })),
    });
    assert.equal(result.length, 4);
    assert.equal(prompts.length, 4);
    assert.ok(result.every((line) => line.status === 'completed' && line.artifact_index && line.artifact_digest));
    for (const line of result) {
      assert.equal(line.artifact_index.sha256,
        crypto.createHash('sha256').update(fs.readFileSync(line.artifact_index.path)).digest('hex'));
      assert.equal(line.artifact_digest,
        crypto.createHash('sha256').update(fs.readFileSync(line.artifact_ref)).digest('hex'));
    }
    const original = path.join(artifactRoot, 'system-state.md');
    fs.writeFileSync(original, '# changed after seal\n');
    const sealed = result.find((line) => line.id === 'system-state');
    assert.notEqual(sealed.artifact_index.path, original);
    assert.equal(sealed.artifact_index.sha256,
      crypto.createHash('sha256').update(fs.readFileSync(sealed.artifact_index.path)).digest('hex'));
    for (const prompt of prompts) {
      assert.match(prompt, /Research contract:/);
      assert.ok(!prompt.includes(REFERENCE_PATHS['inv-research']));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixed repair signs before sealing and reaches only the trusted publication hook', async () => {
  const releaseGpg = await holdGpg();
  const fixture = repairFixture({
    status: 'fixed', changeCode: true,
    hostOptions: {
      publishRepair(repair, commit) {
        assert.equal(repair.ticket, 'T-38-03');
        assert.equal(commit.commit, git(repair.worktree, 'rev-parse', 'HEAD'));
        assert.equal(fs.existsSync(path.join(repair.worktree, '.shipyard-role-artifacts')), true);
        throw new Error('publication intentionally blocked by test');
      },
    },
  });
  const gnupgHome = fs.mkdtempSync('/tmp/crh-gpg-');
  fs.chmodSync(gnupgHome, 0o700);
  const previousHome = process.env.GNUPGHOME;
  try {
    process.env.GNUPGHOME = gnupgHome;
    execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-generate-key', 'Repair Host Test <repair@example.test>', 'ed25519', 'sign', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const keys = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'],
      { encoding: 'utf8' });
    const fingerprint = keys.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
    git(fixture.worktree, 'config', 'user.signingkey', fingerprint);
    await assert.rejects(() => fixture.host.run('fix-round', fixture.args),
      /publication intentionally blocked by test/);
    git(fixture.worktree, 'verify-commit', 'HEAD');
    assert.equal(git(fixture.worktree, 'show', '-s', '--format=%GF', 'HEAD'), fingerprint);
    assert.equal(git(fixture.worktree, 'show', 'HEAD:src/owned.txt'), 'after');
    assert.equal(fs.existsSync(path.join(fixture.worktree, '.shipyard-repair-evidence.md')), true);
  } finally {
    if (previousHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previousHome;
    fs.rmSync(gnupgHome, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
    releaseGpg();
  }
});

test('review repair publishes its signed code before host review actions', async () => {
  const releaseGpg = await holdGpg();
  let published = false;
  let acted = false;
  const fixture = repairFixture({
    status: 'fixed', needsReviewFix: true, changeCode: true,
    result: { review_dispositions: [{
      thread_id: 'thread-1', action: 'reply-and-resolve', reply: 'Fixed the guard.',
      evidence: { command: 'node --test guard.test.cjs', result: 'exit 0' },
    }] },
    hostOptions: {
      fetchReviewFeedback() { return { pr: 303, threads: [{ id: 'thread-1', comments: ['Fix the guard.'] }] }; },
      publishRepair(repair, commit, mode) {
        assert.equal(mode.deferReinit, true);
        assert.equal(commit.commit, git(repair.worktree, 'rev-parse', 'HEAD'));
        git(repair.worktree, 'verify-commit', 'HEAD');
        published = true;
        return { pushed: true, commit: commit.commit, reviewer_reinitialized: false };
      },
      applyReviewActions({ dispositions }) {
        assert.equal(published, true);
        assert.equal(dispositions[0].thread_id, 'thread-1');
        acted = true;
        return { applied: true };
      },
    },
  });
  const gnupgHome = fs.mkdtempSync('/tmp/crh-review-gpg-');
  fs.chmodSync(gnupgHome, 0o700);
  const previousHome = process.env.GNUPGHOME;
  try {
    process.env.GNUPGHOME = gnupgHome;
    execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-generate-key', 'Repair Host Test <repair@example.test>', 'ed25519', 'sign', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const keys = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'],
      { encoding: 'utf8' });
    const fingerprint = keys.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
    git(fixture.worktree, 'config', 'user.signingkey', fingerprint);
    const [result] = await fixture.host.run('fix-round', fixture.args);
    assert.equal(published, true);
    assert.equal(acted, true);
    assert.equal(result.host_publication.pushed, true);
  } finally {
    if (previousHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previousHome;
    fs.rmSync(gnupgHome, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
    releaseGpg();
  }
});

done();
