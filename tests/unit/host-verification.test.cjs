'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planCommands, admit, run, evidence, readEvidence, verifyPlan } = require('../../plugins/delivery-pipeline/scripts/host-verification.cjs');

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
