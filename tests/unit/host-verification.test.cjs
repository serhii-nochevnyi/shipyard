'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planCommands, inspectPlan, admit, assignPlan, run, evidence, readEvidence, verifyPlan } = require('../../plugins/delivery-pipeline/scripts/host-verification.cjs');

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
  assert.deepEqual(admitted.commands.map((item) => item.profile), ['host', 'sandbox', 'sandbox']);
  assert.deepEqual(admitted.not_allowed, []);
  assert.equal(admit([['make', 'deploy']], [{ argv: ['make'], profile: 'host' }]).commands[0].profile, 'sandbox');
  const calls = [];
  const options = { worktree: os.tmpdir(), treeDigest: () => 'same',
    hostRunner: { run(spec) { calls.push(['host', spec]); return { status: 0, stdout: '', stderr: '' }; } },
    sandboxRunner: { run(spec) { calls.push(['sandbox', spec]); return { status: 0, stdout: '', stderr: '' }; } } };
  const denied = admit([['make', 'deploy']], [{ argv: ['make'], profile: 'unknown' }]);
  assert.equal(run(denied, options)[0].outcome, 'not_allowed');
  assert.deepEqual(calls, []);
  const results = run(admit([commands[0], commands[2]], [
    { argv: ['make', 'check'], profile: 'host', timeout_s: 2 }, { argv: ['node', '--test'] },
  ]), options);
  assert.deepEqual(calls.map(([profile]) => profile), ['host', 'sandbox']);
  assert.equal(results.find((result) => result.profile === 'host').timeout_ms, 2000);
  assert.equal(results.find((result) => result.profile === 'sandbox').outcome, 'passed');
});

test('agent output cannot add commands; absent allow-list still parses PLAN commands', () => {
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
    assert.throws(() => verifyPlan({ planText: '## Verification commands\n- `node a && b`',
      allowList: null, worktree, stateRoot: path.join(root, 'state'), ticket: 'T-43-16' }), /shell operator/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only pinned PLAN text is parsed; changed scoped tree fails; sealed digest is stable', () => {
  const commands = planCommands('## Verification commands\n- `node check.cjs`');
  assert.deepEqual(commands, [['node', 'check.cjs']]);
  const admitted = admit(commands, [{ argv: ['node'], profile: 'host' }]);
  assert.equal(admitted.commands[0].profile, 'sandbox');
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
    assert.throws(() => verifyPlan({ ...base, allowList: [], sandboxRunner: { run() {
      throw Object.assign(new Error('sandbox unavailable'), { code: 'SANDBOX_UNAVAILABLE' });
    } }, hostRunner: { run() { assert.fail('sandbox refusal must never fall back to host'); } } }), (error) => error.retryable === false && error.command?.join(' ') === 'node check.cjs');
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

test('pre-dispatch assignment defaults to sandbox and refuses unknown profiles', () => {
  const plan = '## Verification commands\n- `node check.cjs`';
  const entries = [{ argv: ['node', 'check.cjs'], profile: 'host', timeout_s: 5 }];
  const assigned = assignPlan(plan, entries);
  assert.deepEqual(assigned, admit(planCommands(plan), entries).commands);
  assert.equal(Object.isFrozen(assigned), true);
  assert.equal(Object.isFrozen(assigned[0].argv), true);
  assert.throws(() => assigned[0].argv.push('extra'), TypeError);
  entries[0].argv.push('changed');
  assert.deepEqual(assigned[0].argv, ['node', 'check.cjs']);
  for (const allowList of [[{ argv: ['node', 'check.cjs'], profile: 'other' }],
    [{ argv: ['node', 'check.cjs'], profile: '' }]]) {
    assert.deepEqual(inspectPlan(plan, allowList).map((problem) => problem.kind), ['invalid_profile']);
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

test('unconfigured programs default to sandbox without host authority', () => {
  for (const refused of [['node', '-e', 'process.exit(0)'], ['bash', '-c', 'true'], ['npm', 'test'],
    ['make', 'test'], ['git', 'status'], ['node', '--test']]) {
    assert.equal(admit([refused], configured).commands[0].profile, 'sandbox', refused.join(' '));
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

test('inspectPlan accepts quoted inline code but reports unquoted shell composition', () => {
  const plan = ['## Verification commands', '- `node -e "const c=1;process.exit(0)"`',
    '- `node --test a.cjs && node --test b.cjs`', '- `bash -c "true && false"`'].join('\n');
  const problems = inspectPlan(plan, null);
  assert.deepEqual(problems.map((problem) => problem.kind), ['unrunnable']);
  assert.match(problems[0].reason, /"&" is unquoted/);
  assert.throws(() => planCommands(plan), /unrunnable shell operator in PLAN command/);
});

test('inspectPlan agrees with assignPlan on absent allow-lists, empty plans and approved plans', () => {
  const plan = '## Verification commands\n- `make check`\n';
  assert.equal(inspectPlan(plan, [{ argv: ['make', 'check'] }]).length, 0);
  assert.ok(assignPlan(plan, [{ argv: ['make', 'check'] }]));
  for (const entries of [null, []]) {
    assert.deepEqual(inspectPlan(plan, entries), []);
    assert.equal(assignPlan(plan, entries)[0].profile, 'sandbox');
  }
  assert.equal(inspectPlan('# Plan\n', null).length, 0);
  assert.equal(assignPlan('# Plan\n', null), null);
  assert.deepEqual(inspectPlan('# Plan\n', [{ argv: ['make'] }]).map((problem) => problem.kind), ['no_commands']);
  assert.throws(() => assignPlan('# Plan\n', [{ argv: ['make'] }]), (error) => error.status === 'hold');
});

test('new PLAN commands default to sandbox without approval and still require passing evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-default-sandbox-'));
  const planText = '## Verification commands\n- `node --test new.test.cjs`';
  try {
    for (const allowList of [undefined, null, [], [{ argv: ['node', '--test', 'old.test.cjs'], profile: 'host' }],
      [{ argv: ['node', '--test'], profile: 'host' }]]) {
      assert.deepEqual(inspectPlan(planText, allowList), []);
      const assigned = assignPlan(planText, allowList);
      assert.equal(assigned[0].profile, 'sandbox');
      assert.equal(assigned[0].timeout_ms, 600000);
      for (const status of [0, 1]) {
        let calls = 0;
        const verify = () => verifyPlan({ planText, allowList, worktree: root, stateRoot: path.join(root, 'state'),
          ticket: 'T-default', treeDigest: () => 'stable',
          sandboxRunner: { run(spec) {
            calls++;
            assert.deepEqual(spec.argv, ['--test', 'new.test.cjs']);
            return { status, stdout: '', stderr: '' };
          } }, hostRunner: { run() { assert.fail('unconfigured commands must never execute on host'); } } });
        if (status === 0) assert.equal(verify().outcome, 'passed');
        else assert.throws(verify, (error) => error.status === 'verification_failed' && error.retryable === true);
        assert.equal(calls, 1);
      }
    }
    assert.equal(assignPlan('## Verification commands\n- `node check.cjs`',
      [{ argv: ['node'], profile: 'sandbox', timeout_s: 7 }])[0].timeout_ms, 7000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('default admission executes a real OS-sandboxed PLAN without approval and denies worktree writes', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verification-real-sandbox-')));
  try {
    try {
      require('../../plugins/delivery-pipeline/scripts/command-runner.cjs').createVerificationRunner({
        readOnlyPaths: [root, path.dirname(process.execPath)], deniedPaths: [path.join(root, 'state')],
      });
    } catch (error) {
      if (error.code !== 'SANDBOX_UNAVAILABLE' || process.env.SHIPYARD_REQUIRE_OS_SANDBOX === '1') throw error;
      t.skip(error.message); return;
    }
    require('node:child_process').execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'check.cjs'),
      "const fs = require('node:fs'); try { fs.writeFileSync('forbidden.txt', 'bad'); process.exit(9); } catch (e) { if (!['EPERM', 'EACCES', 'EROFS'].includes(e.code)) throw e; }");
    const base = { worktree: root, stateRoot: path.join(root, 'state'), ticket: 'T-real-sandbox',
      allowList: null, treeDigest: () => 'stable',
      hostRunner: { run() { assert.fail('default verification must never use the host profile'); } } };
    const sealed = verifyPlan({ ...base, planText: '## Verification commands\n- `node check.cjs`' });
    assert.equal(sealed.outcome, 'passed');
    const record = readEvidence(sealed.path, sealed.digest);
    assert.equal(record.results[0].profile, 'sandbox');
    assert.equal(fs.existsSync(path.join(root, 'forbidden.txt')), false);
    for (const shell of ['bash', 'sh']) {
      const passed = verifyPlan({ ...base,
        planText: '## Verification commands\n- `' + shell + ' -c "test 1 = 1 && exit 0"`' });
      assert.equal(passed.outcome, 'passed');
      assert.throws(() => verifyPlan({ ...base,
        planText: '## Verification commands\n- `' + shell + ' -c "true && false"`' }),
      (error) => error.status === 'verification_failed' && error.retryable === true);
    }
    const inline = verifyPlan({ ...base,
      planText: '## Verification commands\n- `node -e "const fs = require(\'node:fs\'); try { fs.writeFileSync(\'forbidden.txt\', \'x\'); process.exit(9); } catch (e) { if (e.code !== \'EPERM\' && e.code !== \'EACCES\' && e.code !== \'EROFS\') throw e; }"`' });
    assert.equal(inline.outcome, 'passed');
    assert.equal(fs.existsSync(path.join(root, 'forbidden.txt')), false);
    assert.throws(() => verifyPlan({ ...base,
      planText: '## Verification commands\n- `node -e "process.exit(3)"`' }),
    (error) => error.status === 'verification_failed' && error.retryable === true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('quoted inline scripts preserve operators, escaped quotes, regexes and literal substitutions', () => {
  const scripts = [
    String.raw`const fs = require('node:fs'); const text = fs.readFileSync('README.md', 'utf8'); ['options.style', 'greet(\'Ada\')'].forEach(value => { if (!text.includes(value)) throw new Error(value); });`,
    String.raw`const text = "a;b|c&d<e>f$g"; if (!/\w+\x3b/.test(text)) process.exit(1);`,
    'console.log(`literal $(touch forbidden) ${1 + 2}`)',
  ];
  for (const script of scripts) {
    const command = 'node -e ' + JSON.stringify(script);
    const plan = '## Verification commands\n- `' + command + '`';
    const [argv] = planCommands(plan);
    assert.deepEqual(argv, ['node', '-e', script]);
    assert.deepEqual(inspectPlan(plan, null), []);
    assert.equal(assignPlan(plan, null)[0].profile, 'sandbox');
    new (require('node:vm').Script)(argv[2]);
  }
  assert.deepEqual(planCommands('## Verification commands\n- `node "a b.cjs"`'), [['node', 'a b.cjs']]);
  assert.throws(() => planCommands('## Verification commands\n- `node "unterminated`'), /quoted/);
  assert.throws(() => planCommands('## Verification commands\n- `node trailing' + String.fromCharCode(92) + '`'), /escape/);
});

test('explicit shells are sandboxed by default and retain exact host admission', () => {
  const plan = '## Verification commands\n- `bash -c "true && false"`';
  const argv = ['bash', '-c', 'true && false'];
  assert.deepEqual(planCommands(plan), [argv]);
  assert.equal(assignPlan(plan, null)[0].profile, 'sandbox');
  assert.equal(assignPlan(plan, [{ argv: ['bash'], profile: 'host' }])[0].profile, 'sandbox');
  assert.equal(assignPlan(plan, [{ argv, profile: 'host' }])[0].profile, 'host');
  assert.equal(assignPlan(plan, [{ argv: ['bash', '-c', 'true'], profile: 'host' }])[0].profile, 'sandbox');
});
