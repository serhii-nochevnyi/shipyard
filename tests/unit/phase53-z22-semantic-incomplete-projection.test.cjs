'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
const cases = [];
const test = (title, run) => cases.push({ title, run });

function report(count = 129, stage = 'worker') {
  const coverage = Array.from({ length: 458 }, (_, i) => 'o-' + h.hash('z22-obligation-' + i));
  return { review_contract: 'shipyard.semantic-review.v1', role: 'code-review', stage,
    snapshot_sha256: 'a'.repeat(64), binding_sha256: 'b'.repeat(64), assignment_id: stage === 'worker' ? 'code-correctness' : null,
    completeness: 'incomplete', outcome: 'human-review-required', blocking_count: 0,
    coverage, unread: coverage.slice(0, count), required_context: [], limitations: [], findings: [], dispositions: [] };
}
function projection(result, domain = result.coverage) {
  return core.semanticUnresolvedProjection(result, { obligationIds: domain });
}
function assertProjection(result, value) {
  const candidate = [...result.required_context, ...result.unread];
  assert.equal(value.review_completeness, 'incomplete');
  if (candidate.length <= 128) assert.deepEqual(value.unresolved_sources, candidate);
  else {
    assert.equal(value.unresolved_sources.length, 1);
    const [reference] = value.unresolved_sources;
    assert.ok(reference.trim()); assert.ok(Buffer.byteLength(reference) <= 1024);
    for (const part of [result.snapshot_sha256, result.stage, result.assignment_id || 'final', result.binding_sha256])
      assert.ok(reference.includes(part), part);
    assert.equal(result.coverage.includes(reference), false, 'diagnostic linkage grants no obligation coverage');
  }
}
function growInventory(f) {
  const { execFileSync } = require('node:child_process');
  h.physical(f.root, path.join(f.worktree, '.git/config'));
  // @invariant: The enlarged fixture must not repack objects in the background while its local origin is cloned.
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']])
    execFileSync('git', ['-C', f.worktree, 'config', '--local', key, value], { timeout: 30000, stdio: 'pipe' });
  for (let i = 0; i < 340; i++) {
    const file = h.physical(f.root, path.join(f.worktree, 'src/domain-' + i + '.cjs'));
    fs.writeFileSync(file, 'exports.contract' + i + ' = ' + i + ';\n');
  }
  h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'commit').commit(f, 'fixture complete external obligations');
}
function incompleteInventories(runtime, counts, full = false) {
  return h.publicRole('code-review', runtime, { incomplete: true, full, configureFixture: growInventory,
    result(result, payload) {
      const catalog = JSON.parse(fs.readFileSync(payload.catalog.read_path, 'utf8'));
      const count = counts[result.assignment_id || 'final'];
      assert.ok(catalog.obligations.length >= count);
      result.unread = catalog.obligations.slice(0, count).map(item => item.id);
      result.conclusions.push('Native unresolved inventory has ' + count + ' actual snapshot obligations, in original order.');
      result.evidence_markdown += 'Native ' + (result.assignment_id || 'final') + ': every unread identity remains unresolved. Ω\n';
    }, inspect({ f, api, plugin, originals, prepared, completed, expected, snapshots, nativeViews }) {
      const final = expected.get('final'), snapshot = snapshots.get(final.snapshot_sha256);
      assert.equal(prepared.launches.length, 3); assert.equal(nativeViews.size, 3);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      assert.deepEqual(prepared.launches.at(-1).payload.originals.map(item => item.result), originals.map(item => item.result));
      const finalInputText = prepared.launches.at(-1).input || prepared.launches.at(-1).prompt;
      const finalInput = JSON.parse(finalInputText.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
      assert.ok(Buffer.byteLength(finalInputText) < 1048576);
      for (const [index, original] of originals.entries()) {
        assert.equal(original.result.unread.length, counts[original.reference.assignment_id]);
        assert.deepEqual(original.result, expected.get(original.reference.assignment_id));
        assert.equal(original.result.findings[0].severity, 'INFO');
        assert.equal(original.result.findings[1].severity, 'BLOCKER');
        assert.equal(original.result.blocking_count, 1); assert.equal(original.result.outcome, 'human-review-required');
        assert.equal(original.result.required_context.length, 1);
        assert.equal(original.result.limitations.length, 1); assert.equal(original.native.reads.semantic_credit, false);
        const wire = JSON.parse(original.original_text);
        assert.ok(Buffer.byteLength(original.original_text) <= 131072);
        const launch = prepared.launches[index];
        const launchView = { ...launch.payload, assignment_id: launch.payload.assignment.id, input: launch.input || launch.prompt };
        assert.deepEqual(h.internals(plugin).decodeSemanticResult(wire, launchView, snapshot), original.result);
        assert.equal(wire.evidence_markdown, original.result.evidence_markdown);
        assert.deepEqual(wire.findings, original.result.findings);
        const input = finalInput.originals[index];
        assert.equal(fs.readFileSync(input.read_path, 'utf8'), original.original_text);
        if (!full) {
          const bytes = fs.readFileSync(input.expanded_view.read_path);
          assert.equal(bytes.length, input.expanded_view.bytes); assert.equal(h.hash(bytes), input.expanded_view.sha256);
          assert.deepEqual(JSON.parse(bytes), original.result);
        }
        assertProjection(original.result, projection(original.result, snapshot.obligations.map(item => item.id)));
      }
      assert.equal(final.unread.length, counts.final);
      assert.equal(completed.result.verdict, 'incomplete'); assert.equal(completed.result.review_completeness, 'incomplete');
      assertProjection(final, completed.result);
      for (const key of ['unread', 'required_context', 'limitations', 'outcome', 'conclusions', 'seams', 'dispositions'])
        assert.deepEqual(completed.result[key], final[key]);
      assert.equal(completed.result.info_dropped, 1); assert.equal(completed.result.blocking_count, 1);
      const current = api.currentCodeReviewVerdict(h.inputFor(f));
      assert.equal(current.authenticated, true); assert.equal(current.verdict, 'incomplete');
      const stagedPackage = require('../../scripts/package-shipyard-codex.cjs').build(h.physical(process.env.HOME, path.join(process.env.HOME, 'staged-package')));
      h.packageParity(stagedPackage);
      const staged = path.join(stagedPackage, 'host/plugins/delivery-pipeline');
      assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
      const cold = h.cold(f, 'code-review', staged);
      assert.equal(cold.authenticated, true); assert.equal(cold.verdict, 'incomplete');
      const manifestBytes = fs.readFileSync(h.physical(f.root, cold.artifact_ref));
      assert.equal(h.hash(manifestBytes), cold.artifact_digest);
      const manifest = JSON.parse(manifestBytes), findingsPin = manifest.files.findings;
      const findingsBytes = fs.readFileSync(h.physical(f.root, path.resolve(f.worktree, findingsPin.path)));
      assert.equal(findingsBytes.length, findingsPin.bytes); assert.equal(h.hash(findingsBytes), findingsPin.sha256);
      const retainedFinal = JSON.parse(findingsBytes);
      assert.deepEqual(retainedFinal.unresolved_sources, completed.result.unresolved_sources);
      assertProjection(final, retainedFinal);
      for (const key of ['unread', 'required_context', 'limitations', 'outcome', 'conclusions', 'seams', 'dispositions'])
        assert.deepEqual(retainedFinal[key], final[key]);
      const pin = h.physical(f.root, originals[0].native.native_pin.path), bytes = fs.readFileSync(pin);
      try { fs.appendFileSync(pin, '\n'); assert.equal(h.cold(f, 'code-review', plugin), null); }
      finally { fs.writeFileSync(pin, bytes); }
      assert.equal(h.cold(f, 'code-review', plugin).verdict, 'incomplete');
      process.stdout.write(JSON.stringify({ runtime, full_wire: full, worker_unread: originals.map(item => item.result.unread.length),
        final_unread: final.unread.length, legacy_unresolved: completed.result.unresolved_sources,
        installed_native_acceptance: false, R8: 'INCOMPLETE', semantic_credit: 0 }) + '\n');
    } });
}

test('ordinary Codex retains honest 129 and 130 unread originals for a distinct 328 unread final and cold consumers', () =>
  incompleteInventories('codex', { 'code-correctness': 129, 'code-acceptance': 130, final: 328 }));

test('one strict shared helper preserves exact combined 128 and references only complete overflow inventories', () => {
  for (const stage of ['worker', 'final']) for (const count of [128, 129, 130, 328]) {
    const result = report(count, stage), before = h.clone(result);
    const projected = projection(result); assertProjection(result, projected);
    assert.deepEqual(projection(h.clone(result)), projected); assert.deepEqual(result, before);
    const combined = report(64, stage);
    combined.required_context = Array.from({ length: count - 64 }, (_, i) => ' External context Ω ' + i + ' ');
    assertProjection(combined, projection(combined));
    assert.deepEqual(combined.required_context, Array.from({ length: count - 64 }, (_, i) => ' External context Ω ' + i + ' '));
    const contextOnly = report(0, stage);
    contextOnly.required_context = Array.from({ length: count }, (_, i) => 'Context ' + i);
    assertProjection(contextOnly, projection(contextOnly));
  }
  const result = report(129), options = { round: 1, scope: 'full' };
  assert.throws(() => core.normalizeResult({ ...result, review_completeness: 'incomplete', unresolved_sources: result.unread }, options), /128/);
  const normalized = core.normalizeResult({ ...result, ...projection(result) }, options);
  assert.equal(normalized.verdict, 'incomplete');
  const changed = h.clone(result); changed.binding_sha256 = 'c'.repeat(64);
  assert.notDeepEqual(projection(changed), projection(result));
});

test('all overflow entries and identity membership refuse before constructing any diagnostic reference', () => {
  const mutations = {
    'context nonarray': r => { r.required_context = 'missing'; },
    'unread nonarray': r => { r.unread = null; },
    'context number': r => { r.required_context = Array(129).fill('context'); r.required_context[128] = 7; },
    'context empty': r => { r.required_context = ['']; },
    'context whitespace': r => { r.required_context = [' \n ']; },
    'context over byte bound': r => { r.required_context = ['Ω'.repeat(513)]; },
    'context sparse': r => { r.required_context = Array(129); },
    'unread nonstring': r => { r.unread[128] = {}; },
    'unread empty': r => { r.unread[128] = ''; },
    'unread whitespace': r => { r.unread[128] = ' '; },
    'unread over byte bound': r => { r.unread[128] = 'x'.repeat(1025); },
    'unread foreign': r => { r.unread[128] = 'o-foreign'; },
    'unread duplicate': r => { r.unread[128] = r.unread[0]; },
    'unread sparse': r => { delete r.unread[128]; },
    'limitation nonstring': r => { r.limitations = [false]; },
  };
  for (const stage of ['worker', 'final']) for (const [label, mutate] of Object.entries(mutations)) {
    const result = report(129, stage); mutate(result);
    Object.defineProperty(result, 'snapshot_sha256', { get() { assert.fail('reference identity read before validation: ' + label); } });
    assert.throws(() => projection(result), error => error.code === 'INVALID_RESULT', stage + ' ' + label);
  }
  const combined = report(64); combined.required_context = Array(65).fill('context');
  combined.required_context[64] = false;
  assert.throws(() => projection(combined), { code: 'INVALID_RESULT' });
  const exact = report(0); exact.required_context = Array(129).fill('Ω'.repeat(512));
  assertProjection(exact, projection(exact));
  const malformedIdentity = {
    snapshot: r => { r.snapshot_sha256 = 'unknown'; }, binding: r => { r.binding_sha256 = ''; },
    assignment: r => { r.assignment_id = ''; }, stage: r => { r.stage = 'unknown'; },
    'oversize reference': r => { r.assignment_id = 'x'.repeat(1024); },
    'final assignment': r => { r.stage = 'final'; },
  };
  for (const [label, mutate] of Object.entries(malformedIdentity)) {
    const result = report(); mutate(result);
    assert.throws(() => projection(result), { code: 'INVALID_RESULT' }, label);
  }
  const worker = report(); worker.coverage = worker.coverage.slice(0, 1);
  assert.throws(() => projection(worker), /obligation domain/);
  assertProjection(worker, projection(worker, report().coverage));
});

test('shared final projection preserves semantic values INFO and carried dispositions while clean complete rules stay exact', () => {
  const file = 'src/provider.cjs', text = 'exports.value = 1;', ref = 'carried-blocker';
  const prior = { ref, id: 'prior', rule: 'contract', severity: 'BLOCKER', path: file, line: 1,
    summary: 'Consumer contract remains unresolved.', failure_scenario: 'Consumer may observe the wrong value.',
    identity: core.lineIdentity({ path: file, lineText: text, ordinal: 1 }), line_text: text, occurrence: 1,
    fix_ticket: { title: 'Preserve consumer value', scope: 'Verify producer and consumer', files: [file] } };
  const packet = { role_context: { review_round: 2, review_scope: 'full', prior_head: 'c'.repeat(40),
    contract_digest: 'd'.repeat(64), dispositions_digest: 'e'.repeat(64),
    normalization_inputs: { prior_findings: [prior] }, planning_reference: null }, required_refs: [] };
  const options = { packet, identity: { head: 'f'.repeat(40), base: 'c'.repeat(40) }, readSource: () => text + '\n' };
  for (const count of [128, 129, 130, 328]) {
    const result = report(count, 'final');
    result.findings = [{ id: 'native-info', severity: 'INFO', summary: 'Native INFO retains every observation Ω.' }];
    result.dispositions = [{ ref, disposition: 'unresolved', justification: 'Native final retains the unresolved producer contract.' }];
    result.blocking_count = 1;
    result.evidence_markdown = 'Complete native prose Ω\n';
    const before = h.clone(result), projected = core.projectSemanticResult(result, options);
    assertProjection(result, projected); assert.deepEqual(result, before);
    for (const key of ['unread', 'required_context', 'limitations', 'outcome', 'evidence_markdown']) assert.deepEqual(projected[key], result[key]);
    assert.deepEqual(projected.semantic_coverage, result.coverage); assert.deepEqual(projected.coverage, []);
    assert.equal(projected.info_dropped, 1); assert.equal(projected.blocking_count, 1); assert.equal(projected.findings[0].ref, ref);
    assert.deepEqual(projected.dispositions, result.dispositions.map(item => ({ ...item, source: 'reviewer' })));
    const cleaned = h.clone(result); cleaned.unread = []; cleaned.completeness = 'complete'; cleaned.outcome = 'needs-fix';
    assert.equal(core.projectSemanticResult(cleaned, options).verdict, 'needs-fix');
    cleaned.dispositions = [{ ref, disposition: 'resolved', justification: 'The native final verified the repair.' }];
    cleaned.outcome = 'passed'; cleaned.blocking_count = 0;
    assert.equal(core.projectSemanticResult(cleaned, options).verdict, 'pass');
    for (const mutate of [r => { r.completeness = 'blocked'; }, r => { r.completeness = 'incomplete'; },
      r => { r.required_context = ['Context remains unresolved']; }, r => { r.unread = [r.coverage[0]]; },
      r => { r.limitations = ['Native limitation remains']; }]) {
      const incomplete = h.clone(cleaned); mutate(incomplete);
      assert.equal(core.projectSemanticResult(incomplete, options).verdict, 'incomplete');
    }
  }
});

test('wire bound and complete global index decoding precede worker inventory projection', () => {
  const a = h.internals(), fixture = h.sizingRecord(h.currentSized('code-review'));
  const { snapshot } = fixture.record;
  try {
    const launch = a.semanticBuildLaunch(fixture.record, 'worker', snapshot.assignments[0].id, [], true);
    const payload = JSON.parse(launch.input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
    for (const source of snapshot.material) fs.writeFileSync(h.physical(fixture.directory,
      path.join(fixture.record.input_root, source.source_id + '.txt')), source.content);
    const material = snapshot.material.map(({ content, ...source }) => ({ ...source,
      read_path: path.join(fixture.record.input_root, source.source_id + '.txt'), bytes: Buffer.byteLength(content), sha256: h.hash(content) }));
    fs.writeFileSync(h.physical(fixture.directory, payload.catalog.read_path), h.stable({
      responsibility_view_version: snapshot.responsibility_view_version, material, obligations: snapshot.obligations, seams: snapshot.seams }));
    const wire = a.semanticStructuralResult(snapshot, launch);
    wire.unread_indices = Array.from({ length: 328 }, (_, i) => i);
    const expanded = a.validateSemanticResult(wire, launch, fixture.record);
    assert.deepEqual(expanded.unread, snapshot.obligations.slice(0, 328).map(item => item.id));
    const before = h.clone(wire);
    assertProjection(expanded, projection(expanded, snapshot.obligations.map(item => item.id)));
    assert.deepEqual(wire, before);
    for (const index of [-1, 458, '1', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = h.clone(wire); invalid.unread_indices[128] = index;
      assert.throws(() => a.validateSemanticResult(invalid, launch, fixture.record));
    }
    const invalid = h.clone(wire); invalid.required_context = ['Ω'.repeat(513)];
    assert.throws(() => a.validateSemanticResult(invalid, launch, fixture.record), { code: 'INVALID_RESULT' });
    const oversize = h.clone(wire); oversize.evidence_markdown = 'x'.repeat(131072);
    assert.throws(() => a.validateSemanticResult(oversize, launch, fixture.record), /wire exceeds its bound/);
    assert.throws(() => a.semanticWireBound({ result: oversize, text: JSON.stringify(oversize) }), error =>
      error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND' && error.details.limit_bytes === 131072);
    assert.throws(() => a.semanticPreflight(snapshot, { ...launch, input: launch.input + 'x'.repeat(1048576) }), error =>
      error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND' && error.details.limit_bytes === 1048576);
  } finally { fixture.close(); }
});

test('ordinary Claude preserves full 328 and 128 unread originals for a distinct 129 unread final and cold replay', () =>
  incompleteInventories('claude', { 'code-correctness': 328, 'code-acceptance': 128, final: 129 }, true));

for (const role of ['code-review', 'integrator', 'arch-review']) for (const runtime of ['codex', 'claude'])
  test(role + ' ' + runtime + ' clean recorded public completion preserves INFO and cold current authority', () =>
    h.publicRole(role, runtime, { inspect({ completed, originals, expected }) {
      assert.equal(expected.get('final').completeness, 'complete'); assert.equal(expected.get('final').outcome, 'passed');
      for (const original of originals) {
        assert.equal(original.result.findings.length, 1); assert.equal(original.native.resource_failure, null);
        assert.equal(original.native.reads.semantic_credit, false);
      }
      if (role === 'code-review') { assert.equal(completed.result.verdict, 'pass'); assert.equal(completed.result.info_dropped, 1); }
    } }));

for (const runtime of ['codex', 'claude']) test(runtime + ' complete final cannot accept resource or native read failure retained in workers', () => {
  return h.publicRole('code-review', runtime, { refusal: /SEMANTIC_REVIEW_INCOMPLETE/,
    native(rows, payload) {
      if (payload.stage !== 'worker') return;
      if (payload.assignment.id === 'code-correctness') {
        if (runtime === 'codex') {
          const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
          const marker = template(registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl'), row => row.type === 'event_msg');
          marker.payload = { type: 'compacted' }; rows.splice(-2, 0, marker);
        } else rows.at(-1).message.stop_reason = 'max_tokens';
      } else if (runtime === 'codex') {
        const output = rows.find(row => row.payload?.type === 'function_call_output');
        assert.ok(output); output.payload.output = JSON.stringify({ exit_code: 1, output: 'Native read failed' });
      } else {
        const response = rows.find(row => row.message?.content?.[0]?.type === 'tool_result');
        assert.ok(response); response.message.content[0].is_error = true;
      }
    }, inspect({ f, plugin, originals, completed, prepared }) {
      assert.equal(completed, undefined); assert.equal(prepared.launches.length, 3);
      assert.ok(originals.find(item => item.reference.assignment_id === 'code-correctness').native.resource_failure);
      assert.ok(originals.find(item => item.reference.assignment_id === 'code-acceptance').native.reads.incomplete.length);
      assert.deepEqual(h.cold(f, 'code-review', plugin, originals), originals);
      for (const original of originals) assert.equal(original.native.reads.semantic_credit, false);
    } });
});

test('genuine isolated package retains both current mirror pairs full identities staged projection and immutable baseline', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z22-package-')));
  try {
    const shipped = path.join(h.ROOT, 'plugins/shipyard'), before = h.inventory(shipped);
    const candidate = require('../../scripts/package-shipyard-codex.cjs').build(h.physical(directory, path.join(directory, 'package')));
    assert.deepEqual(h.inventory(shipped), before);
    const identity = h.packageParity(candidate);
    for (const name of ['code-review-core.cjs', 'role-artifact.cjs']) for (const root of [candidate, shipped]) {
      const canonical = path.join(h.SCRIPTS, name), mirror = path.join(root, 'host/plugins/delivery-pipeline/scripts', name);
      assert.equal(fs.lstatSync(canonical).isFile(), true); assert.equal(fs.lstatSync(mirror).isFile(), true);
      assert.equal(fs.lstatSync(canonical).isSymbolicLink(), false); assert.equal(fs.lstatSync(mirror).isSymbolicLink(), false);
      assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonical));
      assert.equal(fs.statSync(mirror).mode & 0o777, fs.statSync(canonical).mode & 0o777);
    }
    const staged = require(path.join(candidate, 'host/plugins/delivery-pipeline/scripts/code-review-core.cjs'));
    assert.notEqual(staged, core); assert.deepEqual(staged.semanticUnresolvedProjection(report()), projection(report()));
    const { execFileSync } = require('node:child_process');
    const relative = 'plugins/shipyard/host/plugins/delivery-pipeline/scripts/code-review-core.cjs';
    const baseline = execFileSync('git', ['show', '4f9da2383097a4c206a61741fbd24ac69646990c:' + relative], { cwd: h.ROOT });
    assert.deepEqual(baseline, execFileSync('git', ['show', 'c2ad047847271e8790b1e6d2e002c97f00270080:' + relative], { cwd: h.ROOT }));
    assert.equal(h.hash(baseline), 'bf804fda349e2d21a0023e6f95a6dc32737e0016dfff743081092b1fa425b4a5');
    const captureBytes = fs.readFileSync(path.join(h.ROOT, 'tests/fixtures/phase53/github-job-attempts.json'));
    assert.equal(JSON.parse(captureBytes).parent.other_package_inventory_sha256, '40a34a0f03f5a0dd5afa9ba94c1ddb382e84abc4936cc858fc7bf6ab99119807');
    process.stdout.write(JSON.stringify({ package: identity, original_core_sha256: h.hash(baseline), installed_native_acceptance: false }) + '\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual selectors preserve frozen 16 28 39 40 and T20 T21 T21b rows append z22 and permit future rows', () => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'], ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const ticket = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], [path.basename(__filename)]];
  const actual = s.appendShard(manifest, s.unitTasks(s.unitFiles()));
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(actual.shards.slice(0, 39), first39); assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.deepEqual(actual.shards.slice(0, 44), ticket);
  for (let i = 0; i < actual.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z22-selector-')));
  try {
    for (const file of new Set(ticket.flat().map(task => s.parseTask(task).file))) fs.writeFileSync(h.physical(directory, path.join(directory, file)), '');
    const current = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(current.shards, ticket); assert.equal(current.shards.length, 44); assert.equal(current.shards.length + 3, 47);
    for (const file of s.unitFiles()) fs.writeFileSync(h.physical(directory, path.join(directory, file)), '');
    fs.writeFileSync(h.physical(directory, path.join(directory, 'zz-future-projection.test.cjs')), '');
    const future = s.appendShard(actual, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(future.shards.slice(0, actual.shards.length), actual.shards);
    assert.deepEqual(future.shards.at(-1), ['zz-future-projection.test.cjs']);
    for (let i = 0; i < future.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${future.shards.length}`, directory, actual), future.shards[i]);
    process.stdout.write(JSON.stringify({ actual_unit_rows: actual.shards.length, actual_workflow_checks: actual.shards.length + 3,
      ticket_unit_rows: 44, ticket_workflow_checks: 47, future_append: true, installed_native_acceptance: false, R8: 'INCOMPLETE', semantic_credit: 0 }) + '\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

if (isMainThread) describe('phase 53 complete incomplete semantic projection', { concurrency: 2 }, () => {
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
