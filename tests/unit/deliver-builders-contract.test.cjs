'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');
const deliverPath = path.join(repositoryRoot, 'plugins/delivery-pipeline/commands/deliver.md');
const scriptPath = path.join(repositoryRoot, 'plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
const dispatcher = require(scriptPath);
const deliver = fs.readFileSync(deliverPath, 'utf8');

suite('deliver request builders: command contract');

test('deliver.md uses the build subcommand for all three roles', () => {
  for (const role of ['arch-review', 'ci-fix', 'review-fix']) {
    assert.ok(deliver.includes(`deliver-dispatch.cjs build ${role}`), `${role} builder command is missing`);
  }
});

test('the referenced script and build subcommand resolve', () => {
  assert.ok(fs.existsSync(scriptPath));
  assert.equal(typeof dispatcher.build, 'function');
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /command === 'build'/);
});

test('these role instructions no longer hand-build boundary requests', () => {
  const ciStart = deliver.indexOf('first | progress | repeat | repeat_exhausted — build the role request');
  const reviewStart = deliver.indexOf('b. reviewers.cjs feedback <pr>');
  const archStart = deliver.indexOf('c. arch-review agent — host-bound judgment');
  const archEnd = deliver.indexOf('the same step runs the degenerate-green detector', archStart);
  assert.ok(ciStart >= 0 && reviewStart > ciStart && archStart > reviewStart && archEnd > archStart);

  const ci = deliver.slice(ciStart, reviewStart);
  const review = deliver.slice(reviewStart, archStart);
  const arch = deliver.slice(archStart, archEnd);
  for (const [role, section] of [['ci-fix', ci], ['review-fix', review], ['arch-review', arch]]) {
    assert.ok(section.includes(`deliver-dispatch.cjs build ${role}`), `${role} section does not use its builder`);
    assert.ok(!section.includes('boundary.dispatch('), `${role} section still hand-builds a boundary request`);
  }
});

const step5 = deliver.slice(deliver.indexOf('## Step 5'), deliver.indexOf('## Rules'));

test('phase finale orders publication, prelaunch gate, integrator, architecture review and ready', () => {
  let previous = -1;
  for (const token of ['phase-code-review.cjs status', 'build code-review', 'phase-code-review.cjs publish',
    'phase-code-review.cjs gate', "role: 'integrator'", 'build arch-review', 'gh pr ready']) {
    const index = step5.indexOf(token);
    assert.ok(index > previous, `${token} must follow the prior finale step`); previous = index;
  }
  assert.match(step5, /unmatched[\s\S]*stop in both modes/);
  assert.ok(step5.indexOf('status --porcelain --untracked-files=all') < step5.indexOf('build code-review'));
  assert.ok(deliver.includes('deliver-dispatch.cjs build code-review'));
  assert.match(deliver.slice(0, deliver.indexOf('## Principle')), /delivery_pipeline.code_review[\s\S]*report/);
  assert.ok(!/gsd-code-review[^\n]*--fix/.test(deliver));
  assert.ok(!deliver.includes('builder exits 2'));
});

test('review roles use the prepared-context CLI and preserve the integrator in-process route', () => {
  assert.match(step5, /codex-delivery-host.cjs --args-file/);
  assert.match(step5, /mode-0600/);
  assert.match(step5, /mktemp -d/);
  assert.match(step5, /outside every worktree/);
  assert.match(step5, /createClaudeRoleHost\(options\).run\(request\)/);
  assert.match(step5, /options.graphDir/);
  assert.strictEqual((step5.match(/createCodexDeliveryHost\(\{/g) || []).length, 1);
  assert.match(step5, /createCodexDeliveryHost\(\{[\s\S]*?role: 'integrator'/);
});

test('restore runs after live evidence reads and before every integrator outcome branch', () => {
  const restore = step5.indexOf('Restore the epic worktree (every integrator outcome)');
  assert.ok(restore > step5.indexOf("role: 'integrator'"));
  assert.ok(restore > step5.indexOf('gsd-sync.cjs'));
  assert.ok(restore < step5.indexOf('build arch-review'));
  assert.ok(restore < step5.indexOf('fix tickets as new plans in the same phase'));
  const body = step5.slice(restore, step5.indexOf('fix tickets as new plans in the same phase'));
  for (const outcome of ['passed', 'needs-fix', 'human-review-required']) assert.ok(body.includes(outcome));
  assert.match(body, /role-artifact.cjs prepare[\s\S]*?--role integrator/);
  assert.match(body, /status --porcelain --untracked-files=all/);
  assert.match(body, /checkout -- .planning\/phases/);
  assert.match(body, /seal or validate refusal/);
});

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { statusIgnoringScratch } = require('../../plugins/delivery-pipeline/scripts/conveyor-scratch.cjs');
const { prepareRoleArtifact } = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const phase = '52-review';
const integration = `.planning/phases/${phase}/INTEGRATION.md`;
const archived = '.shipyard-role-artifacts/sealed/INTEGRATION.md';
function integrationRepo(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'integration-restore-')));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'commit.gpgsign', 'false']);
    write('source.txt', 'one commit'); git(['add', 'source.txt']); git(['commit', '--quiet', '-m', 'base']);
    run({ root, git, write, status: forJudge => statusIgnoringScratch(root, { untracked: 'all', forJudge }).entries,
      clear: () => prepareRoleArtifact({ worktreePath: root, role: 'integrator', phase }) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('live integration evidence refuses both hosts; prepare clears exactly the role file', () => {
  integrationRepo(({ write, status, clear }) => {
    write(integration, 'Verdict: passed'); write(archived, 'sealed');
    for (const flag of [true, false]) assert.ok(status(flag).some(entry => entry.path === integration));
    assert.ok(status(true).some(entry => entry.path === archived));
    assert.ok(!status(false).some(entry => entry.path === archived));
    assert.strictEqual(clear().cleared, true); assert.deepStrictEqual(status(false), []);
    write('.shipyard-role-artifacts-neighbor.txt', 'unrelated');
    assert.deepStrictEqual(status(false).map(entry => entry.path), ['.shipyard-role-artifacts-neighbor.txt']);
  });
});

test('clearing modified committed integration evidence leaves a deletion until checkout', () => {
  integrationRepo(({ git, write, status, clear }) => {
    write(integration, 'committed'); git(['add', integration]); git(['commit', '--quiet', '-m', 'evidence']);
    write(integration, 'modified');
    assert.deepStrictEqual(status(false), [{ status: ' M', path: integration }]);
    clear(); assert.deepStrictEqual(status(false), [{ status: ' D', path: integration }]);
    git(['checkout', '--', integration]); assert.deepStrictEqual(status(false), []);
  });
});

for (const outcome of ['passed', 'needs-fix', 'human-review-required']) {
  test(`after a ${outcome} verdict the live INTEGRATION.md still refuses the next review until restored`, () => {
    integrationRepo(({ write, status, clear }) => {
      write(integration, `# Integration\nVerdict: ${outcome}\n`); write(archived, 'authenticated archive stand-in');
      assert.deepStrictEqual(status(false).map(entry => entry.path), [integration]);
      assert.deepStrictEqual(status(true).map(entry => entry.path).sort(), [integration, archived].sort());
      assert.strictEqual(clear().cleared, true); assert.deepStrictEqual(status(false), []);
      assert.deepStrictEqual(status(true).map(entry => entry.path), [archived]);
      assert.strictEqual(clear().cleared, false);
    });
  });
  test(`committed integration evidence is restored after ${outcome}`, () => {
    integrationRepo(({ git, write, status, clear }) => {
      write(integration, 'committed'); git(['add', integration]); git(['commit', '--quiet', '-m', 'evidence']);
      write(integration, `Verdict: ${outcome}\n`);
      assert.strictEqual(clear().cleared, true);
      git(['checkout', '--', integration]);
      assert.deepStrictEqual(status(false), []); assert.deepStrictEqual(status(true), []);
    });
  });
}

done();
