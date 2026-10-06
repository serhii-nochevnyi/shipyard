'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const controllerModule = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const hostFile = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
const runtimeFile = require.resolve('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const ids = ['system-state', 'alternatives', 'constraints', 'risks'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const capabilities = { supportedModels: ['gpt-6-luna', 'gpt-6.1-sol'],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] };

if (process.env.SHIPYARD_RESEARCH_HANDBACK_FIXTURE) {
  const config = JSON.parse(fs.readFileSync(process.env.SHIPYARD_RESEARCH_HANDBACK_FIXTURE, 'utf8'));
  os.homedir = () => config.home;
  const controllerFile = require.resolve('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
  require.cache[controllerFile].exports = { ...controllerModule, createRunController(options) {
    const controller = controllerModule.createRunController(options);
    const wrapped = { ...controller };
    for (const method of ['begin', 'status', 'fail', 'release', 'complete']) {
      wrapped[method] = (...args) => {
        fs.appendFileSync(config.events, method + '\n');
        if (method === 'fail') fs.writeFileSync(config.failureReason, JSON.stringify(args[1]));
        if (method === 'begin' && config.beginRefusal) {
          throw Object.assign(new Error(config.cause), { code: 'BEGIN_REFUSED' });
        }
        if (method === config.controllerFailure && method !== 'release') {
          throw Object.assign(new Error('Secondary\n\u0000' + 'x'.repeat(2000)), { code: 'SECONDARY_FAILURE' });
        }
        const result = controller[method](...args);
        if (method === 'begin' && config.resume) controller.wake(args[0].run_id, { force: true });
        if (method === 'release' && config.controllerFailure === method) {
          throw Object.assign(new Error('Secondary\n\u0000' + 'x'.repeat(2000)), { code: 'SECONDARY_FAILURE' });
        }
        return result;
      };
    }
    return wrapped;
  } };
  if (config.beginRefusal) {
    const writerFile = require.resolve('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');
    const writer = require(writerFile);
    require.cache[writerFile].exports = { ...writer,
      sharedPlanningWriterRoot: () => config.writerRoot,
      legacyPlanningWriterRoots: () => [],
      createPlanningWriterLease(options) {
        const lease = writer.createPlanningWriterLease(options);
        return { ...lease, release(input) {
          fs.appendFileSync(config.events, 'writer release\n');
          lease.release(input);
          throw Object.assign(new Error('Writer secondary\n\u0000' + 'x'.repeat(2000)), { code: 'WRITER_SECONDARY' });
        } };
      },
    };
  }
  const runtime = require(runtimeFile);
  require.cache[runtimeFile].exports = { ...runtime, createCodexRuntimeHost(options) {
    const recorder = createDurableRecorder(options.recorderDir);
    return { scope: options.scope, capabilities, recorder, launchStatic(selection, context) {
      fs.appendFileSync(config.calls, context.research_line + '\n');
      const mode = context.research_line === config.line ? config.mode : 'completed';
      const finding = '# ' + context.research_line + '\nComplete finding.\n';
      if (!['missing', 'blocked-missing'].includes(mode)) fs.writeFileSync(context.artifactPath, finding);
      if (config.blockedRetryState && context.research_line === config.line) {
        options.controller.retry(options.scope.run_id, { target_state: config.blockedRetryState, reason: 'retry blocked line' });
      }
      if (['runtime_unavailable', 'retryable'].includes(mode)) {
        options.controller.retry(options.scope.run_id, { target_state: mode,
          reason: config.cause.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400), delay_ms: 60000 });
        throw Object.assign(new Error(config.cause), { code: 'RUNTIME_UNAVAILABLE' });
      }
      const launchId = 'launch-' + context.dispatch_id;
      const sessionId = 'session-' + context.dispatch_id;
      const blocked = mode.startsWith('blocked');
      const semantic = { id: context.research_line, status: blocked ? 'blocked' : 'completed',
        summary: blocked ? config.cause : 'Finding completed.',
        artifact: { path: context.artifactPath, bytes: Buffer.byteLength(finding),
          content_bytes: Buffer.byteLength(finding), sha256: hash(finding), digest: hash(finding) } };
      if (['digest', 'blocked-digest'].includes(mode)) semantic.artifact.digest = '0'.repeat(64);
      if (mode === 'foreign-path') semantic.artifact.path = path.join(config.home, 'foreign.md');
      if (mode === 'wrong-bytes') semantic.artifact.content_bytes++;
      if (mode === 'foreign-line') semantic.id = 'foreign';
      if (mode === 'unknown-status') semantic.status = 'unavailable';
      if (mode === 'long-summary') semantic.summary = 'x'.repeat(501);
      if (mode === 'model-receipt') semantic.receipt = { compliance: 'verified' };
      const completion = { launch_id: launchId, session_id: sessionId,
        last_agent_message: mode === 'malformed' ? '{broken' : JSON.stringify(semantic) };
      if (mode === 'oversize') completion.last_agent_message = 'x'.repeat(16 * 1024 + 1);
      if (mode === 'foreign-launch') completion.launch_id = 'foreign';
      if (mode === 'foreign-session') completion.session_id = 'foreign';
      if (mode !== 'artifact-only' && context.onCompleted) context.onCompleted(completion);
      if (mode === 'duplicate' && context.onCompleted) context.onCompleted(completion);
      if (mode === 'conflicting-duplicate' && context.onCompleted) {
        try { context.onCompleted({ ...completion, last_agent_message: JSON.stringify({ ...semantic, status: 'blocked' }) }); }
        catch {}
      }
      if (mode === 'mutated') fs.appendFileSync(context.artifactPath, 'Altered after callback.\n');
      return { launch_id: launchId, applied_model: selection.model,
        applied_effort: selection.reasoning_effort, observed_model: selection.model,
        observed_effort: selection.reasoning_effort, agent_file_digest: selection.agent_file_digest,
        runtime_evidence: { session_id: sessionId, native_session_evidence: { session_id: sessionId } } };
    } };
  } };
} else {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  function fixture(t, mode = 'completed', line = 'risks') {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-handback-')));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'worktree');
    const home = path.join(temporary, 'home');
    const agentDir = path.join(home, '.codex', 'agents');
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    const phaseDir = path.join(root, '.planning', 'phases', '47-fixture');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'fixture.md'), 'phase writer fixture\n');
    fs.mkdirSync(agentDir, { recursive: true });
    const configFile = path.join(temporary, 'gitconfig');
    fs.writeFileSync(configFile, '');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_NOSYSTEM: '1',
      CODEX_HOME: path.join(home, '.codex') };
    delete env.SHIPYARD_GRAPH_DIR;
    const git = (...args) => execFileSync('git', ['-C', root, ...args],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Research Test', '-c', 'user.email=research@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
    const selection = policy.resolveDispatch({ runtime: 'codex', role: 'research' });
    const content = [
      '# shipyard-policy-id = "' + policy.POLICY.id + '"',
      '# shipyard-policy-version = "' + selection.policy_version + '"',
      '# shipyard-policy-hash = "' + selection.policy_hash + '"',
      '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "research"',
      '# shipyard-policy-rung = "' + selection.rung + '"',
      'name = "' + selection.agent_file.replace(/\.toml$/, '') + '"',
      'model = "' + selection.model + '"', 'model_reasoning_effort = "' + selection.effort + '"',
      'sandbox_mode = "read-only"', "developer_instructions = '''", 'Research the assigned line.', "'''", '',
    ].join('\n');
    fs.writeFileSync(path.join(agentDir, selection.agent_file), content);
    fs.writeFileSync(path.join(agentDir, '.shipyard-manifest.json'), JSON.stringify({
      policy_id: policy.POLICY.id, policy_version: selection.policy_version, policy_hash: selection.policy_hash,
      agent_files: [selection.agent_file], agent_digests: { [selection.agent_file]: hash(content) },
    }));
    const scope = { run_id: 'research-handback', ticket: 'T-47-07', phase: 47,
      worktree: root, runtime: 'codex', provider: 'openai' };
    const investigation = { invId: 'INV-147', sourceRevision: git('rev-parse', 'HEAD'),
      repository: 'research-fixture', policyHash: selection.policy_hash, lines: ids.map((id) => ({ id })) };
    const requestFile = path.join(temporary, 'request.json');
    const request = { scope, role: 'research', dispatch_id: 'dispatch-controller-research-handback',
      context: { prompt: 'Investigate.', investigation } };
    fs.writeFileSync(requestFile, JSON.stringify(request));
    const config = { home, mode, line, calls: path.join(temporary, 'calls'),
      events: path.join(temporary, 'events'), writerRoot: path.join(temporary, 'writers'),
      failureReason: path.join(temporary, 'failure-reason.json'),
      cause: 'Blocked\noriginal\u0000cause' };
    const fixtureFile = path.join(temporary, 'fixture.json');
    fs.writeFileSync(fixtureFile, JSON.stringify(config));
    const storage = path.join(home, '.local', 'state', 'shipyard', 'codex', hash(scope.run_id + '\0' + root));
    return { root, config, scope, storage, request, phaseDir, update() {
      fs.writeFileSync(fixtureFile, JSON.stringify(config));
      fs.writeFileSync(requestFile, JSON.stringify(request));
    }, run() {
      return spawnSync(process.execPath, ['--require', __filename, hostFile, '--args-file', requestFile],
        { env: { ...env, SHIPYARD_RESEARCH_HANDBACK_FIXTURE: fixtureFile }, encoding: 'utf8', timeout: 15000 });
    }, status() { return controllerModule.createRunController({ storeDir: path.join(storage, 'runs') }).status(scope.run_id); } };
  }

  test('authenticated completed callbacks seal four original dispatches and exit zero', (t) => {
    const f = fixture(t);
    const child = f.run();
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.map((entry) => entry.id), ids);
    const recorder = createDurableRecorder(path.join(f.storage, 'receipts'));
    for (const entry of result) {
      assert.equal(entry.envelope.status, 'completed');
      const manifest = JSON.parse(fs.readFileSync(entry.artifact_ref, 'utf8'));
      assert.equal(recorder.getVerifiedRecord(manifest.dispatch_id).receipt.compliance, 'verified');
      assert.equal(hash(fs.readFileSync(entry.artifact_index.path)), entry.artifact_index.sha256);
    }
    assert.equal(f.status().state, 'completed');
  });

  test('artifact-producing blocked worker retains its failed archive and siblings and exits one', (t) => {
    const f = fixture(t, 'blocked');
    const child = f.run();
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'risks');
    assert.equal(result.cause, f.config.cause);
    assert.deepEqual(result.sealed_lines.map((entry) => entry.id), ids.slice(0, 3));
    assert.equal(result.failed_artifact.envelope.status, 'blocked');
    assert.ok(fs.existsSync(result.failed_artifact.artifact_index.path));
    const manifest = JSON.parse(fs.readFileSync(result.failed_artifact.artifact_ref, 'utf8'));
    const original = createDurableRecorder(path.join(f.storage, 'receipts')).getVerifiedRecord(manifest.dispatch_id);
    assert.deepEqual(result.failed_artifact.receipt, original.receipt);
    assert.equal(result.failed_artifact.envelope.summary, f.config.cause);
    assert.equal(f.status().state, 'failed');
    assert.equal(f.status().owner.status, 'released');
    assert.equal(result.diagnostics, undefined);
    const stored = JSON.parse(fs.readFileSync(path.join(f.storage, 'runs', 'runs.json'), 'utf8'));
    const event = stored.runs[f.scope.run_id].run.event_log.at(-1);
    assert.equal(event.to, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(f.config.failureReason, 'utf8')).reason,
      f.config.cause.replace(/[\u0000-\u001f\u007f]/g, ' '));
  });

  test('semantic blocked cause retains text that resembles an adapter repair suffix', (t) => {
    const f = fixture(t, 'blocked');
    const { REPAIR } = require('../../plugins/delivery-pipeline/scripts/codex-model-remap.cjs');
    f.config.cause = 'Original blocked finding. ' + REPAIR;
    f.update();
    const child = f.run();
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.cause, f.config.cause);
    assert.equal(result.failed_artifact.envelope.summary, f.config.cause);
  });

  const refusalCodes = {
    'artifact-only': 'RESEARCH_HANDBACK_MISSING', malformed: 'RESEARCH_HANDBACK_INVALID',
    'foreign-launch': 'RUNTIME_EVIDENCE_MISMATCH', 'foreign-session': 'RUNTIME_EVIDENCE_MISMATCH',
    'foreign-line': 'RESEARCH_HANDBACK_INVALID', duplicate: 'RUNTIME_EVIDENCE_MISMATCH',
    'conflicting-duplicate': 'RUNTIME_EVIDENCE_MISMATCH', digest: 'RESEARCH_PRODUCER_MISMATCH',
    missing: 'RESEARCH_LINE_MISSING', 'blocked-missing': 'RESEARCH_LINE_MISSING',
    'blocked-digest': 'RESEARCH_PRODUCER_MISMATCH', 'foreign-path': 'RESEARCH_PRODUCER_MISMATCH',
    'wrong-bytes': 'RESEARCH_PRODUCER_MISMATCH', 'unknown-status': 'RESEARCH_HANDBACK_INVALID',
    'long-summary': 'RESEARCH_HANDBACK_INVALID', 'model-receipt': 'RESEARCH_HANDBACK_INVALID',
    oversize: 'RESEARCH_HANDBACK_INVALID', mutated: 'RESEARCH_PRODUCER_MISMATCH',
  };
  for (const [mode, code] of Object.entries(refusalCodes)) {
    test(mode + ' refuses completion even when transport succeeds', (t) => {
      const f = fixture(t, mode);
      const child = f.run();
      assert.equal(child.status, 1, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.equal(result.status, 'blocked');
      assert.equal(result.failed_line, 'risks');
      assert.equal(result.code, code);
      assert.equal(result.sealed_lines.length, 3);
      assert.equal(result.failed_artifact, undefined);
      assert.equal(f.status().state, 'failed');
    });
  }

  for (const state of ['runtime_unavailable', 'retryable']) {
    test(state + ' retains original cause, siblings, retry scheduling and successor ownership', (t) => {
      const f = fixture(t, state);
      f.config.cause += 'x'.repeat(2500);
      f.update();
      const child = f.run();
      assert.equal(child.status, 1, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.equal(result.code, 'RUNTIME_UNAVAILABLE');
      assert.equal(result.cause, f.config.cause);
      assert.equal(result.failed_line, 'risks');
      assert.deepEqual(result.sealed_lines.map((entry) => entry.id), ids.slice(0, 3));
      const status = f.status();
      assert.equal(status.state, state);
      assert.equal(status.owner.status, 'released');
      assert.equal(status.recoverable, true);
      assert.equal(status.retry.attempts, 1);
      assert.ok(status.retry.next_at > Date.now());
      assert.equal(status.retry.state, state);
      assert.ok(status.retry.last_reason.length <= 400);
      assert.ok(!/[\u0000-\u001f\u007f]/.test(status.retry.last_reason));
      const stored = JSON.parse(fs.readFileSync(path.join(f.storage, 'runs', 'runs.json'), 'utf8'));
      const successor = controllerModule.createRunController({ storeDir: path.join(f.storage, 'runs') });
      successor.begin(stored.runs[f.scope.run_id].run);
      assert.equal(successor.status(f.scope.run_id).owner.owner_id, successor.owner_id);
      assert.equal(successor.status(f.scope.run_id).owner.epoch, status.owner.epoch + 1);
      assert.deepEqual(successor.status(f.scope.run_id).retry, status.retry);
      successor.release(f.scope.run_id);
    });
  }

  for (const method of ['status', 'fail', 'release']) {
    test('secondary controller ' + method + ' failure preserves the primary blocked JSON', (t) => {
      const f = fixture(t, 'blocked');
      f.config.controllerFailure = method;
      f.update();
      const child = f.run();
      assert.equal(child.status, 1, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.equal(result.code, 'RESEARCH_LINE_BLOCKED');
      assert.equal(result.cause, f.config.cause);
      assert.equal(result.failed_line, 'risks');
      assert.equal(result.sealed_lines.length, 3);
      assert.equal(result.failed_artifact.envelope.status, 'blocked');
      assert.equal(result.diagnostics.length, 1);
      assert.ok(result.diagnostics[0].cause.length <= 400);
      assert.ok(!/[\u0000-\u001f\u007f]/.test(result.diagnostics[0].cause));
      assert.equal(f.status().owner.status, 'released');
      assert.ok(!fs.readFileSync(f.config.events, 'utf8').includes('complete'));
    });
  }

  for (const altered of [false, true]) {
    test(altered ? 'retry refuses altered sibling evidence before launching any line'
      : 'retry authenticates and preserves siblings and dispatches only the failed line', (t) => {
      const f = fixture(t, 'runtime_unavailable');
      const initial = f.run();
      assert.equal(initial.status, 1, initial.stderr);
      const failure = JSON.parse(initial.stdout);
      const originals = failure.sealed_lines.map((line) => fs.readFileSync(line.artifact_ref));
      const calls = fs.readFileSync(f.config.calls, 'utf8');
      f.config.mode = 'completed';
      f.config.resume = true;
      f.request.context.investigation.lines = [{ id: failure.failed_line }];
      f.request.context.investigation.sealedLines = failure.sealed_lines;
      if (altered) fs.appendFileSync(failure.sealed_lines[0].artifact_index.path, 'altered\n');
      f.update();
      const retried = f.run();
      if (altered) {
        assert.equal(retried.status, 1, retried.stderr);
        assert.match(retried.stderr, /RESEARCH_VERIFY_ARCHIVE_MUTATED/);
        assert.equal(fs.readFileSync(f.config.calls, 'utf8'), calls);
      } else {
        assert.equal(retried.status, 0, retried.stderr);
        const result = JSON.parse(retried.stdout);
        assert.deepEqual(result.map((line) => line.id), ids);
        assert.equal(fs.readFileSync(f.config.calls, 'utf8'), calls + 'risks\n');
        assert.equal(f.status().state, 'completed');
        for (const [index, line] of failure.sealed_lines.entries()) {
          assert.equal(result.find((item) => item.id === line.id).artifact_digest, line.artifact_digest);
          assert.deepEqual(fs.readFileSync(line.artifact_ref), originals[index]);
        }
      }
    });
  }

  test('an authenticated blocked archive is refused as a completed retry sibling', (t) => {
    const f = fixture(t, 'blocked');
    f.config.blockedRetryState = 'retryable';
    f.update();
    const initial = f.run();
    assert.equal(initial.status, 1, initial.stderr);
    const failure = JSON.parse(initial.stdout);
    assert.equal(failure.failed_artifact.envelope.status, 'blocked');
    const calls = fs.readFileSync(f.config.calls, 'utf8');
    delete f.config.blockedRetryState;
    f.config.resume = true;
    f.config.mode = 'completed';
    f.request.context.investigation.lines = [{ id: 'alternatives' }];
    f.request.context.investigation.sealedLines = [
      ...failure.sealed_lines.filter((line) => line.id !== 'alternatives'), failure.failed_artifact,
    ];
    f.update();
    const retried = f.run();
    assert.equal(retried.status, 1, retried.stderr);
    assert.match(retried.stderr, /RESEARCH_VERIFY_STATUS_INVALID/);
    assert.equal(fs.readFileSync(f.config.calls, 'utf8'), calls);
  });

  test('a refusal before creating any run retains its original code without controller completion', (t) => {
    const f = fixture(t);
    f.request.unexpected = 'invalid request';
    f.update();
    const child = f.run();
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /unsupported delivery request field unexpected/);
    assert.match(child.stderr, /INVALID_INPUT/);
    assert.equal(f.status(), null);
    assert.equal(fs.existsSync(f.config.events), false);
    assert.equal(fs.existsSync(f.config.calls), false);
  });

  test('begin refusal before creating a run preserves primary code/cause and releases its phase writer', (t) => {
    const f = fixture(t);
    f.config.beginRefusal = true;
    f.request.gsd_role = 'gsd-phase-researcher';
    f.update();
    const child = f.run();
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, '');
    assert.ok(child.stderr.includes(f.config.cause));
    assert.match(child.stderr, /BEGIN_REFUSED/);
    const diagnostic = JSON.parse(child.stderr.trim().split('\n').at(-1)).diagnostics[0];
    assert.equal(diagnostic.code, 'WRITER_SECONDARY');
    assert.ok(diagnostic.cause.length <= 400);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(diagnostic.cause));
    assert.equal(f.status(), null);
    assert.equal(fs.readFileSync(f.config.events, 'utf8'), 'begin\nwriter release\n');
    const { createPlanningWriterLease } = require('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir: f.phaseDir, stateRoot: f.config.writerRoot });
    const handle = lease.acquire({ owner: 'successor', base_revision: f.request.context.investigation.sourceRevision });
    lease.release(handle);
  });
}
