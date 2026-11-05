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

test('ordinary Codex integrator authenticates indexed workers independent final and cold current view', () =>
  h.publicRole('integrator', 'codex', { inspect({ originals, prepared, expected }) {
    for (const original of originals) {
      assert.equal(JSON.parse(original.original_text).result_format, 'snapshot-indexed.v1');
      assert.equal(original.result.findings.length, 1);
      assert.ok(original.result.seams.every(row => row.rationale.length > 50));
    }
    const final = prepared.launches.at(-1);
    assert.deepEqual(final.payload.originals.map(item => item.result), originals.map(item => item.result));
    assert.deepEqual(final.payload.originals.map(item => item.reference), expected.get('final').originals);
    const payload = JSON.parse(final.input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
    for (const item of payload.originals) {
      assert.ok(item.expanded_view);
      const view = fs.readFileSync(item.expanded_view.read_path);
      assert.equal(h.hash(view), item.expanded_view.sha256); assert.equal(view.length, item.expanded_view.bytes);
      assert.notEqual(item.expanded_view.read_path, item.read_path);
    }
    assert.ok(Buffer.byteLength(final.input) < 1048576);
  } }));

test('complete current-sized 458 obligation 663 seam reports retain every native field under original wire limit', () => {
  const a = h.internals(), measurements = [];
  for (const role of ['integrator', 'arch-review', 'code-review']) for (const runtime of ['codex', 'claude']) {
    const fixture = h.sizingRecord(h.currentSized(role, runtime)), snapshot = fixture.record.snapshot, workers = [];
    try {
    for (const assignment of snapshot.assignments) {
      const launch = a.semanticBuildLaunch(fixture.record, 'worker', assignment.id, [], true);
      const minimal = a.semanticStructuralResult(snapshot, launch);
      const full = a.decodeSemanticResult(minimal, launch, snapshot);
      h.richReport(full, snapshot, { incomplete: true });
      const wire = h.indexed(full, snapshot), raw = h.stable(wire);
      assert.ok(Buffer.byteLength(raw) <= 131072);
      assert.deepEqual(a.decodeSemanticResult(JSON.parse(raw), launch, snapshot), full);
      assert.equal(full.limitations.length, 1); assert.equal(full.findings.length, 2);
      assert.equal(full.blocking_count, 1);
      assert.equal(full.unread.length, 1); assert.ok(full.seams.every(row => row.disposition === 'unresolved'));
      const pin = { path: path.join(fixture.directory, 'worker-' + workers.length + '.jsonl'), bytes: 1, sha256: h.hash('controlled-native') };
      workers.push({ reference: { assignment_id: assignment.id, dispatch_id: launch.dispatch_id,
        artifact_ref: a.archiveRelative(launch.dispatch_id, a.MANIFEST_NAME), artifact_sha256: h.hash(raw) },
        original_text: raw, result: full, native: { native_pin: pin, output_pin: pin,
          observation: [], accounting: { status: 'unknown' }, resource_failure: null,
          reads: { schema: 'shipyard.semantic-native-reads.v1', completed: [], incomplete: [], output_bytes: 0, semantic_credit: false },
          session_id: 'worker-' + workers.length } });
    }
    const launch = a.semanticBuildLaunch(fixture.record, 'final', null, workers, true);
    const full = a.decodeSemanticResult(a.semanticStructuralResult(snapshot, launch), launch, snapshot);
    h.richReport(full, snapshot, { incomplete: true });
    if (role === 'code-review') full.dispositions = [{ ref: 'carried-native', disposition: 'open', rationale: 'The prior blocker remains observable.' }];
    const wire = h.indexed(full, snapshot), terminal = JSON.stringify(wire);
    assert.ok(Buffer.byteLength(terminal) < 131072);
    assert.deepEqual(a.decodeSemanticResult(JSON.parse(terminal), launch, snapshot), full);
    assert.deepEqual(full.reviewed_identity, snapshot.identity);
    assert.deepEqual(full.coverage, snapshot.obligations.map(item => item.id));
    assert.deepEqual(full.seams.map(item => item.id), snapshot.seams.map(item => item.id));
    assert.equal(new Set(full.seams.map(item => item.rationale)).size, 663);
    assert.deepEqual(full.originals, workers.map(item => item.reference));
    const payload = JSON.parse(launch.input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
    for (const [index, item] of payload.originals.entries()) {
      for (const [descriptor, bytes] of [[item, workers[index].original_text], [item.expanded_view, h.stable(workers[index].result)]]) {
        fs.writeFileSync(h.physical(fixture.directory, descriptor.read_path), bytes);
        assert.equal(h.hash(fs.readFileSync(descriptor.read_path)), descriptor.sha256);
        assert.equal(Buffer.byteLength(bytes), descriptor.bytes);
      }
    }
    const measurement = a.semanticPreflight(snapshot, launch);
    assert.ok(measurement.input_bytes < 1048576, 'exact launch with both complete original wire and expanded file views fits');
    assert.equal(payload.originals.length, 2);
    assert.deepEqual(payload.originals.map(item => item.reference), workers.map(item => item.reference));
    const legacyThreeFields = h.stable({ reviewed_identity: full.reviewed_identity, coverage: full.coverage, seams: full.seams });
    assert.ok(Buffer.byteLength(legacyThreeFields) > 131072);
    measurements.push({ role, runtime, identity_bytes: Buffer.byteLength(h.stable(snapshot.identity)),
      wire_bytes: Buffer.byteLength(terminal), expanded_bytes: Buffer.byteLength(h.stable(full)),
      both_complete_originals_input_bytes: measurement.input_bytes, prompt_bytes: measurement.prompt_bytes,
      schema_bytes: measurement.schema_bytes, structural_minimum_only: false });
    } finally { fixture.close(); }
  }
  process.stdout.write(JSON.stringify({ controlled_current_sized_fixture: measurements, actual_native_phase_proof: false }) + '\n');
});

for (const [role, runtime] of [['arch-review', 'codex'], ['code-review', 'codex'], ['integrator', 'claude'],
  ['arch-review', 'claude'], ['code-review', 'claude']]) {
  test(role + ' ' + runtime + ' ordinary indexed full semantic view survives recorded recovery and fresh cold reopening', () => h.publicRole(role, runtime));
}

test('complete structural result and exact instruction schema input overflow refuse with concrete counts before launch', () => {
  const a = h.internals(), snapshot = h.currentSized(), launch = h.sizedLaunch(snapshot, 'final');
  const normal = a.semanticPreflight(snapshot, launch);
  assert.equal(normal.original_count, 2); assert.equal(normal.obligation_count, 458); assert.equal(normal.seam_count, 663);
  let launches = 0;
  const dispatch = (s, l) => { a.semanticPreflight(s, l); launches++; };
  const huge = h.clone(snapshot);
  huge.seams = Array.from({ length: 3000 }, (_, i) => ({ id: 'seam-' + h.hash(String(i)) }));
  assert.throws(() => dispatch(huge, launch), error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND'
    && error.details.result_bytes > 131072 && error.details.seam_count === 3000 && error.details.original_count === 2);
  assert.equal(launches, 0);
  const overInput = { ...launch, input: launch.input + ' '.repeat(1048576) };
  assert.throws(() => dispatch(snapshot, overInput), error => error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND'
    && error.details.input_bytes > 1048576 && error.details.result_bytes > 0);
  assert.equal(launches, 0);
});

if (isMainThread) describe('phase 53 complete semantic result wire', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-')));
    let worker;
    t.after(async () => { await worker?.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
    const env = { ...process.env, HOME: home };
    for (const key of Object.keys(env)) if (/^(SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|GIT_CONFIG_)/.test(key)) delete env[key];
    for (const key of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: index, env });
      let completed = false, failure;
      worker.once('message', message => { completed = message?.completed === true; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => failure ? reject(failure) : code || !completed
        ? reject(Error(entry.title + ' exited without assertions: ' + code)) : resolve());
    });
  });
});
else Promise.resolve().then(() => cases[workerData].run()).then(() => parentPort.postMessage({ completed: true }))
  .catch(error => setImmediate(() => { throw error; }));
