'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const { createClaudeRuntimeHost } = require(path.join(scripts, 'claude-runtime-host.cjs'));
const { createRunController } = require(path.join(scripts, 'run-controller.cjs'));
const { createRunScope } = require(path.join(scripts, 'run-scope.cjs'));

for (const origin of ['probe', 'child']) test('unavailable diagnostic preserves ' + origin + ' failure and recovery custody', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-unavailable-')));
  t.mock.method(os, 'homedir', () => root);
  const controller = createRunController({ storeDir: path.join(root, 'controller'), ownerId: 'fixture-owner' });
  const scope = createRunScope({ run_id: 'unavailable-code-review', repository_id: root, phase: 53,
    ticket: 'phase=53-custody;repository=' + root + ';tickets=' + 'c'.repeat(64)
      + ';pr=53;head=' + 'a'.repeat(40) + ';base=' + 'b'.repeat(40),
    worktree: root, runtime: 'claude', owner_id: controller.owner_id,
    dispatch: { runtime: 'claude', role: 'code-review', dispatch_id: 'original-dispatch' } });
  controller.begin(scope);
  const detail = 'native unavailable\nsecond line\r\n\u0000' + 'x'.repeat(3000);
  let dispatched = 0;
  const options = { scope, controller, recorderDir: path.join(root, 'receipts'),
    probe: origin === 'probe' ? { status: 'unavailable', reason: detail, detail }
      : { status: 'available', executable: 'registered-fixture', runtime_version: '2.1.280' },
    spawn() {
      dispatched++;
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() { process.nextTick(() => child.emit('error', new Error(detail))); } };
      return child;
    } };
  try {
    const failed = origin === 'probe' ? () => createClaudeRuntimeHost(options)
      : () => createClaudeRuntimeHost(options).agent('Review supplied product material.', { model: 'claude-sonnet-5-5', effort: 'high', readOnly: true });
    const check = error => {
      assert.equal(error.code, 'RUNTIME_UNAVAILABLE');
      assert.ok(error.message.includes(detail));
      if (origin === 'probe') assert.deepEqual(error.details.probe, options.probe);
      return true;
    };
    if (origin === 'probe') assert.throws(failed, check); else await assert.rejects(failed(), check);
    const state = controller.status(scope.run_id);
    assert.equal(state.state, 'runtime_unavailable');
    assert.equal(state.retry.attempts, 1);
    assert.equal(state.retry.last_reason.length, 2048);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(state.retry.last_reason));
    assert.equal(dispatched, origin === 'probe' ? 0 : 1);
    assert.throws(() => controller.markUnavailable(scope.run_id, { reason: detail }), { code: 'INVALID_INPUT' });
    assert.equal(controller.status(scope.run_id).retry.attempts, 1);
    const { createDurableRecorder } = require(path.join(scripts, 'dispatch-boundary.cjs'));
    assert.equal(createDurableRecorder(path.join(root, 'receipts')).getVerifiedRecord('original-dispatch'), null);
    controller.wake(scope.run_id, { force: true, reason: 'fixture capability recheck' });
    assert.equal(controller.status(scope.run_id).state, 'running');
    assert.equal(dispatched, origin === 'probe' ? 0 : 1);
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const runtime of ['codex', 'claude']) test(runtime + ' selector-only current entry preserves canonical carrier freshness', async () => {
  const { codeReviewFixtures } = require('../fixtures/phase53/code-review-native-driver.cjs');
  const { codex, fixture, setup, current } = codeReviewFixtures();
  await codex.publicIntegrationFixture(async f => {
    setup(f);
    const carrier = path.join(f.graphDir, '../phases', f.phase, 'code-review-disagreements.json');
    const bytes = Buffer.from(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [] }) + '\n');
    fs.writeFileSync(carrier, bytes);
    codex.commit(f, 'fixture canonical carrier');
    const prepared = fixture(f, runtime);
    const result = await prepared.run();
    assert.equal(result.result.review_contract, 'shipyard.semantic-review.v1');
    assert.equal(prepared.launches.length, 3);
    const accepted = current(f), report = fs.readFileSync(accepted.artifact_ref);
    assert.ok(accepted.authenticated);
    fs.writeFileSync(carrier, Buffer.concat([bytes, Buffer.from(' ')]));
    assert.equal(current(f), null);
    assert.deepEqual(fs.readFileSync(accepted.artifact_ref), report);
    fs.writeFileSync(carrier, bytes);
    assert.equal(current(f).artifact_digest, accepted.artifact_digest);
    assert.equal(prepared.launches.length, 3);
  });
});

for (const runtime of ['codex', 'claude']) test(runtime + ' original canonical carrier keeps its actual historical contract', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-original-')));
  t.mock.method(os, 'homedir', () => home);
  const producer = require('../fixtures/code-review/artifact-fixture.cjs');
  const authority = require(path.join(scripts, 'role-artifact.cjs'));
  const f = producer.fixture();
  try {
    const binding = f.advance(1);
    const carrier = path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json');
    fs.mkdirSync(path.dirname(carrier), { recursive: true });
    const original = Buffer.from(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [] }) + '\n');
    fs.writeFileSync(carrier, original);
    const input = f.input(binding);
    producer.retainPlanningInput(f, input, f.root, null, { runtime });
    const sealed = authority.sealJudgment(input);
    const report = fs.readFileSync(sealed.artifact_ref);
    assert.equal(input.result.review_contract, 'shipyard.phase-code-review.v1');
    assert.equal(f.recorder.getVerifiedRecord(input.dispatchId).runtime, runtime);
    assert.equal(f.lookup().artifact_digest, sealed.artifact_digest);
    for (const change of [() => fs.appendFileSync(carrier, ' '), () => fs.unlinkSync(carrier)]) {
      change(); assert.equal(f.lookup(), null);
      assert.deepEqual(fs.readFileSync(sealed.artifact_ref), report);
      fs.writeFileSync(carrier, original);
      assert.equal(f.lookup().artifact_digest, sealed.artifact_digest);
    }
  } finally { f.cleanup(); t.mock.restoreAll(); fs.rmSync(home, { recursive: true, force: true }); }
});
