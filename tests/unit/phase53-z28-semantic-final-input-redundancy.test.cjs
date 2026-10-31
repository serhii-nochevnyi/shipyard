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
const prior = h.setup('phase53-z27-semantic-worker-input-redundancy.test.cjs',
  "for (const runtime of ['codex', 'claude']) test(",
  'internals, oldBody, rebound, independentPackage, withBytes');
const payloadFor = launch => JSON.parse((launch.input || launch.prompt)
  .match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);

const owners = [
  'plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/.codex-plugin/plugin.json',
  'plugins/shipyard/package-build.json',
  'tests/unit/phase53-z15-responsibility-support.test.cjs',
  'tests/unit/phase53-z19-semantic-wire-dedup.test.cjs',
  'tests/unit/phase53-z27-semantic-worker-input-redundancy.test.cjs',
  'tests/unit/phase53-z28-semantic-final-input-redundancy.test.cjs',
];
function internals(plugin = source) {
  const filename = path.join(plugin, 'scripts/role-artifact.cjs'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports = { ...module.exports, authenticatedSemanticResult, trustedRecord };', filename);
  return { ...prior.internals(plugin), ...loaded.exports };
}
function publicRole(role, runtime, options) {
  for (const file of Object.keys(require.cache)) if (file.startsWith(source + path.sep)
      || file.startsWith(path.join(process.env.HOME, 'producer-'))
      || file.startsWith(path.join(h.ROOT, 'tests/fixtures/phase53') + path.sep)) delete require.cache[file];
  return h.publicRole(role, runtime, options);
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args],
  { env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function configure28(f) {
  const setup = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'write, commit');
  const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
  const template = f.rows['T-49-02'];
  for (let index = 1; index <= 28; index++) {
    const number = String(index).padStart(2, '0'), id = 'T-49-' + number;
    const files = index === 28 ? owners : ['src/producer-' + number + '.cjs', 'src/consumer-' + number + '.cjs'];
    const depends_on = index === 1 ? [] : ['T-49-' + String(index - 1).padStart(2, '0')];
    const row = { ...template, title: 'Complete bounded prospective member ' + number,
      branch: 'ticket/' + id, wave: index, files, depends_on,
      plan: '.planning/phases/' + f.phase + '/49-' + number + '-PLAN.md' };
    f.rows[id] = row; f.state[id] = { status: 'merged', pr: 100 + index, branch: row.branch,
      followup: { depends_on, prior_failure: 'Retained prelaunch refusal; no native phase credit' } };
    const plan = '---\nphase: 49\nplan: "' + number + '"\ntitle: ' + row.title
      + '\nfiles_modified: ' + JSON.stringify(files) + '\ndepends_on: ' + JSON.stringify(depends_on)
      + '\nrequirements: [F53-02, F53-03, F53-06, F53-09]\n'
      + 'delivery: {risk: high, human_checkpoint: review}\n---\n'
      + 'ADR-014\n## Acceptance criteria\n- Preserve complete producer and consumer observations for ' + id + '.\n'
      + '## Tasks\n1. Implement the declared producer contract.\n2. Verify every acceptance and failure path.\n'
      + '## Carried review and followup\nINFO remains in originals. Prior prelaunch refusal and R8 INCOMPLETE remain unresolved history.\n'
      + '## Verification commands\n- `node --test tests/unit/phase53-code-review.test.cjs`\n';
    setup.write(f.worktree, row.plan, plan);
    if (index < 28) {
      setup.write(f.worktree, files[0], 'exports.value = ' + index + ';\n');
      setup.write(f.worktree, files[1], "module.exports = require('./producer-" + number + ".cjs').value;\n");
    }
  }
  for (const relative of owners) setup.write(f.worktree, relative, fs.readFileSync(path.join(h.ROOT, relative)));
  setup.write(f.worktree, 'src/shared-contract.cjs', 'exports.value = 1;\n');
  setup.write(f.worktree, 'src/provider.cjs', "const shared = require('./shared-contract.cjs'); exports.value = shared.value;\n");
  graph.tickets = f.rows;
  setup.write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  setup.write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
  git(f.worktree, 'add', '--', ...owners);
  setup.commit(f, 'complete bounded prospective membership and actual eight owner contents');
  f.memberHead = f.head;
  const binding = h.setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'phaseBinding').phaseBinding(f);
  const inventoryPath = h.physical(f.root, path.join(f.root, 'prospective28-roster.json'));
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
  require(path.join(source, 'scripts/role-artifact.cjs')).registerPhaseArchiveRoster({ worktreePath: f.worktree,
    graphDir: f.graphDir, binding, inventoryPath, expectedInventoryDigest: h.hash(fs.readFileSync(inventoryPath)) });
}
async function originalProducer(generation, run) {
  if (generation === 'no-formats') return run();
  const load = Module._load; let changed = false;
  Module._load = function(request, parent, ...args) {
    let filename;
    try { filename = Module._resolveFilename(request, parent); } catch {}
    if (!changed && typeof filename === 'string' && filename.endsWith('/scripts/role-artifact.cjs')
        && path.dirname(path.dirname(filename)).startsWith(path.join(process.env.HOME, 'producer-'))) {
      const text = fs.readFileSync(filename, 'utf8');
      const first = text.indexOf('function semanticLaunchPayload('), last = text.indexOf('\nfunction assertSemanticLaunchView(', first);
      assert.ok(first > 0 && last > first);
      const renderer = prior.oldBody.toString().replace('function oldBody(', 'function semanticLaunchPayload(');
      const extra = generation === 'previous'
        ? "  if (stage === 'worker' && assignment.id !== 'code-correctness') delete body.obligation_ids;\n"
        : '  delete body.result_formats; body.assignment = assignment || null;\n'
            + '  body.required_context = assignment ? assignment.required_context : snapshot.assignments.flatMap(item => item.required_context);\n';
      const start = renderer.indexOf('  return {');
      const originalRenderer = renderer.slice(0, start) + renderer.slice(start).replace('  return {', '  const body = {')
        .replace(/;\n}$/, ';\n' + extra + '  return body;\n}');
      fs.writeFileSync(h.physical(process.env.HOME, filename), text.slice(0, first) + originalRenderer + text.slice(last));
      changed = true;
    }
    return load.call(this, request, parent, ...args);
  };
  try { await run(); assert.equal(changed, true); } finally { Module._load = load; }
}
function strictFinal({ a, snapshot, launch, record, trusted, report }) {
  const payload = payloadFor(launch), inputs = { material: payload.material, catalog: payload.catalog, originals: payload.originals };
  assert.deepEqual(a.authenticatedSemanticResult(trusted, launch, record).result, report);
  const changes = {
    'restored unrecorded predecessor': p => { p.independent_final_seam_ids = p.seams.map(item => item.id); },
    'missing final vector from recorded predecessor': p => { delete p.independent_final_seam_ids; },
    'reordered vector': p => { p.independent_final_seam_ids = p.seams.map(item => item.id).reverse(); },
    'duplicate vector': p => { p.independent_final_seam_ids = [p.seams[0].id, p.seams[0].id]; },
    'foreign vector': p => { p.independent_final_seam_ids = ['foreign']; },
    'empty vector': p => { p.independent_final_seam_ids = []; },
    'missing seam': p => { p.seams.pop(); },
    'reordered seams': p => { p.seams.reverse(); },
    'duplicated seam': p => { p.seams.push(p.seams[0]); },
    'foreign seam': p => { p.seams[0].id = 'foreign'; },
    'changed rationale': p => { p.seams[0].reason += ' altered'; },
    'changed cross subset': p => { p.cross_responsibility_seam_ids.push('foreign'); },
    'missing final obligation': p => { p.obligation_ids.pop(); },
    'changed context': p => { p.required_context.push({ reason: 'foreign context' }); },
    'changed head': p => { p.reviewed_identity.head = '0'.repeat(40); },
    'changed base': p => { p.reviewed_identity.base = '0'.repeat(40); },
    'changed source descriptor': p => { p.material[0].sha256 = '0'.repeat(64); },
    'changed source alias': p => { p.material[0].aliases[0].path = 'foreign.cjs'; },
    'changed catalog': p => { p.catalog.sha256 = '0'.repeat(64); },
    'changed original': p => { p.originals[0].reference.dispatch_id = 'foreign'; },
    'reordered originals': p => { p.originals.reverse(); },
    'changed original input descriptor': p => { p.originals[0].sha256 = '0'.repeat(64); },
    'mixed omission and no formats': p => { delete p.independent_final_seam_ids; delete p.result_formats; },
    'unrecorded older no-format body': p => {
      p.independent_final_seam_ids = p.seams.map(item => item.id); delete p.result_formats;
    },
    'unrecorded older full context body': p => {
      p.independent_final_seam_ids = p.seams.map(item => item.id); delete p.result_formats;
      p.required_context = snapshot.assignments.flatMap(item => item.required_context);
    },
    'mixed current and old context': p => {
      delete p.independent_final_seam_ids; p.required_context = snapshot.assignments.flatMap(item => item.required_context);
    },
    'mixed current and assignment': p => { p.assignment = snapshot.assignments[0]; },
    'foreign field': p => { p.extra = true; },
  };
  for (const [label, mutate] of Object.entries(changes)) {
    const bad = prior.rebound(launch, mutate);
    if (bad.input === launch.input) continue;
    assert.equal(h.hash(bad.input), bad.input_sha256, label);
    const body = payloadFor(bad); delete body.binding_sha256;
    const assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
    const view = a.semanticRequiredView(snapshot, assignment);
    const current = a.semanticLaunchPayload(snapshot, 'final', assignment, view, inputs, record.input_transport);
    if (h.stable(body) !== h.stable(current)) assert.throws(() => a.assertSemanticLaunchView(bad, record, inputs), undefined, label);
    else assert.throws(() => a.authenticatedSemanticResult(trusted, bad, record), undefined, label);
  }
  for (const key of ['input_sha256', 'binding_sha256', 'responsibility_view_version', 'dispatch_id'])
    assert.throws(() => a.authenticatedSemanticResult(trusted, { ...launch, [key]: 'foreign' }, record), undefined, key);
  for (const mutate of [p => { p.completeness = 'incomplete'; }, p => { p.completeness = 'blocked'; },
    p => { p.unread = p.coverage.slice(-1); }, p => { p.required_context = ['Native context unavailable']; },
    p => { p.limitations = ['Complete original retains native uncertainty']; }]) {
    const result = h.clone(report); mutate(result);
    const core = require(path.join(source, 'scripts/code-review-core.cjs'));
    const value = core.projectSemanticResult(result, { packet: snapshot.code_review_packet, identity: snapshot.identity,
      readSource: file => fs.readFileSync(path.join(snapshot.identity.worktree, file), 'utf8') });
    assert.equal(value.verdict, 'incomplete'); assert.equal(value.info_dropped, 1);
    assert.deepEqual(value.limitations, result.limitations);
  }
}
function bounds(a, snapshot, launches, originals, record) {
  const observations = [];
  for (const launch of launches) {
    const details = a.semanticPreflight(snapshot, launch);
    assert.ok(details.input_bytes <= 1048576); assert.equal(details.input_limit_bytes, 1048576);
    assert.equal(details.result_limit_bytes, 131072); assert.ok(launch.prefix_bytes > 0);
    assert.equal(details.schema_bytes > 0, snapshot.runtime === 'claude'); observations.push(details);
    const excessive = h.clone(snapshot);
    excessive.identity.excessive_complete_metadata = 'x'.repeat(1048576);
    delete excessive.snapshot_sha256; excessive.snapshot_sha256 = h.hash(h.stable(excessive));
    a.assertSemanticSnapshot(excessive);
    assert.throws(() => a.semanticBuildLaunch({ ...record, snapshot: excessive }, launch.stage,
      launch.assignment_id, launch.stage === 'final' ? originals : [], true),
      error => error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND'
        && error.details.input_limit_bytes === 1048576 && error.details.input_bytes > 1048576);
  }
  for (const original of originals) {
    const wire = JSON.parse(original.original_text);
    a.semanticWireBound({ result: wire, text: original.original_text });
    assert.throws(() => a.semanticWireBound({ result: { ...wire, evidence_markdown: 'x'.repeat(131072) }, text: original.original_text }),
      error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND' && error.details.limit_bytes === 131072);
    assert.throws(() => a.semanticWireBound({ result: wire, text: original.original_text + ' '.repeat(131072) }),
      error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND' && error.details.terminal_bytes > 131072);
  }
  return observations;
}
function coldCustody({ f, api, a, snapshot, prepared, originals, current, consumers }) {
  const directory = api.archiveAuthorityDirectory(f.worktree), archive = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
  const authority = h.inventory(directory), original = originals[0];
  const envelopes = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    const file = h.physical(f.root, path.join(directory, name));
    return { file, bytes: fs.readFileSync(file), value: JSON.parse(fs.readFileSync(file)) };
  });
  const launch = envelopes.find(row => row.file.includes('semantic-launch-') && row.value.payload.stage === 'final');
  const snapshotEnvelope = envelopes.find(row => row.file.includes('semantic-snapshot-')
    && row.value.payload.snapshot.snapshot_sha256 === snapshot.snapshot_sha256);
  assert.ok(launch); assert.ok(snapshotEnvelope);
  const records = fs.readdirSync(prepared.recorder.storeDir).filter(name => /^record-.*\.json$/.test(name)).map(name => {
    const file = h.physical(f.root, path.join(prepared.recorder.storeDir, name));
    return { file, value: JSON.parse(fs.readFileSync(file)) };
  });
  const receipt = records.find(row => row.value.payload.dispatch_id === original.reference.dispatch_id); assert.ok(receipt);
  const finalReceipt = records.find(row => row.value.payload.dispatch_id === launch.value.payload.dispatch_id); assert.ok(finalReceipt);
  const mutations = [
    ['worker transcript', original.native.native_pin.path, bytes => Buffer.concat([bytes, Buffer.from('\n')])],
    ['worker original terminal', original.native.output_pin.path, bytes => Buffer.concat([bytes, Buffer.from('changed')])],
    ['missing original transcript', original.native.native_pin.path, () => null],
    ['original receipt session', receipt.file, bytes => {
      const value = JSON.parse(bytes); value.payload.receipt.session_id = 'foreign'; return JSON.stringify(value);
    }],
    ['final receipt initialization', finalReceipt.file, bytes => {
      const value = JSON.parse(bytes);
      if (snapshot.runtime === 'codex') delete value.payload.receipt.runtime_evidence.initial_context;
      else value.payload.receipt.selection_evidence.transcript.sha256 = '0'.repeat(64);
      return JSON.stringify(value);
    }],
    ['original launch', launch.file, bytes => {
      const value = JSON.parse(bytes); value.payload.input += 'changed'; return JSON.stringify(value);
    }],
  ];
  for (const field of ['source', 'head', 'base', 'criteria', 'producer']) mutations.push(['snapshot ' + field, snapshotEnvelope.file, bytes => {
    const value = JSON.parse(bytes), snap = value.payload.snapshot;
    if (field === 'source') snap.material[0].content += 'changed';
    if (field === 'head' || field === 'base') snap.identity[field] = '0'.repeat(40);
    if (field === 'criteria') snap.criteria += 'changed';
    if (field === 'producer') snap.pins[0].sha256 = '0'.repeat(64);
    return JSON.stringify(value);
  }]);
  const final = prepared.launches.at(-1), finalLaunch = a.semanticEnvelope(f.worktree, 'launch',
    a.semanticKey(snapshot.snapshot_sha256, 'final', null));
  const finalPin = a.partitionNativePin(prepared.recorder.getVerifiedRecord(finalLaunch.dispatch_id));
  for (const field of ['session', 'input', 'model', 'initialization']) mutations.push(['final native ' + field, finalPin.path, bytes => {
    const rows = bytes.toString().trim().split('\n').map(JSON.parse);
    if (snapshot.runtime === 'codex') {
      if (field === 'session') rows.find(row => row.type === 'session_meta').payload.id = originals[0].native.session_id;
      if (field === 'input') rows.find(row => row.payload?.role === 'user'
        && row.payload.content.some(item => item.text?.includes('<AUTHENTICATED_SEMANTIC_REVIEW>'))).payload.content[0].text += 'changed';
      if (field === 'model') rows.find(row => row.type === 'turn_context').payload.model = 'foreign';
      if (field === 'initialization') rows.splice(rows.findIndex(row => row.payload?.role === 'developer'), 1);
    } else {
      if (field === 'session') rows.find(row => row.type === 'assistant').sessionId = originals[0].native.session_id;
      if (field === 'input' || field === 'initialization') rows[0].message.content += 'changed';
      if (field === 'model') rows.find(row => row.type === 'assistant').message.model = 'foreign';
    }
    return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  }]);
  for (const [label, filename, mutate] of mutations) {
    const bytes = fs.readFileSync(h.physical(process.env.HOME, filename));
    prior.withBytes(filename, mutate(bytes), () => {
      assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null, label);
      assert.equal(h.cold(f, 'code-review', consumers.at(-1)), null, label);
    });
    assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current, label + ' restored');
  }
  const staged = consumers.at(-1), root = path.resolve(staged, '../../..');
  for (const relative of ['host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
    '.codex-plugin/plugin.json', 'package-build.json']) {
    const file = path.join(root, relative);
    const bytes = fs.readFileSync(file);
    const changed = relative.endsWith('.cjs')
      ? bytes.toString().replace('...selectedView,', '...view, ...inputs,')
      : bytes.toString().replace(/codex\./, 'codex.altered');
    assert.notEqual(changed, bytes.toString());
    prior.withBytes(file, changed, () => {
      assert.throws(() => h.packageParity(root));
      if (relative.endsWith('.cjs')) assert.equal(h.cold(f, 'code-review', staged), null);
    });
  }
  const stagedFile = path.join(staged, 'scripts/role-artifact.cjs'), mode = fs.statSync(stagedFile).mode & 0o777;
  try { fs.chmodSync(stagedFile, mode ^ 0o100); assert.throws(() => h.packageParity(root)); }
  finally { fs.chmodSync(stagedFile, mode); }
  const parked = h.physical(f.root, path.join(f.root, 'parked-stage-source.cjs'));
  try {
    fs.renameSync(stagedFile, parked); fs.symlinkSync(parked, stagedFile);
    assert.throws(() => h.packageParity(root));
  } finally { fs.rmSync(stagedFile, { force: true }); fs.renameSync(parked, stagedFile); }
  const producer = path.join(f.producer, 'scripts/role-artifact.cjs');
  prior.withBytes(producer, fs.readFileSync(producer, 'utf8') + '\n', () => {
    for (const owner of consumers) assert.equal(h.cold(f, 'code-review', owner), null);
  });
  for (const owner of consumers) {
    assert.deepEqual(h.cold(f, 'code-review', owner), current);
    assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
  }
  assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), archive);
  assert.deepEqual(h.inventory(directory), authority);
  assert.equal(final.payload.stage, 'final');
}

for (const runtime of ['codex', 'claude']) test(runtime + ' current public final omits only the duplicate ordered seam vector', async () => {
  await publicRole('code-review', runtime, {
    configureFixture: configure28,
    onLaunch(launch) {
      if (launch.payload.stage === 'final') assert.equal(Object.hasOwn(launch.payload, 'independent_final_seam_ids'), false);
    },
    inspect({ f, api, plugin, prepared, originals, snapshots, completed, expected }) {
      const a = internals(plugin), snapshot = [...snapshots.values()][0], beforeSnapshot = h.stable(snapshot);
      const record = a.semanticRecord(f.worktree, snapshot.snapshot_sha256);
      assert.equal(prepared.launches.length, 3); assert.equal(originals.length, 2);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      assert.equal(completed.result.verdict, 'pass');
      for (const observed of prepared.launches) {
        const launch = a.semanticEnvelope(f.worktree, 'launch',
          a.semanticKey(snapshot.snapshot_sha256, observed.payload.stage, observed.payload.assignment?.id || null));
        const { binding_sha256, ...body } = payloadFor(launch);
        const assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
        const view = a.semanticRequiredView(snapshot, assignment), before = h.stable(view);
        const inputs = { material: body.material, catalog: body.catalog, originals: body.originals };
        const previous = prior.oldBody(snapshot, launch.stage, assignment, view, inputs, record.input_transport);
        if (assignment) {
          delete previous.obligation_ids;
          assert.deepEqual(body, previous);
        } else {
          const { independent_final_seam_ids, ...projected } = previous;
          assert.deepEqual(body, projected);
          assert.deepEqual({ ...body, independent_final_seam_ids: body.seams.map(item => item.id) }, previous);
          assert.deepEqual(independent_final_seam_ids, snapshot.independent_final_seam_ids);
          assert.deepEqual(view.independent_final_seam_ids, view.seams.map(item => item.id));
          assert.equal(Buffer.byteLength(h.stable(previous)) - Buffer.byteLength(h.stable(body)),
            Buffer.byteLength('"independent_final_seam_ids":' + h.stable(independent_final_seam_ids) + ','));
          assert.deepEqual(body.cross_responsibility_seam_ids, snapshot.cross_responsibility_seam_ids);
        }
        assert.equal(h.stable(view), before); assert.equal(binding_sha256, h.hash(h.stable(body)));
        a.assertSemanticLaunchView(launch, record, inputs);
      }
      for (const original of originals) {
        assert.equal(original.result.findings[0].severity, 'INFO');
        assert.deepEqual(original.result, expected.get(original.reference.assignment_id));
        assert.equal(original.native.resource_failure, null);
        const wire = JSON.parse(original.original_text);
        assert.equal(wire.result_format, 'snapshot-indexed.v1');
        const launch = a.semanticEnvelope(f.worktree, 'launch',
          a.semanticKey(snapshot.snapshot_sha256, 'worker', original.reference.assignment_id));
        assert.deepEqual(a.decodeSemanticResult(wire, launch, snapshot), original.result);
        for (const mutate of [w => { w.coverage_indices.reverse(); }, w => { w.seam_rows.reverse(); },
          w => { w.seam_rows.pop(); }, w => { w.seam_rows[0].index = snapshot.seams.length; },
          w => { delete w.limitations; }, w => { w.reviewed_identity = snapshot.identity; }]) {
          const bad = h.clone(wire); mutate(bad);
          assert.throws(() => a.decodeSemanticResult(bad, launch, snapshot));
        }
      }
      const current = api.currentCodeReviewVerdict(h.inputFor(f));
      assert.equal(current.authenticated, true);
      assert.equal(snapshot.identity.ticket_set.length, 28);
      assert.equal(snapshot.responsibility_tickets.length, 28);
      for (const ticket of snapshot.responsibility_tickets) {
        assert.ok(snapshot.material.some(item => item.aliases.some(alias => alias.path === ticket.plan)));
        assert.ok(snapshot.pins.some(pin => pin.path === ticket.plan));
        const plan = fs.readFileSync(path.join(f.worktree, ticket.plan), 'utf8');
        assert.ok(plan.includes('## Carried review and followup'));
      }
      assert.ok(snapshot.pins.some(pin => pin.path === '.planning/graph/tickets.json'));
      assert.ok(snapshot.pins.some(pin => pin.path === '.planning/graph/delivery-state.json'));
      const finalObserved = prepared.launches.at(-1), finalBody = payloadFor(finalObserved);
      for (const [index, descriptor] of finalBody.originals.entries()) {
        assert.deepEqual(descriptor.reference, originals[index].reference);
        assert.deepEqual(descriptor.native, originals[index].native);
        assert.equal(descriptor.bytes, Buffer.byteLength(originals[index].original_text));
        assert.equal(descriptor.sha256, h.hash(originals[index].original_text));
        assert.equal(fs.readFileSync(descriptor.read_path, 'utf8'), originals[index].original_text);
        assert.deepEqual(JSON.parse(fs.readFileSync(descriptor.expanded_view.read_path)), originals[index].result);
        assert.equal(descriptor.expanded_view.sha256, h.hash(h.stable(originals[index].result)));
      }
      const finalText = finalObserved.text || finalObserved.originalText;
      a.semanticWireBound({ result: finalObserved.result, text: finalText });
      assert.deepEqual(snapshot.responsibility_tickets.at(-1).files, owners);
      for (const relative of owners) {
        const bytes = fs.readFileSync(path.join(h.ROOT, relative));
        const item = snapshot.material.find(item => item.aliases.some(alias => alias.path === relative)
          && item.sha256 === h.hash(bytes));
        assert.ok(item, relative); assert.equal(item.bytes, bytes.length); assert.equal(item.content, bytes.toString());
      }
      const candidate = prior.independentPackage(f), staged = path.join(candidate, 'host/plugins/delivery-pipeline');
      assert.deepEqual(fs.readFileSync(path.join(candidate, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs')),
        fs.readFileSync(path.join(source, 'scripts/role-artifact.cjs')));
      const consumers = [source, shipped, staged];
      for (const owner of consumers) {
        assert.deepEqual(h.cold(f, 'code-review', owner), current);
        assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
      }
      const launches = prepared.launches.map(item => a.semanticEnvelope(f.worktree, 'launch',
        a.semanticKey(snapshot.snapshot_sha256, item.payload.stage, item.payload.assignment?.id || null)));
      const final = launches.at(-1);
      strictFinal({ a, snapshot, launch: final, record,
        trusted: a.trustedRecord({ recorder: prepared.recorder, dispatchId: final.dispatch_id }), report: expected.get('final') });
      const observations = bounds(a, snapshot, launches, originals, record);
      f.producer = plugin;
      coldCustody({ f, api, a, snapshot, prepared, originals, current, consumers });
      assert.equal(h.stable(snapshot), beforeSnapshot);
      process.stdout.write(JSON.stringify({ runtime, prospective28_complete_request: observations,
        final_wire_bytes: Buffer.byteLength(h.stable(finalObserved.result)), final_terminal_bytes: Buffer.byteLength(finalText),
        recorded_workers: 2, independent_final: 1, real_originals: 2,
        actual28_postmerge_native_fit: 'owed', original_8bc_final_refusal: 'retained',
        R8: 'INCOMPLETE', semantic_credit: 0 }) + '\n');
    },
  });
});

for (const runtime of ['codex', 'claude']) test(runtime + ' exact recorded previous and older finals retain original custody cold', async () => {
  const candidate = prior.independentPackage({ root: fs.realpathSync(process.env.HOME) });
  const consumers = [source, shipped, path.join(candidate, 'host/plugins/delivery-pipeline')];
  for (const generation of ['previous', 'no-formats', 'legacy']) {
    await originalProducer(generation, () => publicRole('code-review', runtime, {
      historical: generation !== 'previous', historicalShared: generation !== 'previous',
      full: true, incomplete: generation === 'previous',
      result(result) {
        if (generation === 'previous' && result.assignment_id === 'code-correctness') result.completeness = 'blocked';
      },
      async inspect({ f, api, plugin, prepared, snapshots, originals, expected, completed }) {
        const a = internals(), currentApi = a, snapshot = [...snapshots.values()][0];
        const before = h.stable(snapshot), record = a.semanticRecord(f.worktree, snapshot.snapshot_sha256);
        const archive = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
        const authority = h.inventory(api.archiveAuthorityDirectory(f.worktree));
        assert.equal(prepared.launches.length, 3); assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
        assert.equal(completed.result.verdict, generation === 'previous' ? 'incomplete' : 'pass');
        for (const observed of prepared.launches) {
          const launch = a.semanticEnvelope(f.worktree, 'launch',
            a.semanticKey(snapshot.snapshot_sha256, observed.payload.stage, observed.payload.assignment?.id || null));
          const { binding_sha256, ...body } = payloadFor(launch);
          const assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
          const view = a.semanticRequiredView(snapshot, assignment);
          const inputs = { material: body.material, catalog: body.catalog, originals: body.originals };
          const previous = prior.oldBody(snapshot, launch.stage, assignment, view, inputs, record.input_transport);
          const expectedBody = h.clone(previous);
          if (generation === 'previous') {
            if (assignment?.id === 'code-acceptance') delete expectedBody.obligation_ids;
          } else {
            delete expectedBody.result_formats;
            if (generation === 'legacy') {
              expectedBody.assignment = assignment || null;
              expectedBody.required_context = assignment ? assignment.required_context
                : snapshot.assignments.flatMap(item => item.required_context);
            }
          }
          assert.deepEqual(body, expectedBody);
          assert.equal(binding_sha256, h.hash(h.stable(body))); assert.equal(launch.input_sha256, h.hash(launch.input));
          currentApi.assertSemanticLaunchView(launch, record, inputs);
          for (const changed of [{ ...launch, dispatch_id: 'unrecorded' },
            { ...launch, input: 'foreign prefix\n' + launch.input, input_sha256: h.hash('foreign prefix\n' + launch.input) }]) {
            if (generation === 'previous' && assignment?.id === 'code-acceptance') continue;
            assert.throws(() => currentApi.assertSemanticLaunchView(changed, record, inputs), /exact recorded original launch/);
          }
          if (!assignment) {
            assert.deepEqual(body.independent_final_seam_ids, view.seams.map(item => item.id));
            assert.deepEqual(body.cross_responsibility_seam_ids, snapshot.cross_responsibility_seam_ids);
            strictFinal({ a, snapshot, launch, record, trusted: a.trustedRecord({ recorder: prepared.recorder, dispatchId: launch.dispatch_id }),
              report: expected.get('final') });
          }
        }
        for (const [index, original] of originals.entries()) {
          assert.deepEqual(JSON.parse(original.original_text), original.result);
          assert.deepEqual(original.result, expected.get(original.reference.assignment_id));
          assert.equal(original.result.findings[0].severity, 'INFO');
          assert.ok(original.result.conclusions.length >= 2);
          assert.ok(original.result.seams.every(row => row.rationale.length > 10));
          assert.deepEqual(original.result.coverage, snapshot.assignments[index].primary_obligation_ids);
          if (generation === 'previous') {
            assert.equal(original.result.completeness, index === 0 ? 'blocked' : 'incomplete');
            assert.ok(original.result.limitations.length); assert.ok(original.result.unread.length);
            assert.ok(original.result.seams.every(row => row.disposition === 'unresolved'));
          }
        }
        const current = api.currentCodeReviewVerdict(h.inputFor(f));
        for (const owner of consumers) {
          assert.deepEqual(h.cold(f, 'code-review', owner), current);
          assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
        }
        if (generation === 'previous') {
          f.producer = plugin;
          coldCustody({ f, api, a, snapshot, prepared, originals, current, consumers });
        }
        const count = prepared.launches.length;
        assert.deepEqual((await prepared.run()).result, completed.result);
        assert.equal(prepared.launches.length, count);
        assert.equal(h.stable(snapshot), before);
        assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), archive);
        assert.deepEqual(h.inventory(api.archiveAuthorityDirectory(f.worktree)), authority);
        process.stdout.write(JSON.stringify({ runtime, generation, recorded_workers: 2, independent_final: 1,
          verdict: current.verdict, native_phase_acceptance: false }) + '\n');
      },
    }));
  }
});

for (const runtime of ['codex', 'claude']) test(runtime + ' unchanged integration architecture and recorded resource refusals', async () => {
  for (const role of ['integrator', 'arch-review']) await publicRole(role, runtime, {
    inspect({ f, api, prepared, snapshots, originals }) {
      const a = internals(), snapshot = [...snapshots.values()][0], before = h.stable(snapshot);
      const record = a.semanticRecord(f.worktree, snapshot.snapshot_sha256);
      for (const observed of prepared.launches) {
        const launch = a.semanticEnvelope(f.worktree, 'launch',
          a.semanticKey(snapshot.snapshot_sha256, observed.payload.stage, observed.payload.assignment?.id || null));
        const { binding_sha256, ...body } = payloadFor(launch);
        const assignment = snapshot.assignments.find(item => item.id === launch.assignment_id);
        const view = a.semanticRequiredView(snapshot, assignment);
        assert.deepEqual(body, prior.oldBody(snapshot, launch.stage, assignment, view,
          { material: body.material, catalog: body.catalog, originals: body.originals }, record.input_transport));
        assert.equal(binding_sha256, h.hash(h.stable(body)));
        if (!assignment) assert.deepEqual(body.independent_final_seam_ids, snapshot.independent_final_seam_ids);
      }
      for (const original of originals) assert.ok(original.result.findings.some(item => item.id.startsWith('INFO-')));
      assert.equal(api[h.consumer(role)](h.inputFor(f)).authenticated, true);
      assert.equal(h.stable(snapshot), before);
    },
  });
  await publicRole('code-review', runtime, {
    refusal: /SEMANTIC_REVIEW_INCOMPLETE/,
    native(rows, payload) {
      if (payload.stage !== 'worker') return;
      if (payload.assignment.id === 'code-correctness') {
        if (runtime === 'codex') {
          const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
          const marker = template(registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl'), row => row.type === 'event_msg');
          marker.payload = { type: 'compacted' }; rows.splice(-2, 0, marker);
        } else rows.at(-1).message.stop_reason = 'max_tokens';
      } else if (runtime === 'codex') {
        const output = rows.find(row => row.payload?.type === 'function_call_output'); assert.ok(output);
        output.payload.output = JSON.stringify({ exit_code: 1, output: 'Native required read failed' });
      } else {
        const output = rows.find(row => row.message?.content?.[0]?.type === 'tool_result'); assert.ok(output);
        output.message.content[0].is_error = true;
      }
    },
    inspect({ f, plugin, originals, prepared, completed }) {
      assert.equal(completed, undefined); assert.equal(prepared.launches.length, 3);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      assert.equal(Object.hasOwn(payloadFor(prepared.launches.at(-1)), 'independent_final_seam_ids'), false);
      assert.ok(originals.find(item => item.reference.assignment_id === 'code-correctness').native.resource_failure);
      assert.ok(originals.find(item => item.reference.assignment_id === 'code-acceptance').native.reads.incomplete.length);
      for (const original of originals) {
        assert.equal(original.native.reads.semantic_credit, false);
        assert.equal(original.result.findings[0].severity, 'INFO');
      }
      for (const owner of [source, shipped, plugin]) {
        assert.equal(h.cold(f, 'code-review', owner), null);
        assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
      }
    },
  });
  await publicRole('code-review', runtime, {
    refusal: /SEMANTIC_REVIEW_INCOMPATIBLE/,
    result(result) { if (result.stage === 'final') result.seams[0].disposition = 'unresolved'; },
    inspect({ f, plugin, prepared, originals, completed, failure }) {
      assert.match(failure.message, /unresolved original findings or dependency seams cannot pass/);
      assert.equal(completed, undefined); assert.equal(prepared.launches.length, 3);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      assert.equal(prepared.launches.at(-1).result.seam_rows[0].disposition, 'unresolved');
      assert.ok(originals.every(item => item.result.seams.every(seam => seam.disposition === 'resolved')));
      for (const owner of [source, shipped, plugin]) {
        assert.equal(h.cold(f, 'code-review', owner), null);
        assert.deepEqual(h.cold(f, 'code-review', owner, originals), originals);
      }
    },
  });
});

test('real scopedTree accepts owned helper bytes and refuses unowned worktree staged and untracked paths', () => {
  const directory = h.physical(process.env.HOME, path.join(process.env.HOME, 'scope')); fs.mkdirSync(directory);
  git(directory, 'init', '--initial-branch=main', '--template=');
  for (const [file, text] of [['owned-helper.cjs', 'exports.value = 1;\n'], ['owned.test.cjs', 'original test\n'],
    ['unowned.cjs', 'original unowned bytes\n']]) fs.writeFileSync(path.join(directory, file), text);
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'scope fixture baseline');
  const expectedHead = git(directory, 'rev-parse', 'HEAD');
  const api = require(path.join(source, 'scripts/delivery-commit-finalizer.cjs'));
  const options = { worktree: directory, expectedHead, files_modified: ['owned-helper.cjs', 'owned.test.cjs'] };
  const state = () => ({ head: git(directory, 'rev-parse', 'HEAD'), tree: git(directory, 'write-tree'),
    index: fs.readFileSync(path.join(directory, '.git/index')) });
  fs.writeFileSync(path.join(directory, 'owned-helper.cjs'), 'exports.value = 2;\n');
  const before = state(), candidate = api.scopedTree(options);
  assert.deepEqual(state(), before); assert.equal(candidate.head, expectedHead);
  assert.deepEqual(candidate.changed, ['owned-helper.cjs']); assert.notEqual(candidate.tree, before.tree);
  assert.equal(git(directory, 'show', candidate.tree + ':owned-helper.cjs'), 'exports.value = 2;');
  assert.equal(git(directory, 'show', candidate.tree + ':unowned.cjs'), 'original unowned bytes');
  for (const kind of ['tracked', 'staged', 'untracked']) {
    const file = path.join(directory, kind === 'untracked' ? 'unowned-new.cjs' : 'unowned.cjs');
    fs.writeFileSync(file, 'undeclared ' + kind + ' change\n');
    if (kind === 'staged') git(directory, 'add', '--', 'unowned.cjs');
    const pinned = state();
    assert.throws(() => api.scopedTree(options), /out-of-scope paths: unowned/, kind);
    assert.deepEqual(state(), pinned, kind);
    if (kind === 'untracked') fs.unlinkSync(file);
    else git(directory, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'unowned.cjs');
    assert.equal(state().head, before.head); assert.equal(state().tree, before.tree);
    const restored = state();
    assert.deepEqual(api.scopedTree(options), candidate); assert.deepEqual(state(), restored);
  }
  const finalState = state();
  assert.throws(() => api.scopedTree({ ...options, expectedHead: '0'.repeat(40) }), /HEAD differs/);
  assert.deepEqual(state(), finalState);
});

test('physical z28 preserves all frozen prefixes appends generation50 and uses actual future denominators', () => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest(), files = s.unitFiles(), tasks = s.unitTasks(files);
  const actual = s.appendShard(manifest, tasks), frozen = actual.shards.slice(0, 49), filename = path.basename(__filename);
  assert.equal(h.hash(JSON.stringify(frozen)), '5f32b243eb01f507ac638cb8d8fe40865b0d41693c880749b42f11e8ec6cdeb4');
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const first44 = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs']];
  const first46 = [...first44, ['phase53-z23-verification-owner-heartbeat.test.cjs'], ['phase53-z24-historical-producer-reference.test.cjs']];
  const first47 = [...first46, ['phase53-z25-historical-fixture-text-transport.test.cjs']];
  const first48 = [...first47, ['phase53-z26-native-initialization-order.test.cjs']];
  for (const prefix of [first39, first40, first44, first46, first47, first48])
    assert.deepEqual(actual.shards.slice(0, prefix.length), prefix);
  assert.equal(h.hash(JSON.stringify(first47)), '7192ef371bdfa032b5a1d1b270986d9ed6733a6ff95274d2b046778c9362c3d8');
  assert.equal(h.hash(JSON.stringify(first48)), '4c7daec115c7ab769cf4cdc053a179d40aef3c9b86dba95a80ae06b193d0da4c');
  const generation = s.appendShard({ ...manifest, shards: frozen }, [...frozen.flat(), filename].sort());
  assert.equal(generation.shards.length, 50); assert.equal(generation.shards.length + 3, 53);
  assert.deepEqual(generation.shards[49], [filename]);
  assert.equal(actual.shards.flat().filter(task => task === filename).length, 1);
  assert.deepEqual(actual.shards, [...frozen, ...tasks.filter(task => !frozen.flat().includes(task)).map(task => [task])]);
  const checks = ['shards', ...actual.shards.map((_, index) => `unit (shard ${index + 1}/${actual.shards.length})`),
    'gates and smoke', 'test-fast'];
  assert.equal(new Set(checks).size, actual.shards.length + 3);
  for (let index = 0; index < actual.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);
  const directory = h.physical(process.env.HOME, path.join(process.env.HOME, 'physical-future')); fs.mkdirSync(directory);
  for (const file of files) fs.writeFileSync(path.join(directory, file), '');
  const future = 'zz-future-final-input.test.cjs'; fs.writeFileSync(path.join(directory, future), '');
  const next = s.appendShard(actual, s.unitTasks(s.unitFiles(directory)));
  assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards);
  assert.deepEqual(next.shards.at(-1), [future]); assert.equal(next.shards.length, actual.shards.length + 1);
  for (let index = 0; index < next.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${next.shards.length}`, directory, actual), next.shards[index]);
});


if (isMainThread) describe('phase 53 exact semantic final input projection', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-z28-')));
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
