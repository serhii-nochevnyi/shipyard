'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const cases = [];
const test = (title, run) => cases.push({ title, run });
const source = path.dirname(h.SCRIPTS);
const shipped = path.join(h.ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline');

const marker = '<AUTHENTICATED_SEMANTIC_REVIEW>\n';
const payloadFor = launch => JSON.parse((launch.input || launch.prompt).match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
function internals(plugin = source) {
  const file = path.join(plugin, 'scripts/role-artifact.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { ...module.exports, semanticLaunchPayload, semanticInlineAssignment, semanticRecord, semanticEnvelope, semanticKey, partitionNativePin };', file);
  return { ...h.internals(plugin), ...loaded.exports };
}
function rebound(launch, mutate) {
  const payload = payloadFor(launch); delete payload.binding_sha256;
  mutate(payload);
  payload.binding_sha256 = h.hash(h.stable(payload));
  const input = launch.input.slice(0, launch.input.indexOf(marker)) + marker + h.stable(payload)
    + '\n</AUTHENTICATED_SEMANTIC_REVIEW>';
  return { ...launch, input, input_sha256: h.hash(input), binding_sha256: payload.binding_sha256 };
}
function oldBody(snapshot, stage, assignment, view, inputs, transport) {
  return { schema: 'shipyard.semantic-review.v1', review_contract: 'shipyard.semantic-review.v1',
    role: snapshot.role, stage, runtime: snapshot.runtime, subject: snapshot.subject,
    snapshot_sha256: snapshot.snapshot_sha256, reviewed_identity: snapshot.identity,
    result_formats: ['full', 'snapshot-indexed.v1'], assignment: assignment ? Object.fromEntries(Object.entries(assignment)
      .filter(([key]) => !['required_material_source_ids', 'required_criteria_obligation_ids', 'required_seam_ids', 'required_context'].includes(key))) : null,
    ...view, ...inputs, ...(transport === 'host-files' ? { input_transport: 'host-files' } : {}),
    ...(snapshot.role === 'code-review' ? { code_review_context: Object.fromEntries(
      ['review_round', 'review_scope', 'prior_head', 'prior_findings', 'dispositions_digest']
        .map(key => [key, snapshot.code_review_packet.role_context[key]])) } : {}),
    ...(snapshot.role === 'arch-review' ? { architecture_context: {
      change_metadata: snapshot.architecture_packet.change_metadata,
      adr_selection: snapshot.architecture_packet.adr_selection,
      decision_cycles: snapshot.architecture_packet.decision_cycles || [],
      source_authority: snapshot.architecture_packet.source_authority,
      retained_evidence: snapshot.architecture_packet.retained_evidence || [] } } : {}) };
}
function launchAssertions(a, snapshot, launch, record, predecessor = false) {
  const payload = payloadFor(launch), { binding_sha256, ...body } = payload;
  const before = h.stable(snapshot), assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
  const view = a.semanticRequiredView(snapshot, assignment), unchanged = h.clone(view);
  const inputs = { material: payload.material, catalog: payload.catalog, originals: payload.originals };
  const prior = oldBody(snapshot, launch.stage, assignment, view, inputs, record.input_transport);
  const expected = h.clone(prior);
  if (snapshot.role === 'code-review' && launch.stage === 'worker' && !predecessor) delete expected.obligation_ids;
  if (snapshot.role === 'code-review' && launch.stage === 'final') delete expected.independent_final_seam_ids;
  assert.deepEqual(body, expected);
  assert.deepEqual(view.obligation_ids, view.obligations.map(item => item.id));
  assert.deepEqual(view, unchanged); assert.equal(h.stable(snapshot), before);
  assert.equal(binding_sha256, h.hash(h.stable(body))); assert.equal(launch.input_sha256, h.hash(launch.input));
  assert.deepEqual(body.reviewed_identity, snapshot.identity);
  assert.deepEqual(body.obligations, view.obligations); assert.deepEqual(body.seams, view.seams);
  assert.deepEqual(body.required_context, view.required_context);
  const allMaterial = snapshot.material.map(({ content, ...item }) => ({ ...item,
    read_path: path.join(path.dirname(body.catalog.read_path), item.source_id + '.txt'),
    bytes: Buffer.byteLength(content), sha256: h.hash(content) }));
  const catalogBytes = Buffer.from(h.stable({ responsibility_view_version: snapshot.responsibility_view_version,
    material: allMaterial, obligations: snapshot.obligations, seams: snapshot.seams }));
  assert.equal(body.catalog.bytes, catalogBytes.length); assert.equal(body.catalog.sha256, h.hash(catalogBytes));
  if (fs.existsSync(body.catalog.read_path)) {
    assert.deepEqual(fs.readFileSync(body.catalog.read_path), catalogBytes);
    for (const [index, material] of allMaterial.entries())
      assert.equal(fs.readFileSync(material.read_path, 'utf8'), snapshot.material[index].content);
  }
  assert.deepEqual(body.material.map(({ read_path, ...item }) => item), view.material.map(({ content, ...item }) => item));
  if (assignment) {
    assert.deepEqual(body.assignment.primary_obligation_ids, assignment.primary_obligation_ids);
    assert.deepEqual(body.assignment.support_obligation_ids, assignment.support_obligation_ids);
    assert.deepEqual(body.assignment.support_reasons, assignment.support_reasons);
  }
  a.assertSemanticLaunchView(launch, record, inputs);
  const bounds = a.semanticPreflight(snapshot, launch);
  assert.ok(bounds.input_bytes <= 1048576); assert.equal(bounds.input_limit_bytes, 1048576);
  assert.equal(bounds.result_limit_bytes, 131072); assert.ok(launch.prefix_bytes > 0);
  assert.equal(bounds.schema_bytes > 0, snapshot.runtime === 'claude');
  const projected = a.semanticLaunchPayload(snapshot, launch.stage, assignment, view, inputs, record.input_transport);
  if (launch.stage === 'worker') {
    assert.equal(Object.hasOwn(projected, 'obligation_ids'), false);
    const delta = Buffer.byteLength(h.stable(prior)) - Buffer.byteLength(h.stable(projected));
    assert.equal(delta, Buffer.byteLength('"obligation_ids":' + h.stable(view.obligations.map(item => item.id)) + ','));
    const restored = { ...projected, obligation_ids: view.obligations.map(item => item.id) };
    assert.deepEqual(restored, prior); assert.ok(delta > 0);
  } else {
    const { independent_final_seam_ids, ...expected } = prior;
    assert.deepEqual(projected, snapshot.role === 'code-review' ? expected : prior);
  }
}
function strictBatch(a, snapshot, launch, record) {
  const payload = payloadFor(launch), inputs = { material: payload.material, catalog: payload.catalog, originals: [] };
  const changes = {
    'added old vector': p => { p.obligation_ids = p.obligations.map(item => item.id); },
    'reordered vector': p => { p.obligation_ids = p.obligations.map(item => item.id).reverse(); },
    'duplicate vector': p => { p.obligation_ids = [p.obligations[0].id, p.obligations[0].id]; },
    'foreign vector': p => { p.obligation_ids = ['o-foreign']; },
    'empty vector': p => { p.obligation_ids = []; },
    'missing obligation': p => { p.obligations.pop(); },
    'reordered obligations': p => { p.obligations.reverse(); },
    'changed assignment': p => { p.assignment.primary_obligation_ids.reverse(); },
    'changed support': p => { p.assignment.support_obligation_ids.push('o-foreign'); },
    'changed reasons': p => { p.assignment.support_reasons = {}; },
    'changed material': p => { p.material[0].sha256 = '0'.repeat(64); },
    'changed aliases': p => { p.material[0].aliases[0].path = 'foreign.cjs'; },
    'changed seam': p => { p.seams[0].reason += 'foreign'; },
    'changed context': p => { p.required_context.push({ reason: 'foreign' }); },
    'changed identity': p => { p.reviewed_identity.head = '0'.repeat(40); },
    'mixed historical assignment': p => { p.assignment = snapshot.assignments.find(item => item.id === launch.assignment_id); },
    'missing formats mixed with current vector omission': p => { delete p.result_formats; },
    'old no-format inline body without its recorded envelope': p => {
      p.obligation_ids = p.obligations.map(item => item.id); delete p.result_formats;
    },
    'old no-format full assignment without its recorded envelope': p => {
      p.obligation_ids = p.obligations.map(item => item.id); delete p.result_formats;
      p.assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
    },
    'mixed full assignment with current-era result formats': p => {
      p.obligation_ids = p.obligations.map(item => item.id);
      p.assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
    },
    'foreign field': p => { p.extra = true; },
  };
  for (const [label, mutate] of Object.entries(changes)) {
    const bad = rebound(launch, mutate);
    assert.equal(h.hash(bad.input), bad.input_sha256, label);
    assert.throws(() => a.assertSemanticLaunchView(bad, record, inputs), undefined, label);
  }
  for (const key of ['input_sha256', 'binding_sha256', 'responsibility_view_version'])
    assert.throws(() => a.assertSemanticLaunchView({ ...launch, [key]: 'foreign' }, record, inputs), undefined, key);
}
async function predecessorProducer(run) {
  const originalLoad = Module._load; let patched = false;
  Module._load = function(request, parent, ...args) {
    let file;
    try { file = Module._resolveFilename(request, parent); } catch {}
    if (!patched && typeof file === 'string' && file.endsWith('/scripts/role-artifact.cjs')
        && path.dirname(path.dirname(file)).startsWith(path.join(process.env.HOME, 'producer-'))) {
      const original = fs.readFileSync(file, 'utf8');
      const needle = "const emittedView = snapshot.role === 'code-review' && stage === 'worker' ? workerView : view;";
      assert.equal(original.split(needle).length, 2);
      const replacement = "const emittedView = snapshot.role === 'code-review' && stage === 'worker' && assignment.id !== 'code-correctness' ? workerView : view;";
      fs.writeFileSync(h.physical(process.env.HOME, file), original.replace(needle, replacement));
      patched = true;
    }
    return originalLoad.call(this, request, parent, ...args);
  };
  try { await run(); assert.equal(patched, true); } finally { Module._load = originalLoad; }
}

function independentPackage(f) {
  const setup = h.setup('phase53-z24-historical-producer-reference.test.cjs', '\nif (isMainThread) {',
    'squashCandidate, absentHistory, fixtureIdentity');
  const directory = h.physical(f.root, path.join(f.root, 'complete-candidate')); fs.mkdirSync(directory);
  const checkout = setup.squashCandidate(directory, process.env);
  setup.absentHistory(checkout, process.env); setup.fixtureIdentity(checkout);
  for (const relative of ['plugins/delivery-pipeline/scripts/role-artifact.cjs',
    'tests/unit/phase53-z27-semantic-worker-input-redundancy.test.cjs'])
    assert.deepEqual(fs.readFileSync(path.join(checkout, relative)), fs.readFileSync(path.join(h.ROOT, relative)));
  const before = h.inventory(path.join(h.ROOT, 'plugins/shipyard'));
  const candidate = require(path.join(checkout, 'scripts/package-shipyard-codex.cjs')).build(
    h.physical(f.root, path.join(f.root, 'independent-package')));
  const identity = h.packageParity(candidate);
  for (const row of h.inventory(candidate).filter(item => !item.directory))
    assert.deepEqual(fs.readFileSync(path.join(candidate, row.path)), fs.readFileSync(path.join(h.ROOT, 'plugins/shipyard', row.path)), row.path);
  assert.deepEqual(h.inventory(path.join(h.ROOT, 'plugins/shipyard')), before);
  assert.equal(identity.digest.length, 64);
  return candidate;
}
function withBytes(file, replacement, run) {
  const before = fs.readFileSync(file), mode = fs.statSync(file).mode & 0o777;
  try {
    if (replacement === null) fs.unlinkSync(file); else fs.writeFileSync(file, replacement);
    run();
  } finally { fs.writeFileSync(file, before, { mode }); fs.chmodSync(file, mode); }
  assert.deepEqual(fs.readFileSync(file), before);
}
function custodyBatch({ f, api, a, record, snapshot, prepared, originals, current, consumers }) {
  const authorityDirectory = api.archiveAuthorityDirectory(f.worktree);
  const before = h.inventory(authorityDirectory), archive = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
  const original = originals[0], key = a.semanticKey(snapshot.snapshot_sha256, 'worker', original.reference.assignment_id);
  const envelopes = fs.readdirSync(authorityDirectory).filter(name => name.endsWith('.json')).map(name => {
    const file = h.physical(f.root, path.join(authorityDirectory, name));
    return { file, bytes: fs.readFileSync(file), value: JSON.parse(fs.readFileSync(file)) };
  });
  const launchEnvelope = envelopes.find(item => item.file.includes('semantic-launch-') && item.file.includes(key));
  const snapshotEnvelope = envelopes.find(item => item.file.includes('semantic-snapshot-') && item.file.includes(snapshot.snapshot_sha256));
  assert.ok(launchEnvelope); assert.ok(snapshotEnvelope);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.worktree, original.reference.artifact_ref)));
  const records = fs.readdirSync(prepared.recorder.storeDir).filter(name => /^record-.*\.json$/.test(name)).map(name => {
    const file = h.physical(f.root, path.join(prepared.recorder.storeDir, name));
    return { file, value: JSON.parse(fs.readFileSync(file)) };
  });
  const receipt = records.find(item => item.value.payload.dispatch_id === original.reference.dispatch_id); assert.ok(receipt);
  const badReceipt = h.clone(receipt.value); badReceipt.payload.receipt.observed_model = 'foreign-model';
  const changes = [
    ['original wire INFO', path.join(f.worktree, manifest.files.findings.path), bytes => bytes.toString().replace('INFO-', 'FAKE-')],
    ['original evidence', path.join(f.worktree, manifest.files.evidence.path), bytes => Buffer.concat([bytes, Buffer.from('changed')])],
    ['native transcript', original.native.native_pin.path, bytes => Buffer.concat([bytes, Buffer.from('\n')]), true],
    ['original terminal', original.native.output_pin.path, bytes => Buffer.concat([bytes, Buffer.from('\n')])],
    ['original receipt/session', receipt.file, () => JSON.stringify(badReceipt)],
    ['absent recorded launch', launchEnvelope.file, () => null, true],
    ['changed original binding', launchEnvelope.file, bytes => {
      const value = JSON.parse(bytes); value.payload.binding_sha256 = '0'.repeat(64); return JSON.stringify(value);
    }],
    ['changed original input pin', launchEnvelope.file, bytes => {
      const value = JSON.parse(bytes); value.payload.input_sha256 = '0'.repeat(64); return JSON.stringify(value);
    }],
    ['changed snapshot head', snapshotEnvelope.file, bytes => {
      const value = JSON.parse(bytes); value.payload.snapshot.identity.head = '0'.repeat(40); return JSON.stringify(value);
    }],
    ['changed snapshot base', snapshotEnvelope.file, bytes => {
      const value = JSON.parse(bytes); value.payload.snapshot.identity.base = '0'.repeat(40); return JSON.stringify(value);
    }],
    ['changed criteria', snapshotEnvelope.file, bytes => {
      const value = JSON.parse(bytes); value.payload.snapshot.criteria += 'changed'; return JSON.stringify(value);
    }],
  ];
  const final = payloadFor(prepared.launches.at(-1));
  const expanded = final.originals.find(item => item.expanded_view)?.expanded_view;
  if (expanded) changes.push(['expanded semantic view', expanded.read_path,
    bytes => bytes.toString().replace('INFO-', 'FAKE-'), true]);
  const pin = snapshot.pins.find(item => item.sha256 === snapshot.agent_sha256); assert.ok(pin);
  changes.push(['original instruction source', path.resolve(pin.root, pin.path), bytes => Buffer.concat([bytes, Buffer.from('changed')])]);
  for (const [label, file, replacement, cold] of changes) {
    const bytes = fs.readFileSync(h.physical(process.env.HOME, file));
    withBytes(file, replacement(bytes), () => {
      if (label !== 'expanded semantic view') assert.throws(() => a.readSemanticOriginal({ worktreePath: f.worktree,
        snapshot_sha256: snapshot.snapshot_sha256, assignment_id: original.reference.assignment_id }), undefined, label);
      assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null, label);
      if (cold) {
        const child = spawnSync(process.execPath, ['-e', `
          const assert = require('node:assert/strict');
          require('node:os').homedir = () => process.argv[1];
          const owners = JSON.parse(process.argv[2]), input = JSON.parse(process.argv[3]), original = JSON.parse(process.argv[4]);
          for (const owner of owners) {
            const api = require(require('node:path').join(owner, 'scripts/role-artifact.cjs'));
            assert.equal(api.currentCodeReviewVerdict(input), null);
            if (process.argv[5] !== 'expanded semantic view') assert.throws(() => api.readSemanticOriginal({
              worktreePath: input.worktreePath, snapshot_sha256: original.result.snapshot_sha256,
              assignment_id: original.reference.assignment_id }));
          }
          process.stdout.write('authenticated boundaries refused');
        `, os.homedir(), JSON.stringify(consumers), JSON.stringify(h.inputFor(f)), JSON.stringify(original), label],
        { env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout, 'authenticated boundaries refused');
      }
    });
    assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current, label + ' restored');
  }
  const finalLaunch = a.semanticEnvelope(f.worktree, 'launch', a.semanticKey(snapshot.snapshot_sha256, 'final', null));
  const finalTrusted = prepared.recorder.getVerifiedRecord(finalLaunch.dispatch_id);
  const finalPin = a.partitionNativePin(finalTrusted);
  assert.equal(finalPin.sha256, h.hash(fs.readFileSync(finalPin.path)));
  const finalBytes = fs.readFileSync(finalPin.path), finalRows = finalBytes.toString().trim().split('\n').map(JSON.parse);
  if (snapshot.runtime === 'codex') finalRows.find(row => row.type === 'session_meta').payload.id = originals[0].native.session_id;
  else finalRows.find(row => row.type === 'assistant').sessionId = originals[0].native.session_id;
  withBytes(finalPin.path, finalRows.map(row => JSON.stringify(row)).join('\n') + '\n', () => {
    for (const owner of consumers) assert.equal(h.cold(f, 'code-review', owner), null);
  });
  const staged = consumers.at(-1), stagedFile = path.join(staged, 'scripts/role-artifact.cjs');
  withBytes(stagedFile, fs.readFileSync(stagedFile, 'utf8').replace('...emittedView, ...inputs', '...view, ...inputs'), () => {
    assert.equal(h.cold(f, 'code-review', staged), null);
    assert.throws(() => h.packageParity(path.resolve(staged, '../../..')));
  });
  const packageRoot = path.resolve(staged, '../../..');
  const manifestFile = path.join(packageRoot, '.codex-plugin/plugin.json');
  withBytes(manifestFile, fs.readFileSync(manifestFile, 'utf8').replace('codex.', 'codex.changed'), () => {
    assert.throws(() => h.packageParity(packageRoot));
  });
  const mode = fs.statSync(stagedFile).mode & 0o777;
  try { fs.chmodSync(stagedFile, mode ^ 0o100); assert.throws(() => h.packageParity(packageRoot)); }
  finally { fs.chmodSync(stagedFile, mode); }
  for (const owner of consumers) {
    assert.deepEqual(h.cold(f, 'code-review', owner), current);
    assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
  }
  assert.deepEqual(h.inventory(authorityDirectory), before);
  assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), archive);
  assert.deepEqual(a.semanticEnvelope(f.worktree, 'launch', key), JSON.parse(launchEnvelope.bytes).payload);
  assert.deepEqual(a.semanticRecord(f.worktree, snapshot.snapshot_sha256), record);
}
function prospective27(runtime, observedSnapshot, originals) {
  const a = internals(), owners = ['plugins/delivery-pipeline/scripts/role-artifact.cjs',
    'plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs', 'plugins/shipyard/.codex-plugin/plugin.json',
    'plugins/shipyard/package-build.json', 'tests/unit/phase53-z27-semantic-worker-input-redundancy.test.cjs'];
  const tickets = Array.from({ length: 27 }, (_, index) => ({ id: 'T-53-' + String(index + 1).padStart(2, '0'),
    files: index === 26 ? owners : ['src/producer-' + index + '.cjs', 'src/consumer-' + index + '.cjs'],
    depends_on: index ? ['T-53-' + String(index).padStart(2, '0')] : [],
    plan: '.planning/phases/53/53-' + String(index + 1).padStart(2, '0') + '-PLAN.md' }));
  const material = [], obligations = [];
  const add = (file, content, pointer, value) => {
    const source_id = 's-' + h.hash(content), sha256 = h.hash(content);
    let entry = material.find(item => item.source_id === source_id);
    if (!entry) { entry = { source_id, sha256, content, bytes: Buffer.byteLength(content), aliases: [] }; material.push(entry); }
    entry.aliases.push({ path: file, pointer });
    obligations.push({ id: 'o-' + h.hash(file + pointer), source_id, sha256, path: file, pointer, governing: false, value });
  };
  const bookkeeping = tickets.map((ticket, index) => {
    const plan = h.stable({ phase: 53, plan: index + 1, title: 'Controlled complete prospective member ' + ticket.id,
      files_modified: ticket.files, depends_on: ticket.depends_on, requirements: ['F53-02', 'F53-03', 'F53-09'],
      tasks: [{ name: 'Preserve complete producer contract', files: ticket.files, done: 'Consumer receives the exact original value' },
        { name: 'Verify complete acceptance and retained failures', files: ticket.files, done: 'All observations remain independently readable' }],
      delivery: { ticket: ticket.id, risk: 'high', human_checkpoint: 'review' } });
    add(ticket.plan, plan, '/governing/plan', 'All assigned product contracts and independent verification remain required.');
    for (const file of ticket.files) add(file, index === 26 ? fs.readFileSync(path.join(h.ROOT, file), 'utf8')
      : file.includes('consumer') ? "const { value } = require('./producer-" + index + ".cjs'); exports.value = value;\n"
      : 'exports.value = ' + index + ';\n', file.includes('consumer') ? '/consumer/acceptance/' : '/source',
    'Retain exact bytes and consumer failure behavior for ' + file);
    return { path: ticket.plan, sha256: h.hash(plan), cleared_sha256: h.hash('cleared-' + plan), context: plan,
      review: { state: 'fixture-carried-review', observations: ['INFO remains readable', 'Prior resource refusal is retained'],
        prior_head: observedSnapshot.identity.head, unresolved: [], limitations: ['Controlled fixture supplies no real phase verdict'] },
      followup: { ticket: ticket.id, depends_on: ticket.depends_on, source_files: ticket.files,
        source_digest: h.hash(h.stable(material.filter(item => item.aliases.some(alias => ticket.files.includes(alias.path))))) } };
  });
  const identity = { ...h.clone(observedSnapshot.identity), phase: '53', ticket_set: tickets.map(ticket => ({
    id: ticket.id, pr: 500 + Number(ticket.id.slice(-2)), head: h.hash(ticket.id).slice(0, 40), base: 'main', branch: 'ticket/' + ticket.id })),
    ticket_set_digest: h.hash(h.stable(tickets)), bookkeeping,
    prospective_fixture: { plan_sha256: '98b80a6a8e8450f7f5f86e41e74de80ea64a0138c2facaa19e5fa9224ad750a4',
      owners: owners.map(file => ({ path: file, bytes: fs.statSync(path.join(h.ROOT, file)).size,
        sha256: h.hash(fs.readFileSync(path.join(h.ROOT, file))) })), package: JSON.parse(fs.readFileSync(path.join(h.ROOT, 'plugins/shipyard/package-build.json'))),
      native_phase_acceptance: false } };
  const inventory = { material, obligations };
  const snapshot = { ...h.clone(observedSnapshot), ...inventory, identity,
    ...a.semanticResponsibilities(inventory, tickets.map(row => ({ id: row.id, row })), 'code-review') };
  delete snapshot.snapshot_sha256; snapshot.snapshot_sha256 = h.hash(h.stable(snapshot)); a.assertSemanticSnapshot(snapshot);
  assert.equal(snapshot.identity.ticket_set.length, 27); assert.equal(snapshot.identity.bookkeeping.length, 27);
  const fixture = h.sizingRecord(snapshot), observations = [];
  try {
    for (const assignment of fixture.record.snapshot.assignments) {
      const launch = a.semanticBuildLaunch(fixture.record, 'worker', assignment.id, [], true);
      launchAssertions(a, fixture.record.snapshot, launch, fixture.record);
      const details = a.semanticPreflight(fixture.record.snapshot, launch);
      assert.ok(details.input_bytes <= 1048576); assert.ok(launch.prefix_bytes > 0);
      assert.equal(details.schema_bytes > 0, runtime === 'claude'); observations.push(details);
    }
    const originalsBefore = h.stable(originals);
    const full = a.semanticBuildLaunch(fixture.record, 'final', null, originals, true);
    const final = payloadFor(full), details = a.semanticPreflight(fixture.record.snapshot, full);
    assert.equal(final.originals.length, 2); assert.equal(details.original_count, 2);
    assert.ok(final.originals.every(item => item.native.native_pin.sha256 && item.bytes > 0));
    for (const [index, original] of originals.entries()) {
      const descriptor = final.originals[index];
      assert.equal(descriptor.bytes, Buffer.byteLength(original.original_text));
      assert.equal(descriptor.sha256, h.hash(original.original_text));
      assert.deepEqual(descriptor.reference, original.reference); assert.deepEqual(descriptor.native, original.native);
      if (descriptor.expanded_view) {
        assert.equal(descriptor.expanded_view.bytes, Buffer.byteLength(h.stable(original.result)));
        assert.equal(descriptor.expanded_view.sha256, h.hash(h.stable(original.result)));
      }
      a.semanticWireBound({ result: JSON.parse(original.original_text), text: original.original_text });
    }
    assert.equal(h.stable(originals), originalsBefore);
    assert.ok(details.input_bytes <= 1048576); observations.push(details);
    const excessiveSnapshot = h.clone(fixture.record.snapshot);
    excessiveSnapshot.identity.bookkeeping[0].context += 'x'.repeat(1048576);
    delete excessiveSnapshot.snapshot_sha256;
    excessiveSnapshot.snapshot_sha256 = h.hash(h.stable(excessiveSnapshot)); a.assertSemanticSnapshot(excessiveSnapshot);
    const excessiveRecord = { ...fixture.record, snapshot: excessiveSnapshot };
    for (const assignment of [...excessiveSnapshot.assignments, null]) assert.throws(() =>
      a.semanticBuildLaunch(excessiveRecord, assignment ? 'worker' : 'final', assignment?.id || null,
        assignment ? [] : originals, true), error => error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND'
          && error.details.input_limit_bytes === 1048576 && error.details.input_bytes > 1048576);
    const wire = JSON.parse(originals[0].original_text);
    assert.throws(() => a.semanticWireBound({ result: { ...wire, evidence_markdown: 'x'.repeat(131072) }, text: originals[0].original_text }),
      error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND' && error.details.limit_bytes === 131072);
    assert.throws(() => a.semanticWireBound({ result: wire, text: originals[0].original_text + ' '.repeat(131072) }),
      error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND' && error.details.terminal_bytes > 131072);
    process.stdout.write(JSON.stringify({ runtime, prospective27_fixture_preflight: observations,
      originals: 'complete unchanged recorded reports from runtime flow; sizing grants no cross-snapshot semantic authority',
      actual27_original_backed_native_preparation: 'owed after merge' }) + '\n');
  } finally { fixture.close(); }
}

for (const runtime of ['codex', 'claude']) test(runtime + ' recorded public workers full final exact history and cold custody', async () => {
  const predecessor = runtime === 'claude', catalogs = new Map(), snapshotsBefore = new Map(), snapshotFiles = new Map();
  let fixture, originalArchive;
  const run = () => h.publicRole('code-review', runtime, {
    full: predecessor, incomplete: predecessor,
    configureFixture(f) {
      fixture = f;
      fs.writeFileSync(h.physical(f.root, path.join(f.worktree, 'src/shared-contract.cjs')), 'exports.value = 1;\n');
      fs.writeFileSync(h.physical(f.root, path.join(f.worktree, 'src/provider.cjs')),
        "const shared = require('./shared-contract.cjs'); exports.value = shared.value;\n");
      h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'commit').commit(f, 'fixture shared producer and consumer contracts');
    },
    onLaunch(launch) {
      const p = launch.payload;
      const authority = require(path.join(source, 'scripts/role-artifact.cjs')).archiveAuthorityDirectory(fixture.worktree);
      for (const name of fs.readdirSync(authority).filter(name => name.startsWith('integration-semantic-snapshot-'))) {
        const file = path.join(authority, name), bytes = fs.readFileSync(file);
        if (snapshotFiles.has(file)) assert.deepEqual(bytes, snapshotFiles.get(file)); else snapshotFiles.set(file, bytes);
      }
      if (p.stage === 'final') originalArchive = h.inventory(path.join(fixture.worktree, '.shipyard-role-artifacts'));
      if (p.stage === 'worker') assert.equal(Object.hasOwn(p, 'obligation_ids'), predecessor && p.assignment.id === 'code-correctness');
      const bytes = fs.readFileSync(p.catalog.read_path);
      if (catalogs.has(p.catalog.read_path)) assert.deepEqual(bytes, catalogs.get(p.catalog.read_path));
      else catalogs.set(p.catalog.read_path, bytes);
    },
    result(result) {
      if (predecessor && result.assignment_id === 'code-correctness') result.completeness = 'blocked';
    },
    async inspect({ f, api, plugin, prepared, originals, snapshots, completed, expected, nativeViews }) {
      const a = internals(), snapshot = [...snapshots.values()][0];
      const record = a.semanticRecord(f.worktree, snapshot.snapshot_sha256);
      snapshotsBefore.set(snapshot.snapshot_sha256, h.stable(snapshot));
      assert.equal(originals.length, 2); assert.equal(prepared.launches.length, 3); assert.equal(nativeViews.size, 3);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      assert.notEqual(originals[0].native.session_id, originals[1].native.session_id);
      assert.equal(completed.result.verdict, predecessor ? 'incomplete' : 'pass');
      for (const observed of prepared.launches) {
        const key = observed.payload.assignment?.id || null;
        const launch = a.semanticEnvelope(f.worktree, 'launch', a.semanticKey(snapshot.snapshot_sha256, observed.payload.stage, key));
        assert.equal(launch.input, observed.input || observed.prompt);
        launchAssertions(a, snapshot, launch, record, predecessor && key === 'code-correctness');
        if (runtime === 'claude') assert.deepEqual(observed.schema,
          require(path.join(source, 'scripts/claude-role-host.cjs')).semanticStageSchema(launch));
        if (key === 'code-acceptance') strictBatch(a, snapshot, launch, record);
        if (predecessor && key === 'code-correctness') {
          const inputs = { material: payloadFor(launch).material, catalog: payloadFor(launch).catalog, originals: [] };
          for (const changed of [{ ...launch, dispatch_id: 'unrecorded' },
            { ...launch, input: 'foreign prefix\n' + launch.input, input_sha256: h.hash('foreign prefix\n' + launch.input) }])
            assert.throws(() => a.assertSemanticLaunchView(changed, record, inputs), /exact recorded original launch/);
          assert.deepEqual(payloadFor(launch).obligation_ids, payloadFor(launch).obligations.map(item => item.id));
        }
      }
      for (const [index, original] of originals.entries()) {
        const observed = prepared.launches[index];
        assert.equal(original.original_text, observed.text || observed.originalText);
        assert.deepEqual(original.result, expected.get(original.reference.assignment_id));
        assert.equal(original.result.findings[0].severity, 'INFO');
        assert.ok(original.result.conclusions.length >= 2); assert.ok(original.result.seams.every(row => row.rationale.length > 10));
        assert.deepEqual(original.result.coverage, snapshot.assignments[index].primary_obligation_ids);
        assert.equal(original.native.resource_failure, null);
        assert.ok(original.native.reads.completed.length > 0);
        const wire = JSON.parse(original.original_text);
        assert.equal(wire.result_format, predecessor ? undefined : 'snapshot-indexed.v1');
        const launch = a.semanticEnvelope(f.worktree, 'launch', a.semanticKey(snapshot.snapshot_sha256, 'worker', original.reference.assignment_id));
        assert.deepEqual(a.decodeSemanticResult(wire, launch, snapshot), original.result);
        a.semanticWireBound({ result: wire, text: original.original_text });
        if (wire.result_format === 'snapshot-indexed.v1') {
          assert.ok(wire.seam_rows.length > 1);
          const corruptions = {
            reorderedCoverage: value => { value.coverage_indices.reverse(); },
            duplicateCoverage: value => { value.coverage_indices.push(value.coverage_indices[0]); },
            foreignCoverage: value => { value.coverage_indices[0] = snapshot.obligations.length; },
            reorderedSeams: value => { value.seam_rows.reverse(); },
            missingSeam: value => { value.seam_rows.pop(); },
            missingLimitations: value => { delete value.limitations; },
            mixedFullIdentity: value => { value.reviewed_identity = snapshot.identity; },
          };
          for (const [label, mutate] of Object.entries(corruptions)) {
            const changed = h.clone(wire); mutate(changed);
            assert.throws(() => a.decodeSemanticResult(changed, launch, snapshot), undefined, label);
          }
        }
        if (predecessor) {
          assert.equal(original.result.limitations.length, 1); assert.ok(original.result.unread.length);
          assert.ok(original.result.seams.every(row => row.disposition === 'unresolved'));
          assert.equal(original.result.completeness, index === 0 ? 'blocked' : 'incomplete');
        } else assert.deepEqual(original.result.limitations, []);
      }
      const final = payloadFor(prepared.launches.at(-1));
      assert.equal(final.stage, 'final'); assert.equal(final.originals.length, 2);
      assert.deepEqual(final.obligation_ids, snapshot.obligations.map(item => item.id));
      for (const [index, descriptor] of final.originals.entries()) {
        assert.equal(fs.readFileSync(descriptor.read_path, 'utf8'), originals[index].original_text);
        if (descriptor.expanded_view) assert.deepEqual(JSON.parse(fs.readFileSync(descriptor.expanded_view.read_path)), originals[index].result);
      }
      const observedFinal = prepared.launches.at(-1);
      a.semanticWireBound({ result: observedFinal.result, text: observedFinal.text || observedFinal.originalText });
      const finalReport = expected.get('final');
      assert.equal(finalReport.findings[0].severity, 'INFO');
      assert.deepEqual(completed.result.limitations, finalReport.limitations);
      assert.deepEqual(completed.result.unread, finalReport.unread);
      assert.deepEqual(completed.result.required_context, finalReport.required_context);
      const core = require(path.join(source, 'scripts/code-review-core.cjs'));
      const options = { packet: snapshot.code_review_packet, identity: snapshot.identity,
        readSource: file => fs.readFileSync(path.join(f.worktree, file), 'utf8') };
      for (const mutate of [value => { value.completeness = 'incomplete'; }, value => { value.completeness = 'blocked'; },
        value => { value.unread = value.coverage.slice(-1); }, value => { value.required_context = ['Unresolved native consumer context']; },
        value => { value.limitations = ['Retained native uncertainty']; }]) {
        const report = h.clone(finalReport); mutate(report);
        const judgment = core.projectSemanticResult(report, options);
        assert.equal(judgment.verdict, 'incomplete');
        assert.equal(judgment.info_dropped, 1); assert.deepEqual(judgment.limitations, report.limitations);
      }
      const current = api.currentCodeReviewVerdict(h.inputFor(f));
      assert.equal(current.authenticated, true); assert.equal(current.verdict, predecessor ? 'incomplete' : 'pass');
      const candidate = independentPackage(f);
      const staged = path.join(candidate, 'host/plugins/delivery-pipeline'), consumers = [source, shipped, staged];
      for (const owner of consumers) {
        assert.deepEqual(h.cold(f, 'code-review', owner), current);
        assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
      }
      custodyBatch({ f, api, a, record, snapshot, prepared, originals, current, consumers });
      prospective27(runtime, snapshot, originals);
      for (const [file, bytes] of catalogs) assert.deepEqual(fs.readFileSync(file), bytes);
      assert.ok(snapshotFiles.size > 0);
      for (const [file, bytes] of snapshotFiles) assert.deepEqual(fs.readFileSync(file), bytes);
      const afterArchive = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
      for (const row of originalArchive) assert.deepEqual(afterArchive.find(item => item.path === row.path), row);
      assert.equal(h.stable(snapshot), snapshotsBefore.get(snapshot.snapshot_sha256));
      const launches = prepared.launches.length;
      assert.deepEqual((await prepared.run()).result, completed.result);
      assert.equal(prepared.launches.length, launches);
      process.stdout.write(JSON.stringify({ runtime, recorded_workers: 2, independent_final: 1,
        recorded_predecessor: predecessor, verdict: current.verdict, native_phase_acceptance: false,
        actual27_native_fit: 'owed after merge', original_f506_refusal: 'not superseded by fixtures', R8: 'INCOMPLETE', semantic_credit: 0 }) + '\n');
    },
  });
  if (predecessor) await predecessorProducer(run); else await run();
});

test('all other role and stage bodies remain exact and static predecessor contracts keep their original shapes', () => {
  const a = internals();
  const helperFile = path.join(h.ROOT, 'tests/fixtures/phase53/semantic-result-helpers.cjs');
  const helper = new Module(helperFile, module); helper.filename = helperFile;
  helper.paths = Module._nodeModulePaths(path.dirname(helperFile));
  helper._compile(fs.readFileSync(helperFile, 'utf8') + '\nmodule.exports = { historicalSources };', helperFile);
  const [[name, bytes]] = helper.exports.historicalSources(['role-artifact.cjs']);
  assert.equal(name, 'role-artifact.cjs');
  const filename = path.join(source, 'scripts/role-artifact.cjs'), historical = new Module(filename, module);
  historical.filename = filename; historical.paths = Module._nodeModulePaths(path.dirname(filename));
  historical._compile(bytes.toString() + '\nmodule.exports = { semanticLaunchPayload };', filename);
  let overlap = false;
  for (const runtime of ['codex', 'claude']) for (const role of ['code-review', 'integrator', 'arch-review']) {
    const snapshot = h.currentSized(role, runtime), before = h.stable(snapshot);
    for (const assignment of [...snapshot.assignments, null]) {
      const stage = assignment ? 'worker' : 'final', view = a.semanticRequiredView(snapshot, assignment);
      const inputs = { material: view.material, catalog: { read_path: '/fixture/catalog', sha256: h.hash('catalog'), bytes: 7 }, originals: [] };
      const previous = oldBody(snapshot, stage, assignment, view, inputs, 'host-files');
      const current = a.semanticLaunchPayload(snapshot, stage, assignment, view, inputs, 'host-files');
      if (role === 'code-review' && stage === 'worker') {
        const { obligation_ids, ...expected } = previous;
        assert.deepEqual(current, expected); assert.deepEqual(obligation_ids, current.obligations.map(item => item.id));
      } else if (role === 'code-review' && stage === 'final') {
        const { independent_final_seam_ids, ...expected } = previous;
        assert.equal(h.stable(current), h.stable(expected));
      } else assert.equal(h.stable(current), h.stable(previous));
      const old = historical.exports.semanticLaunchPayload(snapshot, stage, assignment, view, inputs, 'host-files');
      const { result_formats, ...withoutFormats } = previous;
      assert.deepEqual(old, withoutFormats);
      assert.deepEqual(old.obligation_ids, view.obligations.map(item => item.id));
      assert.deepEqual(old.assignment, previous.assignment);
      if (assignment) {
        const primary = new Set(assignment.primary_obligation_ids);
        const shared = assignment.support_obligation_ids.filter(id => primary.has(id));
        if (shared.length) {
          overlap = true;
          assert.ok(shared.every(id => Object.hasOwn(current.assignment.support_reasons, id)));
          assert.notDeepEqual(current.assignment.support_obligation_ids,
            view.obligations.map(item => item.id).filter(id => !primary.has(id)));
        }
      }
    }
    assert.equal(h.stable(snapshot), before);
  }
  const inventory = { material: [], obligations: [{ id: 'criterion', governing: true, path: 'criteria', pointer: '/', value: 'Global governing criterion' }] };
  const responsibilities = a.semanticResponsibilities(inventory, [], 'code-review');
  overlap ||= responsibilities.assignments.some(item => item.primary_obligation_ids.some(id => item.support_obligation_ids.includes(id)));
  assert.equal(overlap, true);
});

test('frozen physical prefixes singleton generation actual denominators and all old test bytes remain exact', () => {
  const shard = require('./shard-files.cjs'), manifest = shard.readManifest(), files = shard.unitFiles();
  const tasks = shard.unitTasks(files), actual = shard.appendShard(manifest, tasks);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 48))), '4c7daec115c7ab769cf4cdc053a179d40aef3c9b86dba95a80ae06b193d0da4c');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const first44 = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs']];
  const first46 = [...first44, ['phase53-z23-verification-owner-heartbeat.test.cjs'], ['phase53-z24-historical-producer-reference.test.cjs']];
  const first47 = [...first46, ['phase53-z25-historical-fixture-text-transport.test.cjs']];
  for (const prefix of [first39, first40, first44, first46, first47]) assert.deepEqual(actual.shards.slice(0, prefix.length), prefix);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 47))), '7192ef371bdfa032b5a1d1b270986d9ed6733a6ff95274d2b046778c9362c3d8');
  const frozen = actual.shards.slice(0, 48), filename = path.basename(__filename);
  const generation = shard.appendShard({ ...manifest, shards: frozen }, [...frozen.flat(), filename].sort());
  assert.equal(generation.shards.length, 49); assert.equal(generation.shards.length + 3, 52);
  assert.deepEqual(generation.shards[48], [filename]);
  assert.equal(actual.shards.flat().filter(task => task === filename).length, 1);
  for (let index = 0; index < actual.shards.length; index++)
    assert.deepEqual(shard.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);
  const checks = ['shards', ...actual.shards.map((_, index) => `unit (shard ${index + 1}/${actual.shards.length})`), 'gates and smoke', 'test-fast'];
  assert.equal(new Set(checks).size, actual.shards.length + 3);
  const directory = h.physical(process.env.HOME, path.join(process.env.HOME, 'future-physical')); fs.mkdirSync(directory);
  for (const file of files) fs.writeFileSync(path.join(directory, file), '');
  const future = 'zz-future-worker-contract.test.cjs'; fs.writeFileSync(path.join(directory, future), '');
  const next = shard.appendShard(actual, shard.unitTasks(shard.unitFiles(directory)));
  assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards);
  assert.deepEqual(next.shards.at(-1), [future]); assert.equal(next.shards.length, actual.shards.length + 1);
  for (let index = 0; index < next.shards.length; index++)
    assert.deepEqual(shard.selectTaskShard(`${index + 1}/${next.shards.length}`, directory, actual), next.shards[index]);
});

if (isMainThread) describe('phase 53 exact semantic worker input projection', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-z27-')));
    const temporary = h.physical(home, path.join(home, 'tmp')); fs.mkdirSync(temporary);
    let worker;
    t.after(async () => { await worker?.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull,
      GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
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
else {
  os.homedir = () => fs.realpathSync(process.env.HOME);
  Promise.resolve().then(() => cases[workerData].run()).then(() => parentPort.postMessage({ completed: true }))
    .catch(error => setImmediate(() => { throw error; }));
}
