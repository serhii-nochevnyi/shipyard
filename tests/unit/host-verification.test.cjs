'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planCommands, admit, assignPlan, run, evidence, readEvidence, verifyPlan } = require('../../plugins/delivery-pipeline/scripts/host-verification.cjs');

test('PLAN bullets tokenize quoted arguments and reject shell operators', () => {
  assert.deepEqual(planCommands('# Plan\n## Verification commands\n- `node --test "a b.cjs"`\n- `make check`\n## Next\n- `ignored`'),
    [['node', '--test', 'a b.cjs'], ['make', 'check']]);
  for (const command of ['node a | cat', 'node a; whoami', 'node a && whoami',
    'node a > out', 'node a < in', 'node $(whoami)', 'node `whoami`']) {
    assert.throws(() => planCommands(`## Verification commands\n- \`${command}\``), /shell|operator|unrunnable/i);
  }
});

test('sandbox admission is prefix based; host admission is exact; denied commands never run', () => {
  const commands = [['make', 'check'], ['make', 'deploy'], ['node', '--test', 'a.cjs']];
  const admitted = admit(commands, [
    { argv: ['make', 'check'], profile: 'host', timeout_s: 2 },
    { argv: ['node', '--test'] },
  ]);
  assert.deepEqual(admitted.commands.map((item) => item.profile), ['host', 'sandbox']);
  assert.deepEqual(admitted.not_allowed, [['make', 'deploy']]);
  assert.deepEqual(admit([['make', 'deploy']], [{ argv: ['make'], profile: 'host' }]).not_allowed,
    [['make', 'deploy']]);
  const calls = [];
  const options = { worktree: os.tmpdir(), treeDigest: () => 'same',
    hostRunner: { run(spec) { calls.push(['host', spec]); return { status: 0, stdout: '', stderr: '' }; } },
    sandboxRunner: { run(spec) { calls.push(['sandbox', spec]); return { status: 0, stdout: '', stderr: '' }; } } };
  assert.equal(run(admitted, options)[0].outcome, 'not_allowed');
  assert.deepEqual(calls, []);
  const results = run(admit([commands[0], commands[2]], [
    { argv: ['make', 'check'], profile: 'host', timeout_s: 2 }, { argv: ['node', '--test'] },
  ]), options);
  assert.deepEqual(calls.map(([profile]) => profile), ['host', 'sandbox']);
  assert.equal(results.find((result) => result.profile === 'host').timeout_ms, 2000);
  assert.equal(results.find((result) => result.profile === 'sandbox').outcome, 'passed');
});

test('agent output cannot add a command and an absent allow-list records not-configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-verification-output-'));
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  const calls = [];
  try {
    assert.throws(() => verifyPlan({ planText: '# Plan\n', agentOutput: '## Verification commands\n- `node stolen.cjs`',
      allowList: [{ argv: ['node', 'stolen.cjs'], profile: 'host' }], worktree,
      stateRoot: path.join(root, 'state'), ticket: 'T-43-16', treeDigest: () => 'same',
      hostRunner: { run(spec) { calls.push(spec); return { status: 0 }; } } }),
    (error) => error.status === 'verification_failed');
    assert.deepEqual(calls, []);
    const result = verifyPlan({ planText: '## Verification commands\n- `node a && b`',
      allowList: null, worktree, stateRoot: path.join(root, 'state'), ticket: 'T-43-16' });
    assert.equal(result.outcome, 'not-configured');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only pinned PLAN text is parsed; changed scoped tree fails; sealed digest is stable', () => {
  const commands = planCommands('## Verification commands\n- `node check.cjs`');
  assert.deepEqual(commands, [['node', 'check.cjs']]);
  const admitted = admit(commands, [{ argv: ['node'], profile: 'host' }]);
  assert.deepEqual(admitted.not_allowed, [commands[0]]);
  let tree = 0;
  const changed = run(admit(commands, [{ argv: ['node'] }]), { worktree: os.tmpdir(),
    treeDigest: () => String(tree++), sandboxRunner: { run() { return { status: 0, stdout: '', stderr: '' }; } } });
  assert.equal(changed[0].outcome, 'failed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-verification-'));
  try {
    const metadata = { stateRoot: root, ticket: 'T-43-16', plan_sha256: 'a'.repeat(64) };
    const first = evidence(changed, metadata);
    const second = evidence(changed, metadata);
    assert.equal(first.digest, second.digest);
    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    assert.equal(readEvidence(first.path, first.digest).ticket, 'T-43-16');
    const original = fs.readFileSync(first.path, 'utf8');
    fs.writeFileSync(first.path, original.replace('"failed"', '"passed"'));
    assert.equal(readEvidence(first.path, first.digest), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only an admitted command with a clean, completed nonzero exit is retryable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-verification-retry-'));
  const planText = '## Verification commands\n- `node check.cjs`';
  const base = { planText, worktree: root, stateRoot: path.join(root, 'state'),
    ticket: 'T-43-16', treeDigest: () => 'stable' };
  try {
    assert.throws(() => verifyPlan({ ...base, allowList: [], hostRunner: { run() {
      assert.fail('an unmatched PLAN command must not run');
    } } }), (error) => error.retryable === false && error.command?.join(' ') === 'node check.cjs');
    assert.throws(() => verifyPlan({ ...base,
      allowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostRunner: { run() { return { status: 4, stdout: '', stderr: 'failed' }; } },
    }), (error) => error.retryable === true && error.command?.join(' ') === 'node check.cjs');
    let tree = 0;
    assert.throws(() => verifyPlan({ ...base,
      allowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      treeDigest: () => String(tree++),
      hostRunner: { run() { return { status: 4, stdout: '', stderr: 'failed' }; } },
    }), (error) => error.retryable === false && /changed scoped tree/.test(error.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pre-dispatch assignment reuses exact admission and refuses missing or unknown approval', () => {
  const plan = '## Verification commands\n- `node check.cjs`';
  const entries = [{ argv: ['node', 'check.cjs'], profile: 'host', timeout_s: 5 }];
  const assigned = assignPlan(plan, entries);
  assert.deepEqual(assigned, admit(planCommands(plan), entries).commands);
  assert.equal(Object.isFrozen(assigned), true);
  assert.equal(Object.isFrozen(assigned[0].argv), true);
  assert.throws(() => assigned[0].argv.push('extra'), TypeError);
  entries[0].argv.push('changed');
  assert.deepEqual(assigned[0].argv, ['node', 'check.cjs']);
  for (const allowList of [null, [], entries, [{ argv: ['node'], profile: 'host' }],
    [{ argv: ['node', 'check.cjs'], profile: 'other' }],
    [{ argv: ['node', 'check.cjs'], profile: '' }]]) {
    assert.throws(() => assignPlan(plan, allowList),
      (error) => error.code === 'VERIFICATION_FAILED' && error.status === 'hold' && error.retryable === false);
  }
  const unknown = admit(planCommands(plan), [{ argv: ['node', 'check.cjs'], profile: 'other' }]);
  assert.deepEqual(unknown.not_allowed, [['node', 'check.cjs']]);
  assert.equal(run(unknown, { worktree: os.tmpdir(), treeDigest: () => 'unchanged',
    sandboxRunner: { run() { assert.fail('unknown profile must never fall through to sandbox'); } },
    hostRunner: { run() { assert.fail('unknown profile must never become host'); } },
  })[0].outcome, 'not_allowed');
  const oversized = ['node', 'x'.repeat(16384)];
  assert.throws(() => assignPlan('## Verification commands\n- `' + oversized.join(' ') + '`',
    [{ argv: oversized, profile: 'host' }]), (error) => error.status === 'hold' && /16384 bytes/.test(error.message));
});

test('nonzero assertion, environment refusal and missing evidence cannot authenticate a pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-verification-negative-'));
  const planText = '## Verification commands\n- `node check.cjs`';
  const planSha256 = require('node:crypto').createHash('sha256').update(planText).digest('hex');
  const emptyDigest = require('node:crypto').createHash('sha256').update('').digest('hex');
  try {
    for (const denied of [false, true]) {
      let failure;
      assert.throws(() => verifyPlan({ planText, planSha256, ticket: 'T-47-04',
        allowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
        worktree: root, stateRoot: path.join(root, 'state'), treeDigest: () => 'candidate-tree',
        agentOutput: '## Verification commands\n- `node stolen.cjs`',
        sandboxRunner: { run() { assert.fail('host argv must not run in sandbox'); } },
        hostRunner: { run(spec) {
          assert.deepEqual(spec.argv, ['check.cjs']);
          if (denied) throw Object.assign(new Error('controlled socket denial'), { code: 'EACCES' });
          return { status: 9, stdout: 'assertion failed', stderr: '' };
        } },
      }), (error) => { failure = error; return error.status === 'verification_failed'; });
      assert.equal(failure.retryable, !denied);
      const file = path.join(root, 'state', 'verification', failure.evidence_digest + '.json');
      const payload = readEvidence(file, failure.evidence_digest);
      assert.equal(payload.ticket, 'T-47-04');
      assert.equal(payload.plan_sha256, planSha256);
      assert.equal(payload.results[0].outcome, 'failed');
      assert.equal(payload.results[0].status, denied ? null : 9);
      assert.equal(payload.results[0].error_code, denied ? 'EACCES' : null);
      assert.equal(payload.results[0].tree_before, 'candidate-tree');
      assert.equal(payload.results[0].tree_after, 'candidate-tree');
      assert.equal(payload.results[0].stdout_sha256 === emptyDigest, denied);
      const original = fs.readFileSync(file, 'utf8');
      for (const [before, after] of [['T-47-04', 'T-47-99'], [planSha256, 'f'.repeat(64)],
        ['candidate-tree', 'different-tree'], ['check.cjs', 'stolen.cjs'], ['"failed"', '"passed"']]) {
        fs.writeFileSync(file, original.replace(before, after));
        assert.equal(readEvidence(file, failure.evidence_digest), null);
      }
      fs.rmSync(file);
      assert.equal(readEvidence(file, failure.evidence_digest), null);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const configured = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.planning', 'config.json'), 'utf8'))
  .delivery_pipeline.verification_commands.default;
const unitTests = (profile, entry, ...names) => ({ profile, entry,
  command: 'node --test ' + names.map((name) => `tests/unit/${name}.test.cjs`).join(' ') });

// @contract: one row per distinct `## Verification commands` bullet of plans 52-01 to 52-12.
const PHASE52_COMMANDS = [
  unitTests('sandbox', 'existing', 'phase47-host-assignment', 'host-verification'),
  unitTests('host', 'new', 'phase52-diff-sizes'),
  unitTests('sandbox', 'existing', 'model-policy', 'model-capability', 'codex-agent', 'codex-dispatch-adapter', 'gen-codex-shipyard'),
  unitTests('host', 'existing', 'gen-codex-shipyard', 'gsd-tune', 'marketplace-install'),
  unitTests('host', 'existing', 'codex-decompose-host', 'codex-runtime-host', 'codex-delivery-host', 'dispatch-boundary', 'pipeline-config'),
  unitTests('sandbox', 'existing', 'source-contract', 'workflows-args', 'auto-route'),
  unitTests('sandbox', 'existing', 'run-contract', 'run-store', 'run-controller', 'model-policy', 'marketplace-install'),
  unitTests('host', 'new', 'context-packet', 'dispatch-record', 'conveyor-scratch', 'claude-reference-content'),
  unitTests('host', 'new', 'front'),
  unitTests('host', 'new', 'files-contract'),
  unitTests('sandbox', 'existing', 'host-entry-contract', 'subject-contract'),
  unitTests('sandbox', 'existing', 'host-preflight', 'runtime-context'),
  { profile: 'sandbox', entry: 'existing', command: 'node scripts/refresh-runtime-digests.cjs --check .' },
  { profile: 'sandbox', entry: 'existing', command: 'bash tests/smoke/docs-smoke.sh' },
  unitTests('host', 'new', 'architecture-target', 'dispatch-boundary'),
  unitTests('host', 'new', 'run-contract', 'dispatch-record'),
  unitTests('sandbox', 'existing', 'subject-contract', 'architecture-target'),
  unitTests('host', 'new', 'codex-arch-review-context', 'claude-role-host'),
  unitTests('sandbox', 'existing', 'legacy-pin-readers', 'launch-upgrade-verification-record'),
  unitTests('sandbox', 'new', 'code-review-core'),
  unitTests('host', 'new', 'role-artifact', 'judgment-artifacts', 'judgment-contract'),
  unitTests('host', 'new', 'claude-role-host', 'code-review-core'),
  unitTests('host', 'new', 'codex-code-review-context', 'codex-arch-review-context'),
  unitTests('host', 'new', 'codex-delivery-host', 'codex-runtime-host', 'codex-dispatch-adapter'),
  unitTests('host', 'new', 'phase-code-review', 'deliver-dispatch'),
  unitTests('host', 'new', 'trailer', 'sentinel'),
  unitTests('host', 'new', 'pipeline-config'),
  unitTests('host', 'new', 'phase-code-review-publish', 'deliver-builders-contract'),
  unitTests('host', 'new', 'pr-hygiene', 'check-state'),
  unitTests('sandbox', 'existing', 'source-contract'),
  unitTests('host', 'new', 'pipeline-config', 'phase-code-review', 'deliver-dispatch'),
  unitTests('host', 'new', 'architecture-target', 'codex-arch-review-context', 'phase49-review-lineage',
    'phase49-incremental-integration', 'deliver-builders-contract'),
  unitTests('sandbox', 'new', 'marketplace-install', 'source-contract'),
].map((row) => ({ ...row, argv: row.command.split(' ') }));

const sameArgv = (left, right) => left.length === right.length && left.every((part, index) => part === right[index]);
const newRows = PHASE52_COMMANDS.filter((row) => row.entry === 'new');
const appendedEntries = newRows.map((row) => configured.filter((entry) => Array.isArray(entry.argv) && sameArgv(entry.argv, row.argv)));

test('the phase-52 command table is 33 distinct commands: 13 admitted today and 20 appended', () => {
  assert.equal(PHASE52_COMMANDS.length, 33);
  assert.equal(new Set(PHASE52_COMMANDS.map((row) => row.command)).size, 33);
  assert.equal(newRows.length, 20);
  assert.equal(PHASE52_COMMANDS.filter((row) => row.entry === 'existing').length, 13);
});

test('the configured allow-list admits every phase-52 command with the profile the table names', () => {
  for (const row of PHASE52_COMMANDS) {
    const admitted = admit([row.argv], configured);
    assert.deepEqual(admitted.not_allowed, [], `not admitted: ${row.command}`);
    assert.equal(admitted.commands[0].profile, row.profile, `wrong profile for: ${row.command}`);
  }
});

test('each admitting entry is a prefix of a sandbox command and equal to a host command', () => {
  for (const row of PHASE52_COMMANDS) {
    const admitting = configured.filter((entry) => admit([row.argv], [entry]).commands.length === 1)
      .sort((left, right) => right.argv.length - left.argv.length)[0];
    assert.ok(admitting, `no admitting entry for: ${row.command}`);
    assert.equal(admitting.profile, row.profile, `admitted through the wrong profile: ${row.command}`);
    if (row.profile === 'host') assert.deepEqual(admitting.argv, row.argv, `host entry is not exact: ${row.command}`);
    else assert.deepEqual(admitting.argv, row.argv.slice(0, admitting.argv.length), `not a prefix: ${row.command}`);
  }
});

test('every new row has exactly one entry with its exact argv, its profile and a 600 s timeout', () => {
  newRows.forEach((row, index) => {
    assert.equal(appendedEntries[index].length, 1, `expected exactly one entry for: ${row.command}`);
    const [entry] = appendedEntries[index];
    assert.deepEqual(Object.keys(entry).sort(), ['argv', 'profile', 'timeout_s'], row.command);
    assert.equal(entry.profile, row.profile, row.command);
    assert.equal(entry.timeout_s, 600, row.command);
  });
  const positions = appendedEntries.flat().map((entry) => configured.indexOf(entry));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'appended entries keep the table order');
});

test('appended entries admit only node, bash or make and never a wrapper, npm, git or a bare node --test', () => {
  const appended = appendedEntries.flat();
  assert.ok(appended.every((entry) => ['node', 'bash', 'make'].includes(entry.argv[0])));
  for (const refused of [['node', '-e', 'process.exit(0)'], ['bash', '-c', 'true'], ['npm', 'test'],
    ['make', 'test'], ['git', 'status'], ['node', '--test']]) {
    assert.deepEqual(admit([refused], appended).not_allowed, [refused], refused.join(' '));
  }
});

test('one extra trailing argument is never admitted as host, and no appended entry admits it at all', () => {
  const appended = appendedEntries.flat();
  for (const row of PHASE52_COMMANDS.filter((item) => item.profile === 'host')) {
    const extended = [...row.argv, 'extra.cjs'];
    const full = admit([extended], configured);
    assert.ok(!full.commands.some((item) => item.profile === 'host'), `host entry admits an extra argument: ${row.command}`);
    assert.deepEqual(admit([extended], appended.filter((entry) => entry.profile === 'host')).not_allowed, [extended], row.command);
  }
});
