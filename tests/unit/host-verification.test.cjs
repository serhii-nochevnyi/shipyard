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

test('evidence is authenticated by the host MAC, the host key and private file permissions', () => {
  const crypto = require('node:crypto');
  const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
      : JSON.stringify(value);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-verification-mac-'));
  try {
    const sealed = evidence([{ outcome: 'passed' }], { stateRoot: root, ticket: 'T-1', plan_sha256: 'a'.repeat(64) });
    const keyPath = path.join(root, 'verification', 'hmac.key');
    const key = fs.readFileSync(keyPath);
    const original = fs.readFileSync(sealed.path, 'utf8');
    const admit = () => readEvidence(sealed.path, sealed.digest);
    assert.equal(admit().ticket, 'T-1');
    const forged = (mutate) => {
      const envelope = JSON.parse(original);
      mutate(envelope);
      fs.writeFileSync(sealed.path, JSON.stringify(envelope), { mode: 0o600 });
      return readEvidence(sealed.path, crypto.createHash('sha256').update(canonical(envelope)).digest('hex'));
    };
    assert.equal(forged((envelope) => { envelope.integrity.mac = '0'.repeat(64); }), null, 'invalid MAC with recomputed digest');
    assert.equal(forged((envelope) => { envelope.payload.ticket = 'foreign'; }), null, 'tampered payload with recomputed digest');
    assert.equal(forged((envelope) => {
      envelope.payload.schema = 'foreign';
      envelope.integrity.mac = crypto.createHmac('sha256', key).update(canonical(envelope.payload)).digest('hex');
    }), null, 'authenticated payload with a foreign schema');
    fs.writeFileSync(sealed.path, original, { mode: 0o600 });
    fs.writeFileSync(keyPath, crypto.randomBytes(32));
    assert.equal(admit(), null, 'wrong key');
    fs.writeFileSync(keyPath, key);
    fs.chmodSync(keyPath, 0o644);
    assert.equal(admit(), null, 'key permissions');
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(sealed.path, 0o644);
    assert.equal(admit(), null, 'evidence permissions');
    fs.chmodSync(sealed.path, 0o600);
    assert.equal(admit().ticket, 'T-1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const REPOSITORY = path.join(__dirname, '..', '..');
const configured = JSON.parse(fs.readFileSync(path.join(REPOSITORY, '.planning', 'config.json'), 'utf8'))
  .delivery_pipeline.verification_commands.default;

test('every configured verification command has a known shape and names only files that exist', () => {
  assert.ok(configured.length > 0);
  for (const entry of configured) {
    const label = entry.argv.join(' ');
    assert.deepEqual(Object.keys(entry).sort(), ['argv', 'profile', 'timeout_s'], label);
    assert.ok(['node', 'bash', 'make'].includes(entry.argv[0]), label);
    assert.ok(['host', 'sandbox'].includes(entry.profile), label);
    assert.ok(Number.isInteger(entry.timeout_s) && entry.timeout_s > 0, label);
    for (const part of entry.argv.filter((item) => ['tests/', 'scripts/', 'plugins/'].some((prefix) => item.startsWith(prefix)))) {
      assert.ok(fs.existsSync(path.join(REPOSITORY, part)), `${label} names a missing file: ${part}`);
    }
  }
});

test('the configured allow-list refuses wrappers, npm, git and a bare node --test', () => {
  for (const refused of [['node', '-e', 'process.exit(0)'], ['bash', '-c', 'true'], ['npm', 'test'],
    ['make', 'test'], ['git', 'status'], ['node', '--test']]) {
    assert.deepEqual(admit([refused], configured).not_allowed, [refused], refused.join(' '));
  }
});

test('one extra trailing argument is never admitted through a host entry', () => {
  for (const entry of configured.filter((item) => item.profile === 'host')) {
    const extended = [...entry.argv, 'extra.cjs'];
    assert.ok(!admit([extended], configured).commands.some((item) => item.profile === 'host'), entry.argv.join(' '));
  }
});

test('both delivery hosts share the bounded verification-retry rules', () => {
  const claude = require('../../plugins/delivery-pipeline/scripts/claude-delivery-host.cjs');
  const codex = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const failure = { status: 'verification_failed', retryable: true, command: ['make', 'check'], evidence_digest: 'a'.repeat(64) };
  for (const [host, wrap] of [[claude, (value) => [value]], [codex, (value) => value]]) {
    assert.ok(host.retryableVerificationFailure(wrap(failure)));
    assert.ok(!host.retryableVerificationFailure(wrap({ ...failure, retryable: 1 })));
    const controller = (retry, woken) => ({ status: () => ({ retry }), retry: () => ({ result: { scheduled: true } }),
      wake: (runId, options) => { woken.push(options.force); return { result: { woken: true } }; } });
    const woken = [];
    assert.equal(host.scheduleVerificationRetry(controller({ attempts: 0, max_attempts: 2 }, woken), 'run', failure), true);
    assert.deepEqual(woken, [true]);
    assert.equal(host.scheduleVerificationRetry(controller({ attempts: 1, max_attempts: 2 }, woken), 'run', failure), false);
    assert.equal(host.scheduleVerificationRetry(controller({ exhausted: true }, woken), 'run', failure), false);
  }
});
