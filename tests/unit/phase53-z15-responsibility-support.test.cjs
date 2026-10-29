'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const VIEW = 'shipyard.semantic-responsibility-view.v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function load(file, names, end) {
  const filename = path.resolve(ROOT, file), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === 'node:test' ? { test() {}, describe() {} } : original.call(this, name, ...args);
    };
    let source = fs.readFileSync(filename, 'utf8');
    if (end) { assert.ok(source.includes(end)); source = source.slice(0, source.indexOf(end)); }
    loaded._compile(source + '\nmodule.exports = { ' + names + ' };', filename);
  } finally { Module._load = original; }
  return loaded.exports;
}

function authority(file = 'plugins/delivery-pipeline/scripts/role-artifact.cjs') {
  return load(file, 'semanticResponsibilities, assertSemanticSnapshot, validateSemanticResult, assertSemanticLaunchView, semanticRequiredView, semanticComplete, stable');
}

function inventory() {
  const material = [
    ['src/provider.cjs', 'exports.value = 1;\n'],
    ['src/caller.cjs', "exports.value = require('./provider.cjs').value;\n"],
    ['other/unrelated.cjs', 'exports.unrelated = true;\n'],
    ['other/unrelated-user.cjs', "exports.user = require('./unrelated.cjs');\n"],
    ['tests/provider.test.cjs', "require('../src/provider.cjs');\n"],
  ].map(([file, content], index) => ({ source_id: 's-' + hash(content), sha256: hash(content),
    bytes: Buffer.byteLength(content), content, path: file, kind: 'source', revision: 'head',
    aliases: [{ path: file, pointer: '/sources/' + index + '/content', kind: 'source', revision: 'head' }] }));
  material[0].aliases.push({ path: 'src/provider-alias.cjs', pointer: '/aliases/0/content', kind: 'source', revision: 'head' });
  const obligations = material.flatMap(source => source.aliases.map(alias => ({ id: 'o-' + hash(alias.path),
    path: alias.path, pointer: alias.pointer, source_id: source.source_id, sha256: source.sha256, kind: 'logical-completion' })));
  obligations.push({ id: 'global-criterion', path: 'phase', pointer: '/governing/0', governing: true,
    kind: 'contract-item', value: 'Preserve source integrity.' });
  return { material, obligations };
}

function snapshot(a, inv = inventory(), role = 'integrator', runtime = 'codex') {
  const value = { schema: 'shipyard.semantic-review-snapshot.v1', review_contract: 'shipyard.semantic-review.v1',
    role, runtime, stage: 'snapshot', ...inv, ...a.semanticResponsibilities(inv, [], role) };
  value.snapshot_sha256 = hash(a.stable(value));
  return value;
}

function assertViews(payload, global) {
  assert.equal(payload.responsibility_view_version, VIEW);
  const assignment = payload.assignment;
  if (!assignment) {
    assert.deepEqual(payload.obligation_ids, global.obligation_ids);
    return;
  }
  const ids = [...new Set([...assignment.primary_obligation_ids, ...assignment.support_obligation_ids])];
  assert.deepEqual(payload.obligation_ids, global.obligation_ids.filter(id => ids.includes(id)));
  assert.deepEqual(payload.material.map(item => item.source_id), assignment.required_material_source_ids);
  assert.deepEqual(payload.seams.map(item => item.id), assignment.required_seam_ids);
  for (const id of assignment.support_obligation_ids) assert.ok(assignment.support_reasons[id]?.length);
  assert.ok(payload.catalog.read_path);
  const catalog = fs.readFileSync(payload.catalog.read_path);
  assert.equal(catalog.length, payload.catalog.bytes);
  assert.equal(hash(catalog), payload.catalog.sha256);
  const complete = JSON.parse(catalog);
  assert.deepEqual(complete.obligations, global.obligations);
  assert.deepEqual(complete.material.map(item => item.source_id), global.material.map(item => item.source_id));
  for (const source of complete.material) assert.equal(hash(fs.readFileSync(source.read_path)), source.sha256);
}

test('ordinary Codex integration scopes support, overlaps physical workers and retains complete cold final coverage', async () => {
  const h = load('tests/unit/phase53-codex-integration.test.cjs',
    'publicIntegrationFixture, write, commit, semanticFixture, supportedPartitionCaller, captureOriginals, coldCurrent, contract');
  await h.publicIntegrationFixture(async f => {
    h.write(f.worktree, 'other/unrelated.cjs', 'exports.unrelated = true;\n');
    h.write(f.worktree, 'other/unrelated-user.cjs', "exports.user = require('./unrelated.cjs');\n");
    h.write(f.worktree, 'src/provider-alias.cjs', 'exports.value = 1;\n');
    require('node:child_process').execFileSync('git', ['-C', f.worktree, 'add', '--',
      'other/unrelated.cjs', 'other/unrelated-user.cjs']);
    h.commit(f, 'fixture: unrelated component and exact source alias');
    const prepared = h.semanticFixture(f);
    await h.supportedPartitionCaller(f, 'codex', prepared.options);
    const workers = prepared.launches.slice(0, 2), final = prepared.launches[2].payload;
    assert.deepEqual(prepared.completed, ['consumer-acceptance', 'producer-contract', 'final']);
    assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
    const primary = workers.flatMap(item => item.payload.assignment.primary_obligation_ids);
    assert.equal(new Set(primary).size, primary.length);
    assert.deepEqual([...primary].sort(), [...final.obligation_ids].sort());
    for (const worker of workers) assertViews(worker.payload, final);
    const consumer = workers.find(item => item.payload.assignment.id === 'consumer-acceptance').payload;
    const unrelated = final.obligations.filter(item => item.path === 'other/unrelated.cjs');
    assert.ok(unrelated.length);
    assert.ok(unrelated.every(item => !consumer.assignment.support_obligation_ids.includes(item.id)));
    assert.ok(consumer.seams.length < final.seams.length);
    assert.ok(final.seams.some(item => item.producer === 'src/provider.cjs' && item.consumer === 'src/consumer.cjs'));
    const provider = final.material.find(source => source.aliases.some(alias => alias.path === 'src/provider.cjs')
      && fs.readFileSync(path.resolve(f.worktree, source.read_path), 'utf8') === 'exports.value = 1;\n');
    assert.ok(provider);
    assert.equal(fs.readFileSync(path.resolve(f.worktree, provider.read_path), 'utf8'), 'exports.value = 1;\n');
    assert.ok(provider.aliases.some(alias => alias.path === 'src/provider.cjs'));
    assert.ok(provider.aliases.some(alias => alias.path === 'src/provider-alias.cjs'));
    const originals = h.captureOriginals(f, prepared);
    assert.deepEqual(final.originals.map(item => item.original_text), originals.map(item => item.original_text));
    assert.equal(h.coldCurrent(f)?.contract, h.contract);
    const catalog = workers[0].payload.catalog.read_path, bytes = fs.readFileSync(catalog);
    try { fs.appendFileSync(catalog, ' '); assert.equal(h.coldCurrent(f), null); }
    finally { fs.writeFileSync(catalog, bytes); }
    assert.equal(h.coldCurrent(f)?.contract, h.contract);
  });
});

test('required view justifies support and keeps unrelated complement optional with exact aliases', () => {
  const a = authority(), s = snapshot(a);
  a.assertSemanticSnapshot(s);
  const worker = s.assignments[1], unrelated = s.obligations.find(item => item.path === 'other/unrelated.cjs');
  assert.ok(!worker.support_obligation_ids.includes(unrelated.id));
  for (const alias of ['src/provider.cjs', 'src/provider-alias.cjs']) {
    const obligation = s.obligations.find(item => item.path === alias);
    assert.ok(worker.support_obligation_ids.includes(obligation.id));
    assert.ok(worker.support_reasons[obligation.id].some(reason => reason.kind === 'dependency-seam'));
  }
  for (const assignment of s.assignments) {
    assert.ok(assignment.support_reasons['global-criterion'].some(reason => reason.kind === 'global-governing-criterion'));
    assert.ok(assignment.required_criteria_obligation_ids.includes('global-criterion'));
  }
  assert.ok(s.seams.every(seam => s.independent_final_seam_ids.includes(seam.id)));
  assert.ok(s.cross_responsibility_seam_ids.length);
  assert.ok(worker.required_seam_ids.length < s.seams.length);
});

function appendSource(inv, file, content) {
  const source = { source_id: 's-' + hash(content), sha256: hash(content), bytes: Buffer.byteLength(content),
    content, path: file, kind: 'source', revision: 'head',
    aliases: [{ path: file, pointer: file.startsWith('/') ? file : '/sources/extra/content', kind: 'source', revision: 'head' }] };
  inv.material.push(source);
  inv.obligations.push({ id: 'o-' + hash(file), path: file, pointer: source.aliases[0].pointer,
    source_id: source.source_id, sha256: source.sha256, kind: 'logical-completion' });
  return source;
}

test('aggregate diff container retains complete evidence without pseudo imports or dynamic edges', () => {
  const a = authority(), inv = inventory(), baseline = a.semanticResponsibilities(inv, []);
  const aggregate = appendSource(inv, '/role_context/exact_diff/content',
    "diff --git a/src/caller.cjs b/src/caller.cjs\n+require('./unretained.cjs');\n+require(resolvePlugin());\n");
  const originals = structuredClone(inv), s = snapshot(a, inv, 'code-review');
  a.assertSemanticSnapshot(s);
  assert.deepEqual({ material: s.material, obligations: s.obligations }, originals);
  assert.deepEqual(s.seams, baseline.seams);
  assert.deepEqual(s.independent_final_seam_ids, baseline.independent_final_seam_ids);
  const id = inv.obligations.at(-1).id;
  assert.equal(s.assignments.filter(item => item.primary_obligation_ids.includes(id)).length, 1);
  assert.ok(s.assignments[0].required_material_source_ids.includes(aggregate.source_id));
  assert.ok(!s.assignments[1].support_obligation_ids.includes(id));
  assert.deepEqual(a.semanticRequiredView(s, null).material, originals.material);
  assert.deepEqual(a.semanticRequiredView(s, null).obligations, originals.obligations);
});

test('unrelated filename mentions in aggregate evidence do not expand mandatory source support', () => {
  const a = authority(), inv = inventory();
  const unrelated = appendSource(inv, 'tests/disconnected.test.cjs', 'exports.isolated = 42;\n');
  const aggregate = appendSource(inv, '/role_context/exact_diff/content',
    'diff --git a/tests/disconnected.test.cjs b/tests/disconnected.test.cjs\n+exports.isolated = 42;\n');
  const s = snapshot(a, inv);
  a.assertSemanticSnapshot(s);
  const producer = s.assignments[0], consumer = s.assignments[1];
  assert.ok(producer.required_material_source_ids.includes(aggregate.source_id));
  assert.ok(!producer.required_material_source_ids.includes(unrelated.source_id));
  assert.ok(consumer.required_material_source_ids.includes(unrelated.source_id));
  assert.ok(!consumer.required_material_source_ids.includes(aggregate.source_id));
  assert.equal(s.assignments.flatMap(item => item.primary_obligation_ids).length, inv.obligations.length);
});

test('support provider does not make unrelated callers and their dependencies mandatory', () => {
  const a = authority(), inv = inventory();
  const outsider = appendSource(inv, 'other/outsider.cjs',
    "require('../src/provider.cjs');\nrequire('./unrelated.cjs');\nrequire(resolveUnrelated());\n");
  const s = snapshot(a, inv);
  a.assertSemanticSnapshot(s);
  const worker = s.assignments[1], owner = s.assignments[0];
  assert.ok(worker.required_material_source_ids.includes(inv.material[0].source_id));
  assert.ok(!worker.required_material_source_ids.includes(outsider.source_id));
  assert.ok(!worker.required_material_source_ids.includes(inv.material[2].source_id));
  const edge = s.seams.find(item => item.consumer === outsider.path && item.producer === 'src/provider.cjs');
  assert.ok(edge);
  assert.ok(!worker.required_seam_ids.includes(edge.id));
  assert.ok(owner.required_seam_ids.includes(edge.id));
  assert.ok(owner.required_context.some(item => item.source_path === outsider.path));
  assert.ok(!worker.required_context.some(item => item.source_path === outsider.path));
  assert.ok(s.independent_final_seam_ids.includes(edge.id));
  assert.ok(s.cross_responsibility_seam_ids.length);
});

test('required support retains its actual dependency chain and unknown target context', () => {
  const a = authority(), inv = inventory();
  const dependency = appendSource(inv, 'lib/value.cjs', "exports.value = require('./not-retained.cjs');\n");
  const provider = inv.material[0], previous = provider.source_id;
  provider.content += "require('../lib/value.cjs');\n";
  provider.sha256 = hash(provider.content); provider.source_id = 's-' + provider.sha256;
  provider.bytes = Buffer.byteLength(provider.content);
  for (const obligation of inv.obligations.filter(item => item.source_id === previous)) {
    obligation.source_id = provider.source_id; obligation.sha256 = provider.sha256;
  }
  const s = snapshot(a, inv);
  a.assertSemanticSnapshot(s);
  const worker = s.assignments[1], obligation = inv.obligations.find(item => item.path === dependency.path);
  assert.ok(worker.required_material_source_ids.includes(dependency.source_id));
  assert.ok(worker.support_reasons[obligation.id].some(reason => reason.kind === 'dependency-seam'
    && reason.required_by_obligation_id));
  assert.ok(worker.required_context.some(item => item.source_path === dependency.path && item.target === 'lib/not-retained.cjs'));
  assert.deepEqual(a.semanticRequiredView(s, null).seams, s.seams);
});

test('each derivation rebuilds mappings from current aliases and bytes without identity reuse', () => {
  const a = authority(), inv = inventory(), before = a.semanticResponsibilities(inv, []);
  const source = appendSource(inv, 'lib/fresh.cjs', "exports.fresh = require('../src/provider.cjs');\n");
  const after = a.semanticResponsibilities(inv, []);
  assert.ok(!before.seams.some(item => item.consumer === source.path));
  assert.ok(after.seams.some(item => item.consumer === source.path && item.producer === 'src/provider.cjs'));
  source.aliases[0].path = '/role_context/fresh/content';
  inv.obligations.at(-1).path = source.aliases[0].path;
  const derived = a.semanticResponsibilities(inv, []);
  assert.ok(!derived.seams.some(item => item.consumer === source.path || item.consumer === source.aliases[0].path));
  assert.deepEqual(derived.seams, before.seams);
});

test('support retains one concrete witness per justification kind and every required seam', () => {
  const a = authority(), inv = inventory();
  appendSource(inv, 'tests/first.test.cjs', "exports.first = require('../src/provider.cjs');\n");
  appendSource(inv, 'tests/second.test.cjs', "exports.second = require('../src/provider.cjs');\n");
  const s = snapshot(a, inv);
  a.assertSemanticSnapshot(s);
  const worker = s.assignments[1], provider = inv.obligations.find(item => item.path === 'src/provider.cjs');
  const reasons = worker.support_reasons[provider.id];
  assert.equal(new Set(reasons.map(reason => reason.kind)).size, reasons.length);
  assert.ok(reasons.some(reason => reason.kind === 'dependency-seam'));
  assert.ok(reasons.every(reason => reason.obligation_id === provider.id
    && reason.source_id === provider.source_id && reason.path === provider.path && reason.pointer === provider.pointer));
  const callers = s.seams.filter(seam => seam.producer === provider.path);
  assert.ok(callers.some(seam => seam.consumer === 'tests/first.test.cjs'));
  assert.ok(callers.some(seam => seam.consumer === 'tests/second.test.cjs'));
  for (const seam of callers) assert.ok(worker.required_seam_ids.includes(seam.id));
  assert.deepEqual(s.independent_final_seam_ids, s.seams.map(seam => seam.id));
});

function resultFixture(a, final = false) {
  const s = snapshot(a);
  s.subject = 'fixture'; s.identity = { phase: '53', head: 'head', head_tree: 'head-tree', base_ref: 'main',
    base_tree: 'base-tree', ticket_set: [], ticket_set_digest: 'members' };
  delete s.snapshot_sha256; s.snapshot_sha256 = hash(a.stable(s));
  const assignment = final ? null : s.assignments[1], view = a.semanticRequiredView(s, assignment);
  const payload = { schema: s.review_contract, review_contract: s.review_contract,
    role: s.role, runtime: s.runtime, stage: final ? 'final' : 'worker', subject: s.subject,
    snapshot_sha256: s.snapshot_sha256, reviewed_identity: s.identity, ...view, assignment, material: view.material };
  payload.binding_sha256 = hash(a.stable(payload));
  const input = '<AUTHENTICATED_SEMANTIC_REVIEW>\n' + a.stable(payload) + '\n</AUTHENTICATED_SEMANTIC_REVIEW>';
  const launch = { responsibility_view_version: VIEW, assignment_id: assignment?.id || null,
    stage: final ? 'final' : 'worker', binding_sha256: payload.binding_sha256, input, input_sha256: hash(input), originals: [] };
  const result = { schema: s.review_contract, review_contract: s.review_contract, role: s.role, stage: launch.stage,
    runtime: s.runtime, subject: s.subject, snapshot_sha256: s.snapshot_sha256, assignment_id: launch.assignment_id,
    binding_sha256: launch.binding_sha256, reviewed_identity: s.identity, completeness: 'complete', outcome: 'passed',
    blocking_count: 0, findings: [], conclusions: ['Actual endpoints inspected.'], limitations: [], required_context: [], unread: [],
    coverage: assignment?.primary_obligation_ids || view.obligation_ids, originals: [], evidence_markdown: 'Complete original report.',
    seams: view.seams.map(item => ({ id: item.id, disposition: 'resolved', rationale: 'Actual endpoint contract agrees.' })),
    ...(final ? { phase: s.identity.phase, head: s.identity.head, head_tree: s.identity.head_tree,
      base: s.identity.base_ref, base_tree: s.identity.base_tree, ticket_set: [], ticket_set_digest: 'members' } : {}) };
  return { s, payload, launch, result, record: { snapshot: s } };
}

for (const final of [false, true]) test((final ? 'final' : 'worker') + ' validates its exact seam view without shrinking global final coverage', () => {
  const a = authority(), f = resultFixture(a, final);
  assert.equal(a.validateSemanticResult(f.result, f.launch, f.record), f.result);
  const original = structuredClone(f.result);
  f.result.seams.pop();
  assert.throws(() => a.validateSemanticResult(f.result, f.launch, f.record), /dependency seam/);
  f.result = structuredClone(original); f.result.seams.push(structuredClone(f.result.seams[0]));
  assert.throws(() => a.validateSemanticResult(f.result, f.launch, f.record), /dependency seam/);
  f.result = structuredClone(original);
  if (!final) {
    f.result.seams = f.s.seams.map(item => ({ id: item.id, disposition: 'resolved', rationale: 'Wrong global echo.' }));
    assert.throws(() => a.validateSemanticResult(f.result, f.launch, f.record), /dependency seam/);
  }
});

for (const field of ['assignment', 'obligations', 'material', 'seams', 'required_context', 'responsibility_view_version'])
  test('rebound launch refuses tampered required ' + field, () => {
    const a = authority(), f = resultFixture(a);
    f.payload = structuredClone(f.payload);
    if (field === 'responsibility_view_version') f.payload[field] = 'unknown';
    else if (field === 'assignment') f.payload.assignment.support_reasons = {};
    else f.payload[field] = ['foreign'];
    delete f.payload.binding_sha256; f.payload.binding_sha256 = hash(a.stable(f.payload));
    f.launch.binding_sha256 = f.payload.binding_sha256;
    f.launch.input = '<AUTHENTICATED_SEMANTIC_REVIEW>\n' + a.stable(f.payload) + '\n</AUTHENTICATED_SEMANTIC_REVIEW>';
    f.launch.input_sha256 = hash(f.launch.input);
    assert.throws(() => a.assertSemanticLaunchView(f.launch, f.record));
  });

test('previous view records retain their genuine global worker seam contract', () => {
  const a = authority(), f = resultFixture(a);
  for (const key of ['responsibility_view_version', 'responsibility_tickets', 'independent_final_seam_ids', 'cross_responsibility_seam_ids'])
    delete f.s[key];
  for (const assignment of f.s.assignments) {
    for (const key of ['support_reasons', 'required_material_source_ids', 'required_criteria_obligation_ids', 'required_seam_ids', 'required_context'])
      delete assignment[key];
    assignment.support_obligation_ids = f.s.obligations.filter(item => item.governing
      || !assignment.primary_obligation_ids.includes(item.id)).map(item => item.id);
  }
  delete f.s.snapshot_sha256; f.s.snapshot_sha256 = hash(a.stable(f.s));
  f.result.snapshot_sha256 = f.s.snapshot_sha256;
  a.assertSemanticSnapshot(f.s);
  f.result.seams = f.s.seams.map(item => ({ id: item.id, disposition: 'resolved', rationale: 'Original global contract.' }));
  assert.equal(a.validateSemanticResult(f.result, f.launch, f.record), f.result);
  f.result.seams.pop();
  assert.throws(() => a.validateSemanticResult(f.result, f.launch, f.record));
});

for (const outcome of ['incomplete', 'blocked', 'unread', 'limitations', 'required_context'])
  test('required view preserves original ' + outcome + ' without completion credit', () => {
    const a = authority(), f = resultFixture(a);
    if (['incomplete', 'blocked'].includes(outcome)) f.result.completeness = outcome;
    else f.result[outcome] = outcome === 'unread' ? [f.result.coverage[0]] : ['Original unresolved context.'];
    assert.equal(a.validateSemanticResult(f.result, f.launch, f.record), f.result);
    assert.equal(a.semanticComplete(f.result), false);
  });

for (const change of ['support', 'reason', 'material', 'seam', 'criteria', 'duplicate primary', 'missing primary', 'alias', 'version', 'removed version'])
  test('snapshot refuses rehashed ' + change + ' view tampering', () => {
    const a = authority(), s = snapshot(a), worker = s.assignments[1];
    if (change === 'support') worker.support_obligation_ids.push(s.obligations.find(item => item.path === 'other/unrelated.cjs').id);
    if (change === 'reason') worker.support_reasons = {};
    if (change === 'material') worker.required_material_source_ids.pop();
    if (change === 'seam') worker.required_seam_ids = [];
    if (change === 'criteria') worker.required_criteria_obligation_ids = [];
    if (change === 'duplicate primary') worker.primary_obligation_ids.push(s.assignments[0].primary_obligation_ids[0]);
    if (change === 'missing primary') worker.primary_obligation_ids.pop();
    if (change === 'alias') s.material[0].aliases[0].path = 'forged.cjs';
    if (change === 'version') s.responsibility_view_version = 'unknown';
    if (change === 'removed version') delete s.responsibility_view_version;
    delete s.snapshot_sha256; s.snapshot_sha256 = hash(a.stable(s));
    assert.throws(() => a.assertSemanticSnapshot(s));
  });

test('unknown imports and scoped acceptance references retain required context and concrete support reasons', () => {
  const a = authority(), inv = inventory();
  const source = inv.material[1];
  const previous = source.source_id;
  source.content += "require(resolvePlugin());\nrequire('./missing.cjs');\n";
  source.sha256 = hash(source.content); source.source_id = 's-' + source.sha256;
  source.bytes = Buffer.byteLength(source.content);
  for (const obligation of inv.obligations.filter(item => item.source_id === previous)) {
    obligation.source_id = source.source_id; obligation.sha256 = source.sha256;
  }
  inv.obligations.push({ id: 'test-criterion', path: 'tests/provider.test.cjs', pointer: '/acceptance/0',
    governing: true, kind: 'contract-item', value: 'Verify src/provider.cjs.' });
  const s = snapshot(a, inv);
  a.assertSemanticSnapshot(s);
  assert.ok(s.seams.some(item => item.uncertain));
  assert.ok(s.assignments[1].required_context.some(item => item.source_path === 'src/caller.cjs'));
  assert.ok(s.assignments[0].support_reasons['test-criterion'].some(reason => reason.kind === 'scoped-criterion'));
});

test('ticket dependencies retain concrete ownership, criteria and unknown dependency context', () => {
  const a = authority(), inv = inventory();
  inv.obligations.push({ id: 'ticket-criterion', path: '.planning/53-02-PLAN.md', pointer: '/acceptance/0',
    governing: true, kind: 'contract-item', value: 'The exported behavior is preserved.' });
  const rows = [{ id: 'T-53-01', row: { files: ['src/provider.cjs'], depends_on: [] } },
    { id: 'T-53-02', row: { files: ['src/caller.cjs'], plan: '.planning/53-02-PLAN.md', depends_on: ['T-53-01', 'T-53-UNKNOWN'] } }];
  const scope = a.semanticResponsibilities(inv, rows);
  assert.ok(scope.seams.some(item => item.producer === 'T-53-01' && item.consumer === 'T-53-02'));
  assert.ok(scope.assignments[1].required_context.some(item => item.target === 'T-53-UNKNOWN'));
  assert.ok(scope.assignments[1].support_reasons['ticket-criterion'].some(reason => reason.kind === 'scoped-criterion'));
});

for (const mutation of ['unresolved worker seam', 'missing final global seam', 'original required context', 'native resource failure'])
  test('ordinary independent final refuses ' + mutation + ' and retains original evidence', async () => {
    const h = load('tests/unit/phase53-codex-integration.test.cjs',
      'publicIntegrationFixture, semanticFixture, supportedPartitionCaller, captureOriginals, coldCurrent');
    await h.publicIntegrationFixture(async f => {
      const prepared = h.semanticFixture(f, { result(result, payload) {
        if (payload.stage === 'final') {
          if (mutation === 'missing final global seam') result.seams.pop();
          return;
        }
        result.findings = [{ id: 'INFO-SUPPORT', type: 'informational', blocking: false,
          summary: 'Original required view observation.', evidence: 'src/provider.cjs:1', ticket: null }];
        if (mutation === 'unresolved worker seam') result.seams[0].disposition = 'unresolved';
        if (mutation === 'original required context') {
          result.completeness = 'blocked'; result.required_context = ['Actual caller remains unread.'];
          result.limitations = ['Original context limitation.']; result.unread = [result.coverage[0]];
        }
      }, native(rows, payload) {
        if (mutation === 'native resource failure' && payload.stage === 'worker')
          rows.splice(-2, 0, { type: 'event_msg', payload: { type: 'input_truncated' } });
      } });
      await assert.rejects(h.supportedPartitionCaller(f, 'codex', prepared.options));
      assert.equal(prepared.launches.at(-1).payload.stage, 'final');
      const originals = h.captureOriginals(f, prepared);
      for (const original of originals) {
        assert.equal(original.result.findings[0].id, 'INFO-SUPPORT');
        if (mutation === 'original required context') {
          assert.equal(original.result.completeness, 'blocked');
          assert.deepEqual(original.result.required_context, ['Actual caller remains unread.']);
          assert.deepEqual(original.result.limitations, ['Original context limitation.']);
          assert.equal(original.result.unread.length, 1);
        }
        if (mutation === 'native resource failure') assert.ok(original.native.resource_failure);
      }
      assert.equal(h.coldCurrent(f), null);
    });
  });

for (const runtime of ['codex', 'claude']) for (const role of ['arch-review', 'code-review'])
  test(runtime + '/' + role + ' ordinary interfaces preserve scoped views, INFO and cold independent final authority', async () => {
    const codex = load('tests/unit/phase53-codex-architecture.test.cjs',
      'architectureFixture, ordinaryArchitecture, publicIntegrationFixture', "test('caller architecture");
    const claude = load('tests/unit/phase53-claude-review.test.cjs', 'nativeFixture, ordinary', "for (const role of ['integrator'");
    const code = load('tests/unit/phase53-code-review.test.cjs', 'fixture, setup, current', "for (const runtime of ['codex', 'claude'])");
    await codex.publicIntegrationFixture(async f => {
      if (role === 'code-review') code.setup(f);
      const controls = { native(rows) {
        if (runtime === 'codex') {
          const index = rows.findIndex(row => row.payload?.type === 'token_count');
          if (index >= 0) rows.splice(index, 1);
        }
      }, result(result) {
        result.findings = role === 'code-review'
          ? [{ id: 'INFO-SCOPE', severity: 'INFO', summary: 'Original support observation.' }]
          : [{ id: 'INFO-SCOPE', type: 'informational', blocking: false,
            summary: 'Original support observation.', evidence: 'src/provider.cjs:1', ticket: null }];
      } };
      const prepared = role === 'code-review' ? code.fixture(f, runtime, controls)
        : runtime === 'codex' ? codex.architectureFixture(f, controls) : claude.nativeFixture(f, role, controls);
      const completed = role === 'code-review' ? await prepared.run()
        : runtime === 'codex' ? await codex.ordinaryArchitecture(f, prepared) : await claude.ordinary(f, role, prepared);
      assert.equal(completed.result.review_contract, 'shipyard.semantic-review.v1');
      assert.equal(prepared.launches.length, 3);
      const final = prepared.launches[2].payload;
      for (const worker of prepared.launches.slice(0, 2)) assertViews(worker.payload, final);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      for (const original of final.originals) {
        const worker = prepared.launches.find(item => item.payload.assignment?.id === original.reference.assignment_id);
        assert.equal(original.original_text, worker.text || worker.originalText);
        assert.equal(original.result.findings[0].id, 'INFO-SCOPE');
        assert.equal(original.native.accounting.status, 'unknown');
        assert.equal(original.native.resource_failure, null);
      }
      if (role === 'code-review') assert.ok(code.current(f)?.authenticated);
      else {
        const file = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
        const cached = require.cache[file]; delete require.cache[file];
        try { assert.ok(require(file).currentArchitectureVerdict({ worktreePath: f.worktree, graphDir: f.graphDir,
          pr: f.pr.number, head: f.head, baseName: 'main', baseCommit: f.base, headBranch: f.pr.headRefName })?.authenticated); }
        finally { require.cache[file] = cached; }
      }
    });
  });

test('real isolated builder preserves exact authority bytes, modes and both content-derived manifests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-z15-build-'));
  try {
    require('../../scripts/package-shipyard-codex.cjs').build(directory);
    for (const relative of ['host/plugins/delivery-pipeline/scripts/role-artifact.cjs', '.codex-plugin/plugin.json', 'package-build.json']) {
      const candidate = path.join(directory, relative), shipped = path.join(ROOT, 'plugins/shipyard', relative);
      assert.deepEqual(fs.readFileSync(shipped), fs.readFileSync(candidate), relative);
      assert.equal(fs.statSync(shipped).mode & 0o777, fs.statSync(candidate).mode & 0o777);
    }
    const a = authority(), staged = authority(path.join(directory, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs'));
    const s = snapshot(a);
    assert.deepEqual(staged.semanticResponsibilities(inventory(), []), a.semanticResponsibilities(inventory(), []));
    staged.assertSemanticSnapshot(s);
    s.assignments[1].required_material_source_ids = [];
    delete s.snapshot_sha256; s.snapshot_sha256 = hash(a.stable(s));
    assert.throws(() => staged.assertSemanticSnapshot(s));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
