'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
const { root, scripts, runtime, hash, stable, serialize, user, fixtureHelpers,
  initialization, installInstructions, orderedFixture, mutations, coldProcess }
  = require('../fixtures/phase53/codex-preamble-helpers.cjs');

for (const preamble of [false, true]) test('ordinary original/final and fresh cold consumer authenticate ' + (preamble ? 'two-user initialization' : 'no-preamble input'), async () => {
  const h = fixtureHelpers();
  await h.publicIntegrationFixture(async f => {
    installInstructions(f);
    const prepared = h.semanticFixture(f, { native(rows) {
      if (preamble) rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0,
        initialization(f.worktree, undefined, prepared.launches.at(-1).runtime_args));
    } });
    const completed = await h.supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(completed.result.outcome, 'passed');
    const originals = h.captureOriginals(f, prepared);
    for (const original of originals) {
      const receipt = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id).receipt;
      const pin = receipt.runtime_evidence.initial_context;
      assert.equal(pin.launch.binding.input_sha256, hash(prepared.launches.find(item => item.payload.assignment?.id === original.reference.assignment_id).input));
      assert.equal(pin.native_sha256, original.native.native_pin.sha256);
      assert.equal(pin.session_id, original.native.session_id);
      assert.equal(pin.launch.sources.length, 2);
      assert.equal(pin.preamble_sha256 === null, !preamble);
      const raw = fs.readFileSync(original.native.native_pin.path, 'utf8');
      assert.deepEqual(runtime.verifySemanticReads(raw, { input: prepared.launches.find(item => item.payload.assignment?.id === original.reference.assignment_id).input,
        initialContext: pin.launch, sessionId: pin.session_id }).incomplete, []);
    }
    assert.equal(h.coldCurrent(f)?.authenticated, true);
    const child = coldProcess(f);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'true');
    const shipped = coldProcess(f, path.join(root, 'plugins/shipyard/host/plugins/delivery-pipeline/scripts'));
    assert.equal(shipped.status, 0, shipped.stderr);
    assert.equal(shipped.stdout.trim(), 'true');
    if (preamble) {
      const global = path.join(process.env.CODEX_HOME, 'AGENTS.md'), before = fs.readFileSync(global);
      fs.writeFileSync(global, 'Today is a different instruction generation.\n');
      const retained = coldProcess(f);
      assert.equal(retained.status, 0, retained.stderr);
      assert.equal(retained.stdout.trim(), 'true', 'original provenance is not reconstructed from today’s global instructions');
      fs.writeFileSync(global, before);
      const final = prepared.launches.find(item => item.payload.stage === 'final');
      const dispatchId = completed.dispatch_id;
      const recordPath = path.join(prepared.recorder.storeDir, 'record-' + hash(dispatchId) + '.json');
      const originalRecord = fs.readFileSync(recordPath);
      for (const mutate of [
        pin => { for (const key of Object.keys(pin)) delete pin[key]; },
        pin => { delete pin.launch; }, pin => { pin.launch.instructions = 'Substituted global instruction.'; },
        pin => {
          const source = pin.launch.sources[0]; source.text = 'Forged global guidance.\n';
          source.bytes = Buffer.byteLength(source.text); source.sha256 = hash(source.text);
          pin.launch.instructions = pin.launch.sources.map(item => item.text.trim()).join('\n\n');
          const { sha256, ...body } = pin.launch; pin.launch.sha256 = hash(stable(body)); pin.validated = true;
        },
        pin => { pin.native_sha256 = '0'.repeat(64); }, pin => { pin.session_id = 'foreign'; },
        pin => { pin.launch.binding.input_sha256 = hash('substitute'); },
        pin => { pin.launch.binding.command_digest = '0'.repeat(64); },
        pin => { pin.validated = true; delete pin.launch.sha256; },
      ]) {
        const stored = JSON.parse(originalRecord);
        const payload = stored.payload;
        mutate(payload.receipt.runtime_evidence.initial_context);
        fs.writeFileSync(recordPath, JSON.stringify(stored));
        const refused = coldProcess(f);
        assert.equal(refused.status, 0, refused.stderr);
        assert.equal(refused.stdout.trim(), 'false', 'caller edits cannot replace original recorder custody');
        const shippedRefusal = coldProcess(f, path.join(root, 'plugins/shipyard/host/plugins/delivery-pipeline/scripts'));
        assert.equal(shippedRefusal.status, 0, shippedRefusal.stderr);
        assert.equal(shippedRefusal.stdout.trim(), 'false');
        fs.writeFileSync(recordPath, originalRecord);
      }
      const native = fs.readFileSync(final.nativePath);
      fs.appendFileSync(final.nativePath, '\n');
      const changedNative = coldProcess(f);
      assert.equal(changedNative.status, 0, changedNative.stderr);
      assert.equal(changedNative.stdout.trim(), 'false');
      fs.writeFileSync(final.nativePath, native);
      assert.equal(coldProcess(f).stdout.trim(), 'true');
    }
  });
});

test('supported bounded initialized fixture preserves exact negative-query semantics', () => {
  const { rows, options } = orderedFixture();
  assert.deepEqual(runtime.extractSemanticInitialInput(rows, options), { input_index: 4, final_index: 7, turn_id: 'turn', initial_index: 3 });
  const reads = runtime.verifySemanticReads(serialize(rows), options);
  assert.deepEqual(reads.incomplete, []);
  assert.equal(reads.negative_queries[0].semantic_credit, false);
  assert.equal(reads.semantic_credit, false);
});

for (const [label, mutate] of Object.entries(mutations)) test('both shared consumers refuse ' + label, () => {
  const { rows, options } = orderedFixture(); mutate(rows);
  assert.throws(() => runtime.extractSemanticInitialInput(rows, options));
  assert.throws(() => runtime.verifySemanticReads(serialize(rows), options));
});

test('both shared consumers refuse conflicting optional turn workspace roots', () => {
  const { rows, options } = orderedFixture();
  rows.find(row => row.type === 'turn_context').payload.workspace_roots = ['/foreign'];
  assert.throws(() => runtime.extractSemanticInitialInput(rows, options), { code: 'RUNTIME_EVIDENCE_MISMATCH' });
  assert.throws(() => runtime.verifySemanticReads(serialize(rows), options), { code: 'RUNTIME_EVIDENCE_MISMATCH' });
});

for (const mutation of ['missing', 'instructions', 'source', 'environment', 'reference', 'alleged-validation']) test('data-only extraction refuses unsupported retained pin: ' + mutation, () => {
  const { rows, options } = orderedFixture();
  if (mutation === 'missing') delete options.initialContext;
  if (mutation === 'instructions') options.initialContext.instructions += 'forged';
  if (mutation === 'source') options.initialContext.sources[0].text += 'forged';
  if (mutation === 'environment') options.initialContext.environment.cwd = '/foreign';
  if (mutation === 'reference') options.initialContext.sha256 = '0'.repeat(64);
  if (mutation === 'alleged-validation') options.initialContext = { validated: true, instructions: options.initialContext.instructions };
  assert.throws(() => runtime.extractSemanticInitialInput(rows, options));
  assert.throws(() => runtime.verifySemanticReads(serialize(rows), options));
});

test('initialized incomplete original retains full report and cannot acquire completion credit', async () => {
  const h = fixtureHelpers();
  await h.publicIntegrationFixture(async f => {
    installInstructions(f);
    const prepared = h.semanticFixture(f, { native(rows) {
      rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0, initialization(f.worktree));
    }, result(result, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
      result.completeness = 'incomplete'; result.required_context = ['Actual source remains unread.'];
      result.unread = result.coverage;
      result.evidence_markdown += '\nINCOMPLETE: retained original with no semantic completion credit.';
    } });
    await assert.rejects(h.supportedPartitionCaller(f, 'codex', prepared.options), error => error.code === 'SEMANTIC_REVIEW_INCOMPLETE');
    const original = h.captureOriginals(f, prepared).find(item => item.result.completeness === 'incomplete');
    assert.ok(original);
    assert.equal(original.native.reads.semantic_credit, false);
    assert.deepEqual(original.result.required_context, ['Actual source remains unread.']);
    assert.match(original.original_text, /INCOMPLETE: retained original/);
    assert.equal(h.coldCurrent(f), null);
    const cold = coldProcess(f); assert.equal(cold.status, 0, cold.stderr); assert.equal(cold.stdout.trim(), 'false');
  });
});

test('physical global and project overrides pin exact selected bytes', async () => {
  const h = fixtureHelpers();
  await h.publicIntegrationFixture(async f => {
    installInstructions(f);
    const global = path.join(process.env.CODEX_HOME, 'AGENTS.override.md'), project = path.join(f.worktree, 'AGENTS.override.md');
    fs.writeFileSync(global, 'Actual global override.\n'); fs.writeFileSync(project, 'Actual project override.\n');
    const prepared = h.semanticFixture(f, { native(rows) {
      rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0,
        initialization(f.worktree, 'Actual global override.\n\nActual project override.'));
    } });
    await h.supportedPartitionCaller(f, 'codex', prepared.options);
    for (const original of h.captureOriginals(f, prepared)) {
      const pin = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id).receipt.runtime_evidence.initial_context.launch;
      assert.deepEqual(pin.sources.map(source => source.path), [fs.realpathSync(global), fs.realpathSync(project)]);
      for (const source of pin.sources) {
        assert.equal(source.sha256, hash(fs.readFileSync(source.path)));
        assert.equal(source.bytes, fs.statSync(source.path).size);
      }
    }
    assert.equal(h.coldCurrent(f)?.authenticated, true);
  });
});

test('shared data-only extractor requires exact input and all tools after it', () => {
  const original = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
  const frame = predicate => {
    const row = template(original, predicate);
    if (row.payload.turn_id !== undefined) row.payload.turn_id = 'turn';
    if (row.payload.internal_chat_message_metadata_passthrough?.turn_id !== undefined)
      row.payload.internal_chat_message_metadata_passthrough.turn_id = 'turn';
    return row;
  };
  const start = frame(row => row.payload?.type === 'task_started');
  const input = frame(row => row.payload?.role === 'user');
  const final = frame(row => row.payload?.phase === 'final_answer');
  const end = frame(row => row.payload?.type === 'task_complete');
  start.payload.turn_id = end.payload.turn_id = 'turn';
  input.payload.content = [{ type: 'input_text', text: 'exact' }];
  const rows = [start, input, final, end];
  assert.deepEqual(runtime.extractSemanticInitialInput(rows, { input: 'exact' }), { input_index: 1, final_index: 2, turn_id: 'turn', initial_index: null });
  assert.throws(() => runtime.extractSemanticInitialInput(rows, { input: 'changed' }));
  for (const type of ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output']) {
    const changed = structuredClone(rows);
    const tool = frame(row => row.payload?.type === (type.endsWith('_output') ? 'function_call_output' : 'function_call'));
    Object.assign(tool.payload, { type, call_id: 'early' });
    changed.splice(1, 0, tool);
    assert.throws(() => runtime.extractSemanticInitialInput(changed, { input: 'exact' }));
    assert.throws(() => runtime.verifySemanticReads(serialize(changed), { input: 'exact' }));
  }
});

test('the isolated builder exactly reproduces both mirrors and complete package identities', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z14-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const shipped = path.join(root, 'plugins/shipyard');
  function inventory(directory, prefix = '') {
    return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const relative = prefix + entry.name, file = path.join(directory, relative);
        const stat = fs.lstatSync(file);
        assert.equal(stat.isSymbolicLink(), false, relative);
        const row = { path: relative, mode: stat.mode & 0o777, directory: entry.isDirectory() };
        return entry.isDirectory() ? [row, ...inventory(directory, relative + '/')]
          : [{ ...row, sha256: hash(fs.readFileSync(file)) }];
      });
  }
  const before = inventory(shipped);
  const built = require('../../scripts/package-shipyard-codex.cjs').build(path.join(temporary, 'package'));
  assert.deepEqual(inventory(shipped), before, 'isolated builder cannot mutate the shipped package');
  const generated = inventory(built);
  const mirrors = ['codex-runtime-host.cjs', 'role-artifact.cjs'];
  const owned = new Set([...mirrors.map(file => 'host/plugins/delivery-pipeline/scripts/' + file),
    '.codex-plugin/plugin.json', 'package-build.json']);
  assert.deepEqual(generated.filter(row => !owned.has(row.path)), before.filter(row => !owned.has(row.path)),
    'no undeclared package file or mode may change');
  assert.deepEqual(generated, before);
  for (const file of mirrors) {
    const canonical = path.join(scripts, file), mirror = path.join(built, 'host/plugins/delivery-pipeline/scripts', file);
    assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonical));
    assert.equal(fs.statSync(mirror).mode & 0o777, fs.statSync(canonical).mode & 0o777);
  }
  for (const file of owned) {
    assert.deepEqual(fs.readFileSync(path.join(built, file)), fs.readFileSync(path.join(shipped, file)));
    assert.equal(fs.statSync(path.join(built, file)).mode & 0o777, fs.statSync(path.join(shipped, file)).mode & 0o777);
  }
  const manifestBytes = fs.readFileSync(path.join(built, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes), identity = JSON.parse(fs.readFileSync(path.join(built, 'package-build.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json')));
  const payloadHash = crypto.createHash('sha256');
  for (const row of generated.filter(row => !row.directory && !['.codex-plugin/plugin.json', 'package-build.json'].includes(row.path))) {
    payloadHash.update(row.path + '\0'); payloadHash.update(fs.readFileSync(path.join(built, row.path)));
  }
  const sourceDigest = payloadHash.digest('hex');
  assert.equal(manifest.version, `${source.version}+codex.${sourceDigest.slice(0, 16)}`);
  assert.equal(identity.version, manifest.version);
  assert.equal(identity.digest, crypto.createHash('sha256').update(sourceDigest).update('\0').update(manifestBytes).digest('hex'));
  const staged = require(path.join(built, 'host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs'));
  const { rows, options } = orderedFixture();
  assert.deepEqual(staged.extractSemanticInitialInput(rows, options), runtime.extractSemanticInitialInput(rows, options));
  assert.deepEqual(staged.verifySemanticReads(serialize(rows), options), runtime.verifySemanticReads(serialize(rows), options));
  for (const mutate of Object.values(mutations)) {
    const candidate = orderedFixture(); mutate(candidate.rows);
    assert.throws(() => staged.extractSemanticInitialInput(candidate.rows, candidate.options));
    assert.throws(() => staged.verifySemanticReads(serialize(candidate.rows), candidate.options));
  }
});
