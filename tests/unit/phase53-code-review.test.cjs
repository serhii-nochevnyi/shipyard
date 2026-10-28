'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cases = [];
const test = (title, run) => cases.push({ title, run });
function fixtures(name, end, names, transform = source => source) {
  const filename = path.join(__dirname, name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
  const original = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === 'node:test' ? { test() {}, describe() {} } : original.call(this, name, ...args);
    };
    loaded._compile(transform(fs.readFileSync(filename, 'utf8').split(end)[0]) + '\nmodule.exports = { ' + names + ' };', filename);
  } finally { Module._load = original; }
  return loaded.exports;
}
const codex = fixtures('phase53-codex-architecture.test.cjs', "test('caller architecture", 'architectureFixture, publicIntegrationFixture, agent, phaseBinding, commit, write');
const claude = fixtures('phase53-claude-review.test.cjs', "for (const role of ['integrator'", 'nativeFixture, ordinary', source => {
  assert.ok(source.includes('pending[1](); pending[0]();'));
  assert.ok(source.includes('assert.equal(completed.length, 0);'));
  return source.replace('pending[1](); pending[0]();', 'pending.splice(0).reverse().forEach(finish => finish());')
    .replace('assert.equal(completed.length, 0);', 'assert.equal(completed.length % 3, 0);');
});
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
const flow = require('../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
const contract = 'shipyard.semantic-review.v1';
function current(f) {
  const file = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const saved = require.cache[file]; delete require.cache[file];
  try { return require(file).currentCodeReviewVerdict({ worktreePath: f.worktree, graphDir: f.graphDir,
    pr: f.pr.number, head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid,
    headBranch: f.pr.headRefName }); } finally { require.cache[file] = saved; }
}
function input(f) { return { worktree: f.worktree, graphDir: f.graphDir, phase: 49, pr: f.pr.number }; }
function fixture(f, runtime, controls = {}) {
  const control = { ...controls, result(result, payload) {
    result.role = 'code-review';
    if (payload.stage === 'final') {
      delete result.verdict;
      Object.assign(result, { id: payload.subject, repository: payload.reviewed_identity.repository,
        pr: payload.reviewed_identity.pr, base_commit: payload.reviewed_identity.base,
        merge_base: payload.reviewed_identity.merge_base, base_tree: payload.reviewed_identity.merge_base_tree,
        dispositions: [], summary: 'Independent code correctness review.' });
    }
    controls.result?.(result, payload);
  } };
  const prepared = runtime === 'codex' ? codex.architectureFixture(f, control) : claude.nativeFixture(f, 'code-review', control);
  if (runtime === 'codex') {
    const a = codex.agent(f, 'code-review', { risk: 'high', checkpoint: true });
    Object.assign(prepared.options, { agentDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,
      probe: { ...prepared.options.probe, capabilities: a.capabilities } });
  }
  prepared.run = () => runtime === 'claude' ? claude.ordinary(f, 'code-review', prepared)
    : require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').createCodexDeliveryHost({ ...prepared.options,
      scope: { worktree: f.worktree, repository: require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(f.worktree),
        phase: 49, ticket: codex.phaseBinding(f).subject, run_id: 'code-review-' + ++f.count } }).run({ role: 'code-review', context: {}, signals: {} });
  return prepared;
}
function setup(f, mode = 'hold') {
  const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
  graph.epics = { '049': { branch: f.pr.headRefName, phaseDir: f.phase, repos: [null] } };
  codex.write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  codex.write(f.worktree, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' }, delivery_pipeline: { code_review: mode } }));
  codex.commit(f, 'fixture code review configuration');
}
for (const runtime of ['codex', 'claude']) {
  test(runtime + ' ordinary code review retains complete INFO originals and authenticates the phase publication consumer', async () => {
    await codex.publicIntegrationFixture(async f => {
      setup(f);
      const prepared = fixture(f, runtime, { onLaunch(launch) {
        assert.equal(launch.payload.input_transport, 'host-files');
        for (const source of launch.payload.material) {
          assert.ok(path.isAbsolute(source.read_path));
          assert.ok(!source.read_path.startsWith(f.worktree + path.sep));
          const content = fs.readFileSync(source.read_path);
          assert.equal(content.length, source.bytes);
          assert.equal(require('node:crypto').createHash('sha256').update(content).digest('hex'), source.sha256);
        }
      }, native(rows) {
        if (runtime === 'codex') rows.splice(rows.findIndex(row => row.payload?.type === 'token_count'), 1);
      }, result(result) {
        result.findings = [{ id: 'INFO-1', severity: 'INFO', summary: 'Caller boundary was inspected.' }];
      } });
      const completed = await prepared.run();
      assert.equal(completed.result.review_contract, contract);
      assert.equal(completed.result.info_dropped, 1);
      assert.deepEqual(completed.result.findings, []);
      assert.equal(prepared.launches.length, 3);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      if (runtime === 'codex') for (const launch of prepared.launches) {
        const profile = launch.runtime_args.find(value => value.startsWith('permissions.shipyard-runtime.filesystem='));
        const evidence = JSON.stringify(path.join(f.worktree, '.shipyard-code-review-evidence.md'));
        assert.ok(profile.includes(evidence + '=\"deny\"'));
        assert.ok(!profile.includes(evidence + '=\"write\"'));
      }
      assert.ok(current(f)?.authenticated);
      for (const launch of prepared.launches.slice(0, 2)) {
        const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
          snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
        assert.equal(original.result.findings[0].severity, 'INFO');
        assert.equal(original.original_text, launch.text || launch.originalText);
        assert.equal(original.native.accounting.status, 'unknown');
        assert.equal(original.native.resource_failure, null);
        if (runtime === 'claude') assert.equal(original.native.observation.status, 'unknown');
        const recorded = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id);
        assert.equal(recorded.role, 'code-review'); assert.equal(recorded.subject_kind, 'phase');
        assert.equal(recorded.receipt.runtime, runtime);
        assert.equal(original.native.session_id, launch.session);
        assert.equal(recorded.receipt.observed_effort, recorded.receipt.applied_effort);
      }
      const options = { ...prepared.options, getPullRequest: ({ pr }) => pr === f.pr.number
        ? { ...f.pr } : { number: pr, headRefOid: f.memberHead } };
      const status = flow.status(input(f), options);
      assert.equal(status.state, 'current'); assert.equal(status.rounds_used, 1);
      assert.equal(status.original_reports.workers.length, 2);
      const output = status.original_reports.final.output;
      const bytes = fs.readFileSync(output.path);
      assert.equal(bytes.length, output.bytes);
      assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), output.sha256);
      assert.ok(bytes.toString('utf8').includes('Caller boundary was inspected.'));
      assert.equal(flow.evaluateGate(status).ok, true);
      const writes = [];
      options.gh = args => {
        writes.push(args);
        if (args[1].includes('/statuses/')) return {};
        throw Error('fixture comment unavailable');
      };
      const published = flow.publish(input(f), options);
      assert.equal(published.status.ok, true); assert.equal(published.comment.ok, false);
      assert.ok(current(f)?.authenticated);
      assert.equal(prepared.launches.length, 3);
      f.pr.headRefOid = f.base;
      assert.throws(() => flow.publish(input(f), options));
      assert.equal(prepared.launches.length, 3);
      assert.equal(writes.length, 2);
      f.pr.headRefOid = f.head;
      const source = path.join(f.worktree, 'src/provider.cjs'), originalSource = fs.readFileSync(source);
      fs.appendFileSync(source, '\nchanged source\n');
      assert.equal(current(f), null);
      fs.writeFileSync(source, originalSource);
      assert.ok(current(f)?.authenticated);
      fs.appendFileSync(prepared.launches[0].payload.material[0].read_path, '\nchanged transport\n');
      assert.equal(current(f), null);
    });
  });
  for (const failure of ['blocked', 'unread', 'foreign-role', 'worker-final', 'original-pin', 'moved-head', 'moved-base', 'missing-report', 'missing-context'])
    test(runtime + ' refuses ' + failure + ' code-review authority', async () => {
      await codex.publicIntegrationFixture(async f => {
        setup(f);
        const prepared = fixture(f, runtime, { native(rows, payload) {
          if (payload.stage !== 'worker') return;
          if (failure === 'blocked') {
            if (runtime === 'codex') rows.splice(-2, 0, { type: 'event_msg', payload: { type: 'input_truncated' } });
            else rows.at(-1).message.stop_reason = 'max_tokens';
          }
          if (failure === 'unread') {
            if (runtime === 'claude') rows[2].message.content[0].is_error = true;
            else {
              const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
              const original = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
              const call = template(original, row => row.payload?.type === 'function_call');
              const output = template(original, row => row.payload?.type === 'function_call_output');
              Object.assign(call.payload, { name: 'exec_command', call_id: 'missing-code-review-context',
                arguments: JSON.stringify({ cmd: 'cat src/missing.cjs' }) });
              Object.assign(output.payload, { call_id: call.payload.call_id,
                output: JSON.stringify({ exit_code: 1, output: 'No such file' }) });
              rows.splice(-3, 0, call, output);
            }
          }
        }, result(result, payload) {
          if (payload.stage === 'worker') {
            result.findings = [{ id: 'INFO-1', severity: 'INFO', summary: 'Original observation survives.' }];
            if (failure === 'blocked' || failure === 'unread') {
              result.completeness = failure === 'blocked' ? 'blocked' : 'incomplete';
              result.required_context = ['Actual caller context unavailable']; result.unread = [result.coverage[0]];
            }
          } else if (failure === 'foreign-role') result.role = 'integrator';
          else if (failure === 'worker-final') result.stage = 'worker';
        } });
        if (['blocked', 'unread', 'foreign-role', 'worker-final'].includes(failure)) {
          await assert.rejects(prepared.run());
          assert.equal(current(f), null);
          for (const launch of prepared.launches.slice(0, 2)) {
            const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
              snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
            assert.equal(original.result.findings[0].severity, 'INFO');
            if (failure === 'blocked') assert.ok(original.native.resource_failure);
            if (failure === 'unread') assert.equal(original.native.reads.incomplete.length, 1);
          }
        } else {
          await prepared.run(); assert.ok(current(f));
          if (failure === 'original-pin') {
            const launch = prepared.launches[0];
            const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
              snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
            fs.appendFileSync(original.native.native_pin.path, '\n');
          }
          if (failure === 'moved-head') {
            require('node:child_process').execFileSync('git', ['-C', f.worktree, '-c', 'commit.gpgsign=false',
              '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture moved head']);
            f.pr.headRefOid = require('node:child_process').execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
          }
          if (failure === 'moved-base') f.pr.baseRefOid = f.head;
          if (failure === 'missing-context') fs.unlinkSync(path.join(f.worktree, f.rows['T-49-01'].plan));
          if (failure === 'missing-report') {
            const verdict = current(f), manifest = JSON.parse(fs.readFileSync(verdict.artifact_ref));
            fs.unlinkSync(path.join(f.worktree, manifest.files.evidence.path));
          }
          let refused; try { refused = current(f); } catch { refused = null; }
          assert.equal(refused, null);
        }
      });
    });
}

for (const runtime of ['codex', 'claude']) {
  test(runtime + ' incomplete final retains blocked originals and existing hold/report states', async () => {
    await codex.publicIntegrationFixture(async f => {
      const mode = runtime === 'codex' ? 'hold' : 'report';
      setup(f, mode);
      const prepared = fixture(f, runtime, { result(result) {
        result.completeness = 'blocked'; result.outcome = 'human-review-required';
        result.required_context = ['Actual caller could not be read']; result.unread = [result.coverage[0]];
        result.findings = [{ id: 'INFO-1', severity: 'INFO', summary: 'Uncertainty remains in the original report.' }];
      } });
      const completed = await prepared.run();
      assert.equal(completed.result.verdict, 'incomplete');
      assert.equal(current(f).review_completeness, 'incomplete');
      const state = flow.status(input(f), prepared.options);
      assert.equal(state.state, 'owed'); assert.equal(state.rounds_used, 0); assert.equal(state.retry, true);
      assert.equal(flow.evaluateGate(state).ok, mode === 'report');
      for (const launch of prepared.launches.slice(0, 2)) {
        const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
          snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
        assert.equal(original.result.completeness, 'blocked');
        assert.equal(original.result.findings[0].severity, 'INFO');
        assert.equal(original.result.unread.length, 1);
      }
    });
  });
  test(runtime + ' carries unresolved blockers through three real rounds and refuses a fourth launch', async () => {
    await codex.publicIntegrationFixture(async f => {
      const mode = runtime === 'codex' ? 'hold' : 'report';
      setup(f, mode);
      let round = 1;
      const prepared = fixture(f, runtime, { barrier: false, result(result, payload) {
        result.outcome = 'needs-fix'; result.blocking_count = 1;
        if (round === 1) result.findings = [{ id: 'CR-1', severity: 'BLOCKER', path: 'src/provider.cjs', line: 1,
          line_text: 'exports.value = 1;', summary: 'The exported value violates the caller contract.',
          failure_scenario: 'The caller receives an unsupported value.',
          fix_ticket: { title: 'Repair the exported value', scope: 'Return the supported value.', files: ['src/provider.cjs'] } }];
        if (payload.stage === 'final' && round > 1) {
          assert.equal(payload.code_review_context.review_round, round);
          result.dispositions = [{ ref: 'P-01', disposition: 'unresolved', justification: 'The exported value remains unchanged.' }];
        }
      } });
      for (; round <= 3; round++) {
        if (round > 1) {
          codex.write(f.worktree, 'src/consumer.cjs', fs.readFileSync(path.join(f.worktree, 'src/consumer.cjs'), 'utf8') + '\n');
          codex.commit(f, 'fixture next review head');
        }
        const completed = await prepared.run();
        assert.equal(completed.result.review_round, round);
        assert.equal(completed.result.review_scope, round === 1 ? 'full' : 'delta');
        assert.equal(completed.result.blocking_count, 1);
        const state = flow.status(input(f), prepared.options);
        assert.equal(state.rounds_used, round); assert.equal(state.verdict, 'needs-fix');
        assert.equal(state.repair, round < 3 ? 'tickets' : 'human');
        assert.equal(flow.evaluateGate(state).ok, mode === 'report');
        assert.equal(prepared.launches.length, round * 3);
      }
      codex.write(f.worktree, 'src/consumer.cjs', fs.readFileSync(path.join(f.worktree, 'src/consumer.cjs'), 'utf8') + '\n');
      codex.commit(f, 'fixture exhausted head');
      assert.equal(current(f), null);
      const state = flow.status(input(f), prepared.options);
      assert.equal(state.state, 'limit'); assert.equal(state.rounds_used, 3);
      await assert.rejects(prepared.run(), error => error.code === 'CODE_REVIEW_ROUND_LIMIT');
      assert.equal(prepared.launches.length, 9);
    });
  });
}

for (const runtime of ['codex', 'claude']) for (const failure of ['reused-session', 'native-input', 'native-effort'])
  test(runtime + ' refuses changed ' + failure + ' custody', async () => {
    await codex.publicIntegrationFixture(async f => {
      setup(f);
      let reused;
      const prepared = fixture(f, runtime, {
        reuseFinalSession: failure === 'reused-session',
        onLaunch(launch, launches) {
          if (failure === 'reused-session' && launch.payload.stage === 'final') reused = launches[0].session;
        },
        session(payload) { if (payload.stage === 'final') return reused; },
        native(rows, payload) {
          if (payload.stage !== 'final') return;
          if (failure === 'native-input') {
            const user = runtime === 'codex' ? rows.find(row => row.payload?.role === 'user').payload
              : rows.find(row => row.type === 'user' && typeof row.message?.content === 'string').message;
            if (runtime === 'codex') user.content[0].text += '\nAltered original input';
            else user.content += '\nAltered original input';
          }
          if (failure === 'native-effort') {
            if (runtime === 'codex') rows.find(row => row.type === 'turn_context').payload.effort = 'low';
            else rows.find(row => row.type === 'assistant').effort = 'low';
          }
        }
      });
      await assert.rejects(prepared.run());
      let accepted; try { accepted = current(f); } catch { accepted = null; }
      assert.equal(accepted, null);
    });
  });

for (const runtime of ['codex', 'claude']) for (const falsePass of [false, true])
  test(runtime + ' final judges a real missing producer export' + (falsePass ? ' and refuses false acceptance' : ''), async () => {
    await codex.publicIntegrationFixture(async f => {
      setup(f);
      const source = "module.exports = require('./provider.cjs').missing();";
      codex.write(f.worktree, 'src/consumer.cjs', source + '\n');
      codex.commit(f, 'fixture broken producer consumer call');
      assert.throws(() => require(path.join(f.worktree, 'src/consumer.cjs')), /missing is not a function/);
      const prepared = fixture(f, runtime, { result(result, payload) {
        assert.ok(payload.material.some(item => item.content.includes('exports.value = 1;')));
        assert.ok(payload.material.some(item => item.content.includes(source)));
        assert.ok(payload.seams.some(item => item.producer === 'src/provider.cjs' && item.consumer === 'src/consumer.cjs'));
        result.findings = [{ id: 'MISSING-EXPORT', severity: 'BLOCKER', path: 'src/consumer.cjs', line: 1,
          line_text: source, summary: 'The consumer invokes an absent export.',
          failure_scenario: 'Loading the consumer throws TypeError because the provider exports value only.',
          fix_ticket: { title: 'Align the consumer with the provider exports', scope: 'Call an implemented producer API.',
            files: ['src/consumer.cjs'] } }];
        result.outcome = 'needs-fix'; result.blocking_count = 1;
        result.seams.forEach(item => { item.disposition = 'unresolved'; item.rationale = 'Provider exports value while consumer calls missing().'; });
        if (payload.stage === 'final') {
          assert.ok(payload.originals.every(item => item.result.findings[0].id === 'MISSING-EXPORT'));
          result.conclusions = ['Independent joint inspection confirms the consumer calls missing() while provider exports value.'];
          if (falsePass) { result.findings = []; result.outcome = 'passed'; result.blocking_count = 0; }
        }
      } });
      if (falsePass) { await assert.rejects(prepared.run()); assert.equal(current(f), null); }
      else {
        const completed = await prepared.run();
        assert.equal(completed.result.verdict, 'needs-fix'); assert.equal(completed.result.blocking_count, 1);
        assert.equal(flow.status(input(f), prepared.options).verdict, 'needs-fix');
      }
    });
  });

test('original-version code-review history stays readable and cannot authorize a moved current head', () => {
  const legacy = fixtures('codex-code-review-context.test.cjs', "test('tracer prepares", 'fixture, admit, dispatchFixture');
  const f = legacy.fixture();
  try {
    const context = require('../../plugins/delivery-pipeline/scripts/codex-code-review-context.cjs');
    const prepared = f.prepare(); legacy.admit(f, prepared);
    const native = legacy.dispatchFixture(f, prepared);
    const completed = context.finish(prepared, native.dispatch, native.recorder);
    const manifest = JSON.parse(fs.readFileSync(completed.artifact.ref));
    const evidence = path.join(f.root, manifest.files.evidence.path);
    const original = fs.readFileSync(evidence);
    assert.equal(completed.result.review_contract, core.CONTRACT_ID);
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), '\n'));
    const repository = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(f.root);
    const history = authority.priorCodeReviewVerdicts({ worktreePath: f.root, repository,
      phaseDir: path.basename(path.dirname(f.row.plan)), graphDir: f.graphDir });
    assert.equal(history.length, 1); assert.equal(history[0].review_round, 1);
    assert.deepEqual(fs.readFileSync(evidence), original);
    assert.equal(authority.currentCodeReviewVerdict({ worktreePath: f.root, graphDir: f.graphDir, pr: f.pr.number,
      head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName }), null);
  } finally { f.cleanup(); }
});

test('semantic code-review projection keeps existing severity and incomplete policy without mutating originals', () => {
  const packet = { required_refs: [], role_context: { review_round: 1, review_scope: 'full', prior_head: null,
    normalization_inputs: { prior_findings: [] }, contract_digest: 'a'.repeat(64), dispositions_digest: null } };
  const identity = { head: 'h', base: 'b' };
  for (const completeness of ['complete', 'incomplete', 'blocked']) {
    const original = { schema: contract, review_contract: contract, role: 'code-review', completeness,
      coverage: ['obligation'], findings: [{ id: 'info', severity: 'INFO', summary: 'Complete original note' }],
      limitations: [], required_context: completeness === 'complete' ? [] : ['Missing caller'], unread: [], dispositions: [] };
    const saved = JSON.stringify(original);
    const projected = core.projectSemanticResult(original, { packet, identity, readSource: () => '' });
    assert.equal(projected.verdict, completeness === 'complete' ? 'pass' : 'incomplete');
    assert.equal(projected.blocking_count, 0); assert.equal(projected.info_dropped, 1);
    assert.equal(JSON.stringify(original), saved);
    assert.deepEqual(projected.semantic_coverage, ['obligation']);
  }
});

if (isMainThread) describe('phase 53 code-review custody and consumers', { concurrency: 4 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-case-')));
    try {
      await new Promise((resolve, reject) => {
        const env = { ...process.env, HOME: home }; delete env.NODE_TEST_CONTEXT;
        const worker = new Worker(__filename, { workerData: index, env });
        let completed = false, failure;
        worker.once('message', message => { completed = message?.completed === true; });
        worker.once('error', error => { failure = error; });
        worker.once('exit', code => failure ? reject(failure) : code || !completed
          ? reject(Error(entry.title + ' exited without assertions: ' + code)) : resolve());
      });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
else Promise.resolve().then(() => cases[workerData].run()).then(() => parentPort.postMessage({ completed: true }))
  .catch(error => setImmediate(() => { throw error; }));
