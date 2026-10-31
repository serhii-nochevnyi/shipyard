'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const PLUGIN = path.join(ROOT, 'plugins/delivery-pipeline');
const SCRIPTS = path.join(PLUGIN, 'scripts');
const ARTIFACT = path.join(SCRIPTS, 'role-artifact.cjs');
const BASE = '465b7be95e0a1d99355371ad8b97c7752db14866';
const BOUND = 1048576;
const OMIT = ['required_material_source_ids', 'required_criteria_obligation_ids', 'required_seam_ids', 'required_context'];
const cases = [];
const test = (title, run) => cases.push({ title, run });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = require(path.join(SCRIPTS, 'model-policy-internal.cjs')).stableStringify;
const clone = value => JSON.parse(JSON.stringify(value));
const unique = values => {
  const seen = new Set();
  return values.filter(value => {
    const key = stable(value);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
};
function compile(file, source) {
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(source, file);
  return loaded.exports;
}
function fixtures(name, end, names) {
  const file = path.join(__dirname, name), text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(end));
  const original = Module._load;
  try {
    Module._load = function(request, ...args) {
      return request === 'node:test' ? { test() {}, describe() {} } : original.call(this, request, ...args);
    };
    return compile(file, text.slice(0, text.indexOf(end)) + '\nmodule.exports = { ' + names + ' };');
  } finally { Module._load = original; }
}
function historicalSource() {
  const source = execFileSync('git', ['show', BASE + ':plugins/delivery-pipeline/scripts/role-artifact.cjs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(hash(source), '52e676c0d76e5e81a68a1040f03eac03b773211bde36204b271a934160e8a4cd');
  return source;
}
function setup(legacy = false) {
  for (const file of Object.keys(require.cache)) if (file.startsWith(PLUGIN + path.sep)
      || file.includes('/tests/fixtures/phase53/')) delete require.cache[file];
  const home = fs.realpathSync(process.env.HOME);
  assert.ok(path.basename(home).startsWith('z19-case-'));
  const plugin = fs.mkdtempSync(path.join(home, 'producer-'));
  fs.cpSync(PLUGIN, plugin, { recursive: true });
  const artifact = path.join(plugin, 'scripts/role-artifact.cjs');
  const smoke = fixtures('../smoke/phase53-review-acceptance.cjs', 'async function observeRetirement', 'routePayload');
  const restoreRoute = smoke.routePayload(plugin);
  const api = legacy ? compile(artifact, historicalSource()) : require(artifact), snapshots = [], stages = [];
  const original = Module._load;
  const observed = { ...api, prepareSemanticReview(...args) {
    const snapshot = api.prepareSemanticReview(...args);
    snapshots.push({ snapshot, before: stable(snapshot) });
    return snapshot;
  }, prepareSemanticWorker(...args) {
    const stage = api.prepareSemanticWorker(...args); stages.push(stage); return stage;
  }, prepareSemanticFinal(...args) {
    const stage = api.prepareSemanticFinal(...args); stages.push(stage); return stage;
  } };
  Module._load = function(request, parent, ...args) {
    if (request !== 'node:test' && Module._resolveFilename(request, parent) === artifact) return observed;
    return original.call(this, request, parent, ...args);
  };
  try {
    const integration = fixtures('phase53-codex-integration.test.cjs', "test('ordinary Codex caller",
      'publicIntegrationFixture, semanticFixture, supportedPartitionCaller, write, commit');
    const codex = fixtures('phase53-codex-architecture.test.cjs', "test('caller architecture",
      'architectureFixture, ordinaryArchitecture');
    const claude = fixtures('phase53-claude-review.test.cjs', "for (const role of ['integrator'", 'nativeFixture, ordinary');
    const code = fixtures('phase53-code-review.test.cjs', "for (const runtime of ['codex', 'claude']) {", 'fixture, setup');
    return { api, artifact, plugin, home, integration, snapshots, stages,
      restore() { Module._load = original; restoreRoute(); }, ordinary(f, runtime, role, controls) {
      if (role === 'code-review') { code.setup(f); return code.fixture(f, runtime, controls); }
      const prepared = runtime === 'claude' ? claude.nativeFixture(f, role, controls)
        : role === 'integrator' ? integration.semanticFixture(f, controls) : codex.architectureFixture(f, controls);
      prepared.run = () => runtime === 'claude' ? claude.ordinary(f, role, prepared)
        : role === 'integrator' ? integration.supportedPartitionCaller(f, runtime, prepared.options)
          : codex.ordinaryArchitecture(f, prepared);
      return prepared;
    } };
  } catch (error) { Module._load = original; restoreRoute(); throw error; }
}
function fixturePath(h, f, file) {
  const target = path.resolve(file);
  const inside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const roots = [h.home, fs.realpathSync(f.root)];
  const root = roots.find(root => inside(root, target));
  assert.ok(root, 'negative write must be in a physical fixture home: ' + target);
  let parent = target;
  let stat;
  for (;;) {
    try { stat = fs.lstatSync(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(parent); }
  }
  assert.equal(stat.isSymbolicLink(), false, 'a dangling link cannot authorize a fixture write');
  assert.equal(fs.realpathSync(parent), parent, 'no symlink escape before a negative write');
  assert.ok(inside(root, fs.realpathSync(parent)), 'physical target ancestry remains fixture-owned');
  return target;
}
function wire(launch) {
  return JSON.parse((launch.input || launch.prompt).match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
}
function rewrite(stage, change) {
  const payload = wire(stage); change(payload);
  delete payload.binding_sha256;
  payload.binding_sha256 = hash(stable(payload));
  const input = stage.input.replace(/<AUTHENTICATED_SEMANTIC_REVIEW>\n[\s\S]*$/, '<AUTHENTICATED_SEMANTIC_REVIEW>\n'
    + stable(payload) + '\n</AUTHENTICATED_SEMANTIC_REVIEW>');
  return { ...stage, input, input_sha256: hash(input), binding_sha256: payload.binding_sha256 };
}
function refused(run, label) {
  let value;
  try { value = run(); } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    return;
  }
  assert.equal(value, null, label);
}
function inputFor(f) {
  return { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
    head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName };
}
const consumer = role => ({ integrator: 'currentIntegrationVerdict', 'arch-review': 'currentArchitectureVerdict',
  'code-review': 'currentCodeReviewVerdict' })[role];
function current(api, f, role) { return api[consumer(role)](inputFor(f)); }
function cold(f, role, artifact = ARTIFACT, originals) {
  const child = spawnSync(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[4];
    const api = require(process.argv[1]), input = JSON.parse(process.argv[3]);
    const originals = JSON.parse(process.argv[5]);
    try {
      const value = originals ? originals.map(reference => api.readSemanticOriginal({ worktreePath: input.worktreePath,
        snapshot_sha256: reference.snapshot_sha256, assignment_id: reference.assignment_id })) : api[process.argv[2]](input);
      process.stdout.write(JSON.stringify(value));
    } catch (error) {
      if (originals) throw error;
      process.stdout.write('null');
    }`, artifact, consumer(role), JSON.stringify(inputFor(f)), f.root,
  JSON.stringify(originals || null)], { env: { ...process.env }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function staged(f) {
  const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(f.root, 'candidate'));
  const file = path.join(candidate, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs');
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(ARTIFACT));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(require.cache[file], undefined);
  const api = require(file);
  assert.notEqual(api, require(ARTIFACT));
  return { file, api };
}
function addSources(h, f, common = 5, separate = 2, length = 120) {
  const imports = (prefix, count) => Array.from({ length: count }, (_, index) =>
    "require('./external/" + (prefix + '-' + index + '/').padEnd(length, 'x') + ".cjs');\n").join('');
  const shared = imports('shared', common);
  h.integration.write(f.worktree, 'src/read-marker.cjs', 'exports.originalRead = true;\n');
  const provider = "require('./shared.cjs');\nexports.value = 1;\n" + imports('producer', separate);
  const caller = "require('./shared.cjs');\nexports.value = 1;\n" + imports('consumer', separate);
  for (const [name, content] of [['shared', shared], ['provider', provider], ['consumer', caller]])
    h.integration.write(f.worktree, 'src/' + name + '.cjs', content);
  for (const row of Object.values(f.rows)) {
    const file = path.join(f.worktree, row.plan);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Complete merged behavior.', 'Complete merged behavior at src/shared.cjs.'));
  }
  h.integration.commit(f, 'fixture complete dependency metadata');
  return hash(shared + provider + caller);
}
function addReads(runtime, rows, payload, f) {
  const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
  if (runtime === 'codex') {
    const captured = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
    const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
    const packet = wire({ input: rows.find(row => row.payload?.role === 'user')
      .payload.content.map(block => block.text || '').join('') });
    for (const [index, item] of [...packet.material, ...packet.originals].entries()) {
      const call = template(captured, row => row.payload?.type === 'function_call');
      Object.assign(call.payload, { name: 'exec_command', call_id: 'z19-read-' + index,
        arguments: JSON.stringify({ cmd: 'cat ' + JSON.stringify(item.read_path), max_output_tokens: 5000 }),
        internal_chat_message_metadata_passthrough: { turn_id: turn } });
      delete call.payload.namespace;
      const output = template(captured, row => row.payload?.type === 'function_call_output');
      Object.assign(output.payload, { call_id: call.payload.call_id,
        output: JSON.stringify({ exit_code: 0, output: fs.readFileSync(item.read_path, 'utf8') }),
        internal_chat_message_metadata_passthrough: { turn_id: turn } });
      rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, call, output);
    }
  } else {
    const tool = rows.find(row => row.message?.content?.[0]?.name === 'Read');
    const response = rows.find(row => row.message?.content?.[0]?.type === 'tool_result');
    assert.ok(tool && response);
    const prompt = typeof rows[0].message.content === 'string' ? rows[0].message.content
      : rows[0].message.content.map(block => block.text || '').join('');
    const packet = wire({ prompt });
    for (const [index, item] of [...packet.material, ...packet.originals].entries()) {
      const read = clone(tool), output = clone(response);
      read.message.content[0].id = 'z19-read-' + index;
      read.message.content[0].input.file_path = item.read_path;
      output.message.content[0].tool_use_id = read.message.content[0].id;
      output.message.content[0].content = fs.readFileSync(item.read_path, 'utf8');
      rows.splice(rows.length - 1, 0, read, output);
    }
  }
}
function controls(runtime, f) {
  return { native(rows, payload) {
    addReads(runtime, rows, payload, f);
    if (runtime === 'codex') rows.splice(rows.findIndex(row => row.payload?.type === 'token_count'), 1);
  }, result(result, payload) {
    result.conclusions.push('Full original ' + (payload.assignment?.id || 'final') + ' reason: ' + 'reason '.repeat(300));
    result.evidence_markdown += '\nOriginal INFO and independent reasoning retained.\n';
    result.findings.push(payload.role === 'code-review'
      ? { id: 'Z19-INFO', severity: 'INFO', summary: 'Complete original informational observation.' }
      : { id: 'Z19-INFO', type: 'informational', blocking: false, summary: 'Complete original informational observation.',
        evidence: 'src/provider.cjs:1', ticket: null });
    result.conclusions.push('Original disagreement for ' + (payload.assignment?.id || 'final')
      + ': the other responsibility needs its own complete caller evidence before agreeing.');
  } };
}
function finalOriginalControls(f) {
  const control = controls('codex', f), native = control.native;
  control.native = (rows, payload) => {
    native(rows, payload);
    if (payload.stage !== 'worker') return;
    const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
    const captured = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
    const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
    const content = fs.readFileSync(path.join(f.worktree, 'src/read-marker.cjs'), 'utf8');
    for (let index = 0; index < 1792; index++) {
      const call = template(captured, row => row.payload?.type === 'function_call');
      Object.assign(call.payload, { name: 'exec_command', call_id: 'z19-original-evidence-' + index,
        arguments: JSON.stringify({ cmd: 'cat src/read-marker.cjs' }),
        internal_chat_message_metadata_passthrough: { turn_id: turn } });
      delete call.payload.namespace;
      const output = template(captured, row => row.payload?.type === 'function_call_output');
      Object.assign(output.payload, { call_id: call.payload.call_id, output: JSON.stringify({ exit_code: 0, output: content }),
        internal_chat_message_metadata_passthrough: { turn_id: turn } });
      rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, call, output);
    }
  };
  return control;
}
function assertPackets(h, prepared, canonical = true) {
  assert.equal(h.snapshots.length, 1);
  const { snapshot, before } = h.snapshots[0];
  assert.equal(stable(snapshot), before);
  assert.equal(hash(stable(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'snapshot_sha256')))), snapshot.snapshot_sha256);
  assert.equal(prepared.launches.length, 3);
  for (const stage of h.stages) assert.deepEqual(h.api.semanticLaunchSnapshot(stage), snapshot);
  for (const launch of prepared.launches) {
    const packet = wire(launch), assignment = snapshot.assignments.find(item => item.id === packet.assignment?.id);
    assert.ok(Buffer.byteLength(launch.input || launch.prompt) <= BOUND);
    if (assignment) {
      const projected = Object.fromEntries(Object.entries(assignment).filter(([key]) => !OMIT.includes(key)));
      assert.deepEqual(packet.assignment, canonical ? projected : assignment);
      assert.deepEqual(packet.required_context, assignment.required_context);
      assert.deepEqual(packet.material.map(item => item.source_id), assignment.required_material_source_ids);
      assert.deepEqual(packet.seams.map(item => item.id), assignment.required_seam_ids);
      assert.deepEqual(packet.obligations.filter(item => !item.source_id).map(item => item.id), assignment.required_criteria_obligation_ids);
      assert.deepEqual(packet.assignment.support_reasons, assignment.support_reasons);
      for (const key of OMIT) assert.ok(Object.hasOwn(assignment, key));
    } else {
      assert.equal(packet.assignment, null);
      const all = snapshot.assignments.flatMap(item => item.required_context);
      assert.ok(all.length > unique(all).length, 'both complete responsibility contexts overlap');
      assert.deepEqual(packet.required_context, canonical ? unique(all) : all);
      assert.deepEqual(packet.seams, snapshot.seams);
      assert.deepEqual(packet.obligations, snapshot.obligations);
      assert.deepEqual(packet.role === 'code-review' && packet.stage === 'final'
        ? packet.seams.map(item => item.id) : packet.independent_final_seam_ids, snapshot.independent_final_seam_ids);
      assert.deepEqual(packet.cross_responsibility_seam_ids, snapshot.cross_responsibility_seam_ids);
      assert.equal(packet.originals.length, 2);
      for (const item of packet.originals) {
        const original = h.api.readSemanticOriginal({ worktreePath: snapshot.identity.worktree,
          snapshot_sha256: snapshot.snapshot_sha256, assignment_id: item.reference.assignment_id });
        const worker = prepared.launches.find(row => row.payload.assignment?.id === item.reference.assignment_id);
        assert.equal(fs.readFileSync(item.read_path, 'utf8'), worker.text || worker.originalText);
        assert.equal(original.original_text, worker.text || worker.originalText);
        assert.deepEqual(original.result, worker.result);
        assert.equal(original.result.findings[0].id, 'Z19-INFO');
        assert.equal(original.native.resource_failure, null);
        assert.equal(original.native.accounting.status, 'unknown');
        assert.equal(original.native.reads.incomplete.length, 0);
        assert.equal(original.native.reads.semantic_credit, false);
        assert.ok(original.native.reads.completed.length >= worker.payload.material.length);
        assert.deepEqual(original.result.conclusions, worker.result.conclusions);
      }
    }
    for (const item of packet.material) {
      const source = snapshot.material.find(source => source.source_id === item.source_id);
      assert.deepEqual(item.aliases, source.aliases);
      const raw = fs.readFileSync(item.read_path);
      assert.equal(raw.toString(), source.content); assert.equal(hash(raw), item.sha256);
    }
  }
  assert.equal(stable(snapshot), before, 'emission and original retention cannot mutate the full snapshot');
  return snapshot;
}
function exactViews(h, prepared, snapshot) {
  const source = fs.readFileSync(h.artifact, 'utf8');
  const check = compile(h.artifact, source + '\nmodule.exports = { assertSemanticLaunchView, semanticRequiredView, semanticInlineAssignment };');
  const final = wire(prepared.launches.at(-1));
  for (const stage of h.stages) {
    const inputs = { material: final.material, catalog: final.catalog, originals: stage.stage === 'worker' ? [] : final.originals };
    const record = { snapshot, input_transport: 'host-files' };
    check.assertSemanticLaunchView(stage, record, inputs);
    const changes = [
      packet => { delete packet.required_context; },
      packet => { delete packet.obligations; },
      packet => { packet.material.reverse(); },
      packet => { packet.obligations.reverse(); },
      packet => { packet.obligation_ids.reverse(); },
      packet => { packet.seams.reverse(); },
      packet => { packet.required_context.reverse(); },
      packet => { packet.required_context[0].reason += ' changed'; },
      packet => { packet.material[0].aliases[0].path += '.foreign'; },
      packet => { packet.material[0].source_id = 'foreign'; },
      packet => { packet.reviewed_identity.repository += 'foreign'; },
      packet => { packet.reviewed_identity.head = 'f'.repeat(40); },
      packet => { packet.reviewed_identity.base = 'e'.repeat(40); },
      packet => { packet.snapshot_sha256 = 'd'.repeat(64); },
      packet => { packet.catalog.sha256 = 'c'.repeat(64); },
      packet => { packet.foreign_context = true; },
      ...(stage.stage === 'worker' ? [
        packet => { delete packet.assignment.support_reasons; },
        packet => { packet.assignment.primary_obligation_ids.pop(); },
        packet => { packet.assignment.id = 'foreign'; },
        ...OMIT.map(key => packet => { packet.assignment[key] = snapshot.assignments.find(item => item.id === stage.assignment_id)[key]; }),
      ] : [
        packet => { packet.assignment = {}; },
        packet => { packet.originals.reverse(); },
        packet => { packet.originals[0].reference.dispatch_id += 'rebound'; },
        packet => { packet.independent_final_seam_ids.reverse(); },
        packet => { packet.cross_responsibility_seam_ids.push('foreign'); },
      ]),
    ];
    for (const change of changes) {
      const altered = rewrite(stage, change);
      assert.notEqual(altered.input, stage.input);
      assert.throws(() => check.assertSemanticLaunchView(altered, record, inputs), /semantic/);
    }
    assert.throws(() => check.assertSemanticLaunchView({ ...stage, input_sha256: '0'.repeat(64) }, record, inputs), /semantic/);
    assert.throws(() => check.assertSemanticLaunchView({ ...stage, binding_sha256: '0'.repeat(64) }, record, inputs), /semantic/);
    const legacy = rewrite(stage, packet => {
      packet.assignment = snapshot.assignments.find(item => item.id === stage.assignment_id) || null;
      packet.required_context = stage.stage === 'worker' ? packet.assignment.required_context
        : snapshot.assignments.flatMap(item => item.required_context);
    });
    assert.throws(() => check.assertSemanticLaunchView(legacy, record, inputs), /exact recorded original launch/);
  }
  const assignment = { ...snapshot.assignments[0], unknown_original_field: { whole_reason: 'Keep every extra original field.' } };
  const before = stable(assignment);
  assert.deepEqual(check.semanticInlineAssignment(assignment).unknown_original_field, assignment.unknown_original_field);
  assert.equal(stable(assignment), before);
  const context = { seam_id: 'same', reason: 'Full reason', extra: { disagreement: 'one' } };
  const reversedKeys = { extra: { disagreement: 'one' }, reason: 'Full reason', seam_id: 'same' };
  const different = { ...context, reason: 'Full reason with conflicting conclusion' };
  const extra = { ...context, extra: { disagreement: 'two' } };
  const full = { ...snapshot, assignments: [{ required_context: [context, different] },
    { required_context: [reversedKeys, extra, different] }] };
  assert.deepEqual(check.semanticRequiredView(full).required_context, [context, different, extra]);
  assert.deepEqual(full.assignments[1].required_context, [reversedKeys, extra, different]);
}
for (const runtime of ['codex', 'claude']) for (const role of ['integrator', 'arch-review', 'code-review']) {
  test(`${runtime} ${role}: canonical public originals, exact views and fresh/cold/staged custody`, async () => {
    const h = setup();
    try {
      await h.integration.publicIntegrationFixture(async f => {
        addSources(h, f);
        const prepared = h.ordinary(f, runtime, role, controls(runtime, f));
        await prepared.run();
        const snapshot = assertPackets(h, prepared);
        if (runtime === 'codex' && role === 'integrator') exactViews(h, prepared, snapshot);
        assert.ok(current(h.api, f, role)?.authenticated);
        assert.ok(cold(f, role)?.authenticated);
        const candidate = staged(f);
        assert.ok(current(candidate.api, f, role)?.authenticated);
        assert.ok(cold(f, role, candidate.file)?.authenticated);
        const references = snapshot.assignments.map(item => ({ snapshot_sha256: snapshot.snapshot_sha256, assignment_id: item.id }));
        assert.deepEqual(cold(f, role, candidate.file, references), references.map(reference => h.api.readSemanticOriginal({
          worktreePath: f.worktree, ...reference })));
        if (role !== 'integrator') return;
        const final = wire(prepared.launches.at(-1));
        const receipt = path.join(prepared.recorder.storeDir, 'record-' + hash(final.originals[0].reference.dispatch_id) + '.json');
        const retained = h.api.readSemanticOriginal({ worktreePath: f.worktree,
          snapshot_sha256: snapshot.snapshot_sha256, assignment_id: final.originals[0].reference.assignment_id });
        assert.deepEqual(retained.reference, final.originals[0].reference);
        const native = retained.native;
        const common = runtime === 'codex' ? [receipt, final.catalog.read_path, final.material[0].read_path,
          final.originals[0].read_path, path.join(f.worktree, 'src/provider.cjs'), path.join(f.graphDir, 'tickets.json'),
          ...snapshot.pins.filter(pin => pin.sha256 === snapshot.agent_sha256 || path.basename(pin.path) === 'model-policy.cjs')
            .map(pin => path.resolve(pin.root, pin.path))] : [];
        const files = [...new Set([...common, native.native_pin.path, native.output_pin.path])];
        for (const target of files) {
          const file = fixturePath(h, f, target), original = fs.readFileSync(file);
          try {
            if (file === path.join(f.graphDir, 'tickets.json')) {
              const graph = JSON.parse(original); graph.tickets[Object.keys(graph.tickets)[0]].files.push('foreign/source.cjs');
              fs.writeFileSync(fixturePath(h, f, file), JSON.stringify(graph));
            } else if (file === receipt) {
              const envelope = JSON.parse(original);
              envelope.payload.receipt.dispatch_id += '-rebound';
              fs.writeFileSync(fixturePath(h, f, file), JSON.stringify(envelope));
            } else fs.writeFileSync(fixturePath(h, f, file), Buffer.concat([original, Buffer.from('\n')]));
            refused(() => current(h.api, f, role), file);
            assert.equal(cold(f, role, candidate.file), null, file);
            if (file === native.native_pin.path || file === receipt) {
              refused(() => current(candidate.api, f, role), file);
              assert.equal(cold(f, role, h.artifact), null, file);
            }
          } finally { fs.writeFileSync(fixturePath(h, f, file), original); }
          assert.ok(current(h.api, f, role)?.authenticated, 'restored original pin: ' + file);
        }
      });
    } finally { h.restore(); }
  });
  if (role === 'integrator') test(`${runtime} ${role}: genuine complete baseline launches retain their original bindings across consumers`, async () => {
    const h = setup(true);
    try {
      await h.integration.publicIntegrationFixture(async f => {
        addSources(h, f);
        const prepared = h.ordinary(f, runtime, role, controls(runtime, f));
        await prepared.run();
        const snapshot = assertPackets(h, prepared, false);
        h.restore();
        const fresh = require(ARTIFACT), candidate = staged(f);
        assert.ok(current(fresh, f, role)?.authenticated);
        assert.ok(current(candidate.api, f, role)?.authenticated);
        assert.ok(cold(f, role)?.authenticated);
        assert.ok(cold(f, role, candidate.file)?.authenticated);
        const refs = snapshot.assignments.map(item => ({ snapshot_sha256: snapshot.snapshot_sha256, assignment_id: item.id }));
        const originals = refs.map(reference => fresh.readSemanticOriginal({ worktreePath: f.worktree, ...reference }));
        assert.deepEqual(cold(f, role, candidate.file, refs), originals);
        for (const original of originals) {
          const file = fixturePath(h, f, original.native.native_pin.path), bytes = fs.readFileSync(file);
          try {
            fs.writeFileSync(fixturePath(h, f, file), Buffer.concat([bytes, Buffer.from('\n')]));
            assert.equal(current(fresh, f, role), null);
            assert.equal(cold(f, role, candidate.file), null);
          } finally { fs.writeFileSync(fixturePath(h, f, file), bytes); }
          assert.ok(current(fresh, f, role)?.authenticated);
        }
      });
    } finally { h.restore(); }
  });
}
for (const runtime of ['codex', 'claude']) for (const failure of ['native-read', 'incomplete', 'unknown-completion'])
  test(`${runtime}: canonical originals preserve ${failure} refusal and recovery boundaries`, async () => {
    const h = setup();
    try {
      await h.integration.publicIntegrationFixture(async f => {
        addSources(h, f);
        const control = controls(runtime, f), native = control.native, result = control.result;
        const recordedResults = new Map();
        control.native = (rows, payload) => {
          native(rows, payload);
          if (payload.stage !== 'worker') return;
          if (failure === 'native-read') {
            if (runtime === 'codex') {
              const output = rows.find(row => row.payload?.call_id === 'z19-read-0' && row.payload?.output);
              assert.ok(output); output.payload.output = JSON.stringify({ exit_code: 0, truncated: true, output: 'Only a prefix' });
            } else {
              const output = rows.find(row => Array.isArray(row.message?.content) && row.message.content.some(block => block.tool_use_id === 'z19-read-0'));
              assert.ok(output); rows.splice(rows.indexOf(output), 1);
            }
          } else if (failure === 'unknown-completion') {
            const index = runtime === 'codex' ? rows.findIndex(row => row.payload?.type === 'task_complete')
              : rows.findIndex(row => row.message?.content?.[0]?.name === 'StructuredOutput');
            assert.ok(index >= 0); rows.splice(index, 1);
          }
        };
        control.result = (answer, payload) => {
          result(answer, payload);
          if (payload.stage === 'worker' && failure !== 'unknown-completion') {
            answer.completeness = 'blocked'; answer.outcome = 'human-review-required';
            answer.required_context = ['Full unresolved caller evidence remains owed.'];
            answer.unread = [answer.coverage[0]]; answer.limitations = ['Original full limitation'];
          }
          if (payload.stage === 'worker') recordedResults.set(payload.assignment.id, clone(answer));
        };
        const prepared = h.ordinary(f, runtime, 'integrator', control);
        await assert.rejects(prepared.run(), error => {
          if (runtime === 'claude' && failure === 'native-read') assert.equal(error.code, 'SEMANTIC_REVIEW_INCOMPLETE');
          return true;
        });
        assert.equal(current(h.api, f, 'integrator'), null);
        const launched = prepared.launches.length;
        if (failure === 'unknown-completion') {
          await assert.rejects(prepared.run());
          assert.equal(prepared.launches.length, launched, 'unknown originals cannot be replayed as a pass');
        } else for (const launch of prepared.launches.filter(item => item.payload.stage === 'worker')) {
          let original;
          try {
            original = h.api.readSemanticOriginal({ worktreePath: f.worktree,
              snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
          } catch (error) {
            if (runtime !== 'claude' || failure !== 'native-read') throw error;
            assert.equal(error.code, 'SEMANTIC_REVIEW_MISSING_ORIGINAL');
            assert.equal(typeof launch.session, 'string');
            const nativePath = fixturePath(h, f, path.join(f.root, 'semantic-native/project', launch.session + '.jsonl'));
            const raw = fs.readFileSync(nativePath, 'utf8');
            const rows = raw.trim().split('\n').map(JSON.parse);
            assert.ok(rows.length);
            assert.ok(rows.every(row => row.sessionId === launch.session));
            const reads = require(path.join(h.plugin, 'scripts/claude-runtime-host.cjs')).verifySemanticReads(raw, launch.session);
            assert.ok(reads.incomplete.some(item => item.call_id === 'z19-read-0' && item.reason === 'missing-output'));
            assert.equal(reads.semantic_credit, false);
            const result = rows.flatMap(row => row.message?.content || [])
              .find(block => block.name === 'StructuredOutput').input;
            const expected = recordedResults.get(launch.payload.assignment.id);
            assert.ok(expected, 'the result callback captured the complete refused worker answer');
            assert.deepEqual(result, expected);
            assert.equal(result.completeness, 'blocked');
            assert.deepEqual(result.limitations, ['Original full limitation']);
            assert.deepEqual(result.unread, [result.coverage[0]]);
            assert.ok(result.findings.some(item => item.id === 'Z19-INFO'));
            assert.ok(rows.filter(row => row.type === 'assistant').every(row => row.message.usage === undefined));
            continue;
          }
          assert.equal(original.result.completeness, 'blocked');
          assert.deepEqual(original.result.limitations, ['Original full limitation']);
          assert.deepEqual(original.result.unread, [original.result.coverage[0]]);
          assert.equal(original.native.accounting.status, 'unknown');
          if (failure === 'native-read') assert.ok(original.native.reads.incomplete.length);
        }
        const candidate = staged(f);
        assert.equal(cold(f, 'integrator'), null); assert.equal(cold(f, 'integrator', candidate.file), null);
      });
    } finally { h.restore(); }
  });
for (const kind of ['worker', 'final']) test(`complete large ${kind}: observed pinned baseline RED then canonical GREEN with both full originals`, async () => {
  const shape = kind === 'worker' ? [24, 0, 9000] : [24, 0, 7000];
  let sourceHash;
  const old = setup(true);
  try {
    await old.integration.publicIntegrationFixture(async f => {
      sourceHash = addSources(old, f, ...shape);
      const control = kind === 'final' ? finalOriginalControls(f) : controls('codex', f);
      control.barrier = false;
      const prepared = old.ordinary(f, 'codex', 'integrator', control);
      let baselineError;
      try { await prepared.run(); } catch (error) { baselineError = error; }
      process.stdout.write(JSON.stringify({ fixture: kind, baseline_error: baselineError?.code, baseline_stages: old.stages.map(stage => ({ stage: stage.stage, assignment: stage.assignment_id, bytes: Buffer.byteLength(stage.input) })) }) + '\n');
      assert.equal(baselineError?.code, 'SEMANTIC_REVIEW_INPUT_OVER_BOUND');
      assert.equal(current(old.api, f, 'integrator'), null);
      if (kind === 'worker') {
        assert.ok(prepared.launches.length < 2, 'baseline overflow occurs during worker preparation');
        assert.ok(prepared.launches.every(launch => launch.payload.stage === 'worker'));
        assert.ok(old.stages.every(stage => stage.stage === 'worker'));
      } else {
        assert.equal(prepared.launches.length, 2, 'the full original workers completed before actual final overflow');
        for (const launch of prepared.launches) {
          assert.equal(launch.payload.stage, 'worker');
          assert.ok(Buffer.byteLength(launch.input) <= BOUND);
          const original = old.api.readSemanticOriginal({ worktreePath: f.worktree,
            snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
          assert.equal(original.original_text, launch.text);
          assert.deepEqual(original.result, launch.result);
          assert.equal(original.native.reads.completed.filter(item => item.call_id.startsWith('z19-original-evidence-')).length, 1792);
          assert.equal(original.native.reads.incomplete.length, 0);
        }
      }
    });
  } finally { old.restore(); }
  const h = setup();
  try {
    await h.integration.publicIntegrationFixture(async f => {
      assert.equal(addSources(h, f, ...shape), sourceHash);
      const control = kind === 'final' ? finalOriginalControls(f) : controls('codex', f);
      control.barrier = false;
      const prepared = h.ordinary(f, 'codex', 'integrator', control);
      await prepared.run();
      const snapshot = assertPackets(h, prepared);
      if (kind === 'final') for (const original of wire(prepared.launches.at(-1)).originals) {
        assert.equal(original.native.reads.completed.filter(item => item.call_id.startsWith('z19-original-evidence-')).length, 1792);
        assert.equal(original.native.reads.incomplete.length, 0);
      }
      const stages = kind === 'worker' ? h.stages.filter(stage => stage.stage === 'worker') : [h.stages.at(-1)];
      const priorSizes = [];
      for (const stage of stages) {
        const legacy = rewrite(stage, packet => {
          packet.assignment = snapshot.assignments.find(item => item.id === stage.assignment_id) || null;
          packet.required_context = packet.assignment ? packet.assignment.required_context
            : snapshot.assignments.flatMap(item => item.required_context);
        });
        const actual = Buffer.byteLength(stage.input), prior = Buffer.byteLength(legacy.input);
        priorSizes.push(prior); assert.ok(actual <= BOUND, String(actual));
        process.stdout.write(JSON.stringify({ fixture: kind, stage: stage.stage, complete_input_bytes: actual,
          complete_legacy_input_bytes: prior, bound: BOUND, native_acceptance: false }) + '\n');
      }
      assert.ok(priorSizes.some(bytes => bytes > BOUND), JSON.stringify(priorSizes));
      assert.ok(cold(f, 'integrator')?.authenticated);
      assert.ok(cold(f, 'integrator', staged(f).file)?.authenticated);
    });
  } finally { h.restore(); }
});
test('complete genuinely over-bound current input still refuses without truncation or semantic credit', async () => {
  const h = setup();
  try {
    await h.integration.publicIntegrationFixture(async f => {
      addSources(h, f, 120, 0, 2300);
      const prepared = h.ordinary(f, 'codex', 'integrator', controls('codex', f));
      await assert.rejects(prepared.run(), error => {
        assert.equal(error.code, 'SEMANTIC_REVIEW_INPUT_OVER_BOUND');
        assert.ok(error.details.input_bytes > BOUND); assert.equal(error.details.limit_bytes, BOUND);
        process.stdout.write(JSON.stringify({ complete_refused_bytes: error.details.input_bytes, bound: BOUND, native_acceptance: false }) + '\n');
        return true;
      });
      assert.equal(current(h.api, f, 'integrator'), null);
      assert.equal(prepared.launches.length, 0);
      assert.equal(stable(h.snapshots[0].snapshot), h.snapshots[0].before);
    });
  } finally { h.restore(); }
});
test('actual selector retains exact historical39 and z19 singleton40 while all future rows remain selectable', () => {
  const selector = require('./shard-files.cjs'), manifest = selector.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'],
    ['phase53-z17b-ci-wait-published-read.test.cjs'], ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, [path.basename(__filename)]];
  const actual = selector.appendShard(manifest, selector.unitTasks(selector.unitFiles()));
  assert.equal(parent.length, 36);
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(actual.shards.slice(0, 36), parent);
  assert.equal(hash(JSON.stringify(actual.shards.slice(0, 37))), '5bf00ad885a7e3e264b1dcdb8ad32fedb9d7d7d4ccd23928a1d7b4c184bba84c');
  assert.deepEqual(actual.shards.slice(0, 39), first39);
  assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.ok(actual.shards.length >= 40);
  for (let i = 0; i < actual.shards.length; i++)
    assert.deepEqual(selector.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z19-inventory-'));
  try {
    for (const file of new Set(first40.flat().map(task => selector.parseTask(task).file))) fs.writeFileSync(path.join(dir, file), '');
    const ticket = selector.appendShard(manifest, selector.unitTasks(selector.unitFiles(dir)));
    assert.deepEqual(ticket.shards, first40); assert.equal(ticket.shards.length, 40);
    assert.equal(ticket.shards.length + 3, 43, 'ticket layout only; no fresh remote CI credit');
    for (let i = 0; i < ticket.shards.length; i++)
      assert.deepEqual(selector.selectTaskShard(`${i + 1}/${ticket.shards.length}`, dir), ticket.shards[i]);
    const future = 'phase53-z99-future.test.cjs'; fs.writeFileSync(path.join(dir, future), '');
    const futureTicket = selector.appendShard(ticket, selector.unitTasks(selector.unitFiles(dir)));
    assert.equal(futureTicket.shards.length, 41);
    assert.deepEqual(futureTicket.shards.slice(0, 40), first40); assert.deepEqual(futureTicket.shards.at(-1), [future]);
    for (let i = 0; i < futureTicket.shards.length; i++)
      assert.deepEqual(selector.selectTaskShard(`${i + 1}/${futureTicket.shards.length}`, dir, ticket), futureTicket.shards[i]);
    for (const file of selector.unitFiles()) fs.writeFileSync(path.join(dir, file), '');
    const next = selector.appendShard(actual, selector.unitTasks(selector.unitFiles(dir)));
    assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards);
    assert.equal(next.shards.length, actual.shards.length + 1); assert.deepEqual(next.shards.at(-1), [future]);
    for (let i = 0; i < next.shards.length; i++)
      assert.deepEqual(selector.selectTaskShard(`${i + 1}/${next.shards.length}`, dir, actual), next.shards[i]);
    process.stdout.write(JSON.stringify({ actual_unit_rows: actual.shards.length, expected_ci_checks: actual.shards.length + 3,
      frozen_ticket_unit_rows: 40, frozen_ticket_expected_checks: 43, fresh_ci_acceptance: false }) + '\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
if (isMainThread) describe('phase 53 lossless semantic wire', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z19-case-')));
    let worker;
    t.after(async () => { await worker?.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
    try {
      await new Promise((resolve, reject) => {
        const env = { ...process.env, HOME: home };
        for (const key of Object.keys(env)) if (/^(SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|GIT_CONFIG_)/.test(key)) delete env[key];
        for (const key of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
        worker = new Worker(__filename, { workerData: index, env });
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
