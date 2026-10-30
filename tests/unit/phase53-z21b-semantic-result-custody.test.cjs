'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const cases = [];
const test = (title, run) => cases.push({ title, run });

test('indexed whole form refuses mixed sparse unknown unsafe duplicate reordered and foreign global references', () => {
  const a = h.internals(), snapshot = h.currentSized(), launch = h.sizedLaunch(snapshot, 'final');
  const original = a.semanticStructuralResult(snapshot, launch);
  const changes = {
    unknown: w => { w.result_format = 'future-form'; },
    'full discriminator is not a legacy answer': w => { w.result_format = 'full'; },
    'missing discriminator': w => { delete w.result_format; },
    'mixed full identity': w => { w.reviewed_identity = snapshot.identity; },
    'identity digest excludes bookkeeping': w => { const { bookkeeping, ...rest } = snapshot.identity; w.reviewed_identity_sha256 = h.hash(h.stable(rest)); },
    'mixed coverage': w => { w.coverage = snapshot.obligations.map(item => item.id); },
    'mixed unread': w => { w.unread = []; },
    'mixed seam vectors': w => { w.seams = []; },
    'mixed final scalar': w => { w.head = snapshot.identity.head; },
    'missing native findings': w => { delete w.findings; },
    'missing native limitations': w => { delete w.limitations; },
    'missing final summary': w => { delete w.summary; },
    'missing originals': w => { delete w.originals; },
    'missing seam disposition': w => { delete w.seam_rows[0].disposition; },
    'mixed id and index': w => { w.seam_rows[0].id = snapshot.seams[0].id; },
    'string coverage index': w => { w.coverage_indices[0] = '0'; },
    'negative coverage index': w => { w.coverage_indices[0] = -1; },
    'fractional coverage index': w => { w.coverage_indices[0] = 0.5; },
    'unsafe coverage index': w => { w.coverage_indices[0] = Number.MAX_SAFE_INTEGER + 1; },
    'foreign coverage': w => { w.coverage_indices[0] = snapshot.obligations.length; },
    'duplicate coverage': w => { w.coverage_indices[1] = w.coverage_indices[0]; },
    'reordered coverage': w => { w.coverage_indices.reverse(); },
    'missing coverage tail': w => { w.coverage_indices.pop(); },
    'foreign unread': w => { w.unread_indices = [458]; },
    'duplicate unread': w => { w.unread_indices = [1, 1]; },
    'implicit unread': w => { delete w.unread_indices; },
    'duplicate seam': w => { w.seam_rows[1].index = w.seam_rows[0].index; },
    'foreign seam': w => { w.seam_rows[0].index = snapshot.seams.length; },
    'string seam index': w => { w.seam_rows[0].index = '0'; },
    'reordered seams': w => { w.seam_rows.reverse(); },
    'missing seam': w => { w.seam_rows.pop(); },
  };
  for (const [label, change] of Object.entries(changes)) {
    const wire = h.clone(original); change(wire);
    assert.throws(() => a.decodeSemanticResult(wire, launch, snapshot), undefined, label);
  }
  for (const format of [undefined, ['full'], ['snapshot-indexed.v1'], ['snapshot-indexed.v1', 'full']]) {
    const old = { ...launch, input: '<AUTHENTICATED_SEMANTIC_REVIEW>\n' + h.stable({ result_formats: format }) + '\n</AUTHENTICATED_SEMANTIC_REVIEW>' };
    assert.throws(() => a.decodeSemanticResult(original, old, snapshot));
  }
  const expanded = a.decodeSemanticResult(original, launch, snapshot);
  assert.deepEqual(a.decodeSemanticResult(expanded, launch, snapshot), expanded, 'complete full legacy whole form remains supported');
  delete expanded.limitations;
  assert.throws(() => a.decodeSemanticResult(expanded, launch, snapshot));
  const fixture = h.sizingRecord(snapshot);
  try {
    const worker = a.semanticBuildLaunch(fixture.record, 'worker', fixture.record.snapshot.assignments[0].id, [], true);
    const body = JSON.parse(worker.input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
    body.assignment = fixture.record.snapshot.assignments[0];
    delete body.binding_sha256;
    body.binding_sha256 = h.hash(h.stable(body));
    const input = worker.input.slice(0, worker.input.indexOf('<AUTHENTICATED_SEMANTIC_REVIEW>'))
      + '<AUTHENTICATED_SEMANTIC_REVIEW>\n' + h.stable(body) + '\n</AUTHENTICATED_SEMANTIC_REVIEW>';
    assert.throws(() => a.assertSemanticLaunchView({ ...worker, input, input_sha256: h.hash(input),
      binding_sha256: body.binding_sha256 }, fixture.record,
    { material: body.material, catalog: body.catalog, originals: [] }), /exact recorded original launch/);
  } finally { fixture.close(); }
});

test('original full wire and exact terminal bounds stay 128 KiB even when semantic view is larger', () => {
  const a = h.internals(), snapshot = h.currentSized(), launch = h.sizedLaunch(snapshot, 'final');
  const wire = a.semanticStructuralResult(snapshot, launch), full = a.decodeSemanticResult(wire, launch, snapshot);
  a.semanticWireBound({ result: wire, text: JSON.stringify(wire) });
  assert.throws(() => a.semanticWireBound({ result: full, text: JSON.stringify(full) }), error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND');
  assert.throws(() => a.semanticWireBound({ result: wire, text: JSON.stringify(wire) + ' '.repeat(131072) }), error => error.details.terminal_bytes > 131072);
});

test('complete current-bound full Codex answer survives unchanged through cold originals and current acceptance', () => h.publicRole('integrator', 'codex', { full: true }));
test('complete current-bound full Claude answer survives unchanged through cold originals and current acceptance', () => h.publicRole('integrator', 'claude', { full: true }));

for (const runtime of ['codex', 'claude'])
  test(`${runtime} current caller preserves authenticated full reports with the recorded previous shared API`, () =>
  h.publicRole('integrator', runtime, {
    historical: true, historicalShared: true, full: true, inspect({ prepared, originals }) {
      for (const launch of prepared.launches) {
        assert.equal(Object.hasOwn(launch.payload, 'result_formats'), false);
        assert.equal(Object.hasOwn(launch.result, 'result_format'), false);
      }
      for (const original of originals) assert.deepEqual(JSON.parse(original.original_text), original.result);
    } }));

test('exact recorded parent full reports keep their original launches bytes and bindings under current cold consumers', () =>
  h.publicRole('integrator', 'codex', { historical: true, full: true, inspect({ f, api, plugin, originals, prepared, snapshots }) {
    for (const launch of prepared.launches) {
      assert.equal(Object.hasOwn(launch.payload, 'result_formats'), false);
      assert.equal(Object.hasOwn(launch.result, 'result_format'), false);
    }
    const canonical = path.dirname(h.SCRIPTS);
    assert.equal(h.cold(f, 'integrator', canonical)?.authenticated, true);
    assert.deepEqual(h.cold(f, 'integrator', canonical, originals), originals);
    const custody = () => {
      const directory = api.archiveAuthorityDirectory(f.worktree);
      return { artifacts: h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')),
        envelopes: fs.readdirSync(directory).filter(name => name.startsWith('integration-semantic-')).sort().map(name => {
          const file = h.physical(f.root, path.join(directory, name));
          return { name, mode: fs.statSync(file).mode & 0o777, sha256: h.hash(fs.readFileSync(file)) };
        }) };
    };
    const before = custody();
    const staged = require('../../scripts/package-shipyard-codex.cjs').build(path.join(f.root, 'legacy-consumer'));
    h.packageParity(staged);
    const consumer = path.join(staged, 'host/plugins/delivery-pipeline');
    assert.equal(h.cold(f, 'integrator', consumer)?.authenticated, true);
    assert.deepEqual(h.cold(f, 'integrator', consumer, originals), originals);
    assert.deepEqual(custody(), before, 'current replay never rewrites legacy originals or recorded launch bindings');
    const snapshot = snapshots.get(originals[0].result.snapshot_sha256);
    const producer = h.physical(process.env.HOME, path.join(plugin, 'scripts/codex-delivery-host.cjs'));
    const bytes = fs.readFileSync(producer);
    assert.ok(snapshot.pins.some(pin => path.resolve(pin.root, pin.path) === producer && pin.sha256 === h.hash(bytes)));
    try {
      fs.appendFileSync(producer, '\n');
      assert.equal(h.cold(f, 'integrator', canonical), null);
      assert.equal(h.cold(f, 'integrator', consumer), null);
    } finally { fs.writeFileSync(producer, bytes); }
    assert.equal(h.cold(f, 'integrator', consumer)?.authenticated, true);
    for (const original of originals) assert.deepEqual(JSON.parse(original.original_text), original.result);
  } }));

test('one genuine package generation matches full identities bytes modes and staged cold public consumers', () =>
  h.publicRole('integrator', 'codex', { inspect({ f, api, plugin, originals, prepared, snapshots }) {
    const before = h.inventory(path.join(h.ROOT, 'plugins/shipyard'));
    const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(f.root, 'candidate'));
    const identity = h.packageParity(candidate);
    assert.deepEqual(h.inventory(path.join(h.ROOT, 'plugins/shipyard')), before);
    const staged = path.join(candidate, 'host/plugins/delivery-pipeline');
    assert.equal(h.cold(f, 'integrator', staged)?.authenticated, true);
    assert.deepEqual(h.cold(f, 'integrator', staged, originals), originals);
    const final = prepared.launches.at(-1), file = h.physical(f.root, final.nativePath), bytes = fs.readFileSync(file);
    const changes = {
      'original final rationale': rows => { rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text += 'changed'; },
      'native turn binding': rows => { rows.find(row => row.type === 'turn_context').payload.turn_id = 'foreign-turn'; },
      'native selection': rows => { rows.find(row => row.type === 'turn_context').payload.model = 'foreign-model'; },
      'installed instructions': rows => { rows.find(row => row.payload?.role === 'developer').payload.content[0].text += 'changed'; },
      'exact original input': rows => { rows.find(row => row.payload?.role === 'user' && row.payload.content.some(block => block.text?.includes('<AUTHENTICATED_SEMANTIC_REVIEW>'))).payload.content[0].text += 'changed'; },
      'ordinary read result': rows => { rows.find(row => row.payload?.type === 'function_call_output').payload.output += 'changed'; },
    };
    for (const [label, change] of Object.entries(changes)) {
      const rows = bytes.toString().trim().split('\n').map(JSON.parse); change(rows);
      try {
        fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        assert.equal(h.cold(f, 'integrator', staged), null, label);
        assert.equal(h.cold(f, 'integrator', plugin), null, label);
      } finally { fs.writeFileSync(file, bytes); }
    }
    assert.equal(h.cold(f, 'integrator', staged)?.authenticated, true);
    const worker = originals[0], originalPin = h.physical(f.root, worker.native.native_pin.path), originalBytes = fs.readFileSync(originalPin);
    try {
      fs.appendFileSync(originalPin, '\n');
      assert.throws(() => api.readSemanticOriginal({ worktreePath: f.worktree, snapshot_sha256: worker.result.snapshot_sha256,
        assignment_id: worker.reference.assignment_id }));
      assert.equal(h.cold(f, 'integrator', staged), null);
    } finally { fs.writeFileSync(originalPin, originalBytes); }
    const snapshot = snapshots.get(originals[0].result.snapshot_sha256);
    const agent = snapshot.pins.find(pin => pin.sha256 === snapshot.agent_sha256);
    const criteria = path.join(plugin, 'references/integrator.md');
    const targets = [path.join(f.worktree, 'src/provider.cjs'), path.join(f.graphDir, 'tickets.json'),
      path.resolve(agent.root, agent.path), criteria, path.join(f.worktree, originals[0].reference.artifact_ref)];
    for (const target of targets) {
      const owned = h.physical(target.startsWith(f.root + path.sep) ? f.root : process.env.HOME, target);
      const before = fs.readFileSync(owned);
      try {
        fs.appendFileSync(owned, '\nchanged immutable source or reference\n');
        if (target === path.join(f.graphDir, 'tickets.json')) {
          assert.throws(() => JSON.parse(fs.readFileSync(owned, 'utf8')), SyntaxError);
          assert.deepEqual(h.cold(f, 'integrator', staged, undefined, 'malformed-graph'), { refused: true, name: 'SyntaxError' });
        } else assert.equal(h.cold(f, 'integrator', staged), null, target);
      } finally { fs.writeFileSync(owned, before); }
    }
    assert.equal(h.cold(f, 'integrator', staged)?.authenticated, true);
    process.stdout.write(JSON.stringify({ package: identity, exact_originals: originals.length, installed_native_acceptance: false }) + '\n');
  } }));

test('complete limitations unread INFO conclusions and unresolved native rationales survive refusal and cold reopening', () =>
  h.publicRole('integrator', 'codex', { incomplete: true, refusal: /SEMANTIC_REVIEW_INCOMPLETE/, inspect({ f, api, plugin, expected, originals, prepared, completed, nativeViews }) {
    assert.equal(prepared.launches.length, 3);
    assert.equal(completed, undefined);
    assert.equal(nativeViews.size, 3);
    assert.deepEqual(nativeViews.get('final'), expected.get('final'));
    assert.deepEqual(expected.get('final').originals, originals.map(item => item.reference));
    for (const original of originals) {
      assert.deepEqual(original.result, expected.get(original.reference.assignment_id));
      assert.equal(original.result.completeness, 'incomplete'); assert.equal(original.result.limitations.length, 1);
      assert.equal(original.result.unread.length, 1); assert.equal(original.result.findings[0].blocking, false);
      assert.equal(original.result.findings[0].type, 'informational');
      assert.equal(original.result.findings[1].blocking, true); assert.equal(original.result.blocking_count, 1);
      assert.equal(original.result.findings[1].summary, original.result.required_context[0]);
      assert.equal(original.result.outcome, 'human-review-required');
      assert.ok(original.result.seams.every(row => row.disposition === 'unresolved' && row.rationale.includes('unavailable')));
      assert.equal(original.result.required_context.length, 1); assert.equal(original.native.reads.semantic_credit, false);
    }
    assert.deepEqual(h.cold(f, 'integrator', plugin, originals), originals);
    assert.equal(api.currentIntegrationVerdict(h.inputFor(f)), null);
  } }));

test('a registered native compaction marker still refuses indexed completion without deleting originals', () =>
  h.publicRole('integrator', 'codex', { refusal: /SEMANTIC_REVIEW_INCOMPLETE/, native(rows, payload) {
    if (payload.stage !== 'worker') return;
    const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
    const marker = template(registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl'), row => row.type === 'event_msg');
    marker.payload = { type: 'compacted' }; rows.splice(-2, 0, marker);
  }, inspect({ originals }) {
    for (const original of originals) {
      assert.ok(original.native.resource_failure); assert.equal(original.native.reads.semantic_credit, false);
    }
  } }));

test('structurally impossible actual final domain refuses before either ordinary worker launch', () => {
  let calls = 0;
  return h.publicRole('integrator', 'codex', { refusal: /SEMANTIC_REVIEW_(?:INPUT|RESULT)_OVER_BOUND/,
    configureFixture(f) {
      const file = h.physical(f.root, path.join(f.worktree, 'src/provider.cjs'));
      fs.writeFileSync(file, Array.from({ length: 24 }, (_, i) => "require('./missing-" + i + '-' + 'dependency-context-'.repeat(1400) + ".cjs');").join('\n'));
      const owner = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'commit');
      owner.commit(f, 'fixture structurally impossible dependency domain');
    }, onLaunch() { calls++; }, inspect({ failure, prepared, snapshots }) {
      assert.equal(calls, 0); assert.equal(prepared.launches.length, 0);
      assert.ok(failure.details.result_bytes > 131072 || failure.details.input_bytes > 1048576);
      const snapshot = [...snapshots.values()][0]; assert.ok(snapshot);
      const assignment = snapshot.assignments.find(item => item.id === failure.details.assignment_id);
      assert.equal(failure.details.original_count, failure.details.stage === 'final' ? 2 : 0);
      assert.equal(snapshot.seams.filter(row => row.uncertain && row.producer.startsWith('src/missing-')).length, 24);
      assert.equal(failure.details.seam_count, h.internals().semanticRequiredView(snapshot, assignment).seams.length);
      assert.equal(failure.details.obligation_count, snapshot.obligations.length);
      assert.ok(failure.details.seam_count >= 24);
      process.stdout.write(JSON.stringify({ refusal: failure.code, ...failure.details, native_launches: calls }) + '\n');
    } });
});


test('real authenticated complete originals overflow exact final input before final native dispatch', () => {
  let workerLaunches = 0, finalLaunches = 0;
  return h.publicRole('integrator', 'codex', { refusal: /SEMANTIC_REVIEW_INPUT_OVER_BOUND/,
    onLaunch(launch) { if (launch.payload.stage === 'worker') workerLaunches++; else finalLaunches++; },
    native(rows, payload) {
      if (payload.stage !== 'worker') return;
      const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
      const registeredRows = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
      const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
      for (let index = 0; index < 2700; index++) {
        const id = 'z21-original-' + index + '-' + 'r'.repeat(180);
        const call = template(registeredRows, row => row.payload?.type === 'function_call');
        Object.assign(call.payload, { name: 'exec_command', call_id: id,
          arguments: JSON.stringify({ cmd: 'cat src/provider.cjs' }),
          internal_chat_message_metadata_passthrough: { turn_id: turn } });
        delete call.payload.namespace;
        const output = template(registeredRows, row => row.payload?.type === 'function_call_output');
        Object.assign(output.payload, { call_id: id, output: JSON.stringify({ exit_code: 0, output: 'exports.value = 1;\n' }),
          internal_chat_message_metadata_passthrough: { turn_id: turn } });
        rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, call, output);
      }
    }, inspect({ failure, originals }) {
      assert.equal(workerLaunches, 2); assert.equal(finalLaunches, 0); assert.equal(originals.length, 2);
      assert.equal(failure.details.stage, 'final'); assert.equal(failure.details.original_count, 2);
      assert.ok(failure.details.input_bytes > 1048576); assert.ok(failure.details.result_bytes < 131072);
      for (const original of originals) {
        assert.equal(original.native.reads.incomplete.length, 0);
        assert.ok(original.native.reads.completed.length >= 2700);
        assert.equal(original.result.completeness, 'complete'); assert.ok(original.result.findings.length);
        assert.equal(original.original_text, JSON.stringify(JSON.parse(original.original_text)));
      }
    } });
});

for (const runtime of ['codex', 'claude']) test(runtime + ' indexed final cannot substitute original references or launch binding', () =>
  h.publicRole('integrator', runtime, { refusal: /SEMANTIC_REVIEW_INCOMPATIBLE/, result(result, payload) {
    if (payload.stage === 'final') result.originals[0].artifact_sha256 = 'f'.repeat(64);
  }, inspect({ originals }) { assert.equal(originals.length, 2); } }));

test('selector retains frozen old40 z20 prefix and appends only z21 z21b without a future ceiling', () => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'], ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const ticket = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'], [path.basename(__filename)]];
  const actual = s.appendShard(manifest, s.unitTasks(s.unitFiles()));
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(actual.shards.slice(0, 39), first39); assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.deepEqual(actual.shards.slice(0, 43), ticket);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z21-selector-'));
  try {
    for (const file of new Set(ticket.flat().map(task => s.parseTask(task).file))) fs.writeFileSync(path.join(directory, file), '');
    const current = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
    assert.equal(current.shards.length, 43); assert.equal(current.shards.length + 3, 46);
    for (let i = 0; i < actual.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
    for (const file of s.unitFiles()) fs.writeFileSync(path.join(directory, file), '');
    fs.writeFileSync(path.join(directory, 'zz-future-result.test.cjs'), '');
    const future = s.appendShard(actual, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(future.shards.slice(0, actual.shards.length), actual.shards);
    assert.deepEqual(future.shards.at(-1), ['zz-future-result.test.cjs']);
    for (let i = 0; i < future.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${future.shards.length}`, directory, actual), future.shards[i]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

if (isMainThread) describe('phase 53 complete semantic result custody', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-'))); let worker;
    t.after(async () => { await worker?.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
    const env = { ...process.env, HOME: home };
    for (const key of Object.keys(env)) if (/^(SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|GIT_CONFIG_)/.test(key)) delete env[key];
    for (const key of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: index, env }); let completed = false, failure;
      worker.once('message', message => { completed = message?.completed === true; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => failure ? reject(failure) : code || !completed ? reject(Error(entry.title + ' exited without assertions: ' + code)) : resolve());
    });
  });
});
else Promise.resolve().then(() => cases[workerData].run()).then(() => parentPort.postMessage({ completed: true }))
  .catch(error => setImmediate(() => { throw error; }));
