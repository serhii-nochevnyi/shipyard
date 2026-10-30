'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(ROOT, 'plugins/delivery-pipeline');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const cases = [];
const test = (title, run) => cases.push({ title, run });

function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'explicit setup-only source boundaries');
  return source.slice(first, last);
}

function setup(name, end, names) {
  const filename = path.join(__dirname, name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
  const originalCompile = Module.prototype._compile, originalLoad = Module._load;
  try {
    Module._load = function(request, ...args) {
      if (request === 'node:test') return { test() { assert.fail('old test registration reached setup'); }, describe() { assert.fail('old suite reached setup'); } };
      return originalLoad.call(this, request, ...args);
    };
    Module.prototype._compile = function(source, file) {
      if (file === path.join(__dirname, 'phase49-incremental-integration.test.cjs')) {
        const exports = source.lastIndexOf('\nmodule.exports = ');
        assert.ok(exports >= 0, 'reuse only the requested existing setup exports');
        const requested = source.slice(exports);
        source = section(source, "const assert = require('node:assert/strict');", "\ntest('actual integration preparation")
          + section(source, '\nfunction projectOptions(', '\nfunction prepareCurrentIntegration(')
          + section(source, '\nfunction compactPartitionFixtureResult(', '\nfunction partitionManifests(')
          + section(source, '\nasync function fixture(', '\nfunction currentInput(')
          + requested;
      }
      return originalCompile.call(this, source, file);
    };
    const source = fs.readFileSync(filename, 'utf8');
    assert.ok(source.includes(end));
    loaded._compile(source.slice(0, source.indexOf(end)) + '\nmodule.exports = { ' + names + ' };', filename);
    return loaded.exports;
  } finally { Module._load = originalLoad; Module.prototype._compile = originalCompile; }
}

function physical(root, file) {
  root = fs.realpathSync(root);
  const target = path.resolve(file), relative = path.relative(root, target);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  let parent = target;
  for (;;) {
    try { assert.equal(fs.lstatSync(parent).isSymbolicLink(), false); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(parent); }
  }
  assert.equal(fs.realpathSync(parent), parent, 'fixture mutations cannot follow symlinks');
  return target;
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
}

function repeated(rows, placement = 'observed') {
  const index = rows.findIndex(row => row.type === 'turn_context');
  const [context] = rows.splice(index, 1);
  context.payload.future_context = { ordered: [1, '1', null, { enabled: true }], nested: { unknown: 'exact bytes' } };
  const input = () => rows.findLastIndex(row => row.payload?.role === 'user');
  const start = rows.findIndex(row => row.payload?.type === 'task_started');
  rows.splice(placement === 'before-start' ? start : placement === 'after-start' ? start + 1 : input(), 0, context);
  const again = clone(context); again.payload = reverseKeys(again.payload);
  rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, again, clone(context));
}

const consumer = role => ({ integrator: 'currentIntegrationVerdict', 'arch-review': 'currentArchitectureVerdict',
  'code-review': 'currentCodeReviewVerdict' })[role];
function inputFor(f) {
  return { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number, head: f.pr.headRefOid,
    baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName };
}
function cold(f, role, plugin, originals) {
  const child = spawnSync(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[4];
    const api = require(process.argv[1]), input = JSON.parse(process.argv[3]);
    const originals = JSON.parse(process.argv[5]);
    const value = originals ? originals.map(reference => api.readSemanticOriginal({ worktreePath: input.worktreePath,
      snapshot_sha256: reference.snapshot_sha256, assignment_id: reference.assignment_id })) : api[process.argv[2]](input);
    process.stdout.write(JSON.stringify(value));`, path.join(plugin, 'scripts/role-artifact.cjs'), consumer(role),
  JSON.stringify(inputFor(f)), os.homedir(), JSON.stringify(originals || null)],
  { env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = prefix + entry.name, file = path.join(root, relative), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      const row = { path: relative, mode: stat.mode & 0o777, directory: entry.isDirectory() };
      return entry.isDirectory() ? [row, ...inventory(root, relative + '/')] : [{ ...row, sha256: hash(fs.readFileSync(file)) }];
    });
}
function packageParity(candidate) {
  const shipped = path.join(ROOT, 'plugins/shipyard'), actual = inventory(candidate);
  assert.deepEqual(actual, inventory(shipped));
  const digest = createHash('sha256');
  for (const row of actual.filter(row => !row.directory && !['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)))
    digest.update(row.path + '\0').update(fs.readFileSync(path.join(candidate, row.path)));
  const sourceDigest = digest.digest('hex'), manifestBytes = fs.readFileSync(path.join(candidate, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes), record = JSON.parse(fs.readFileSync(path.join(candidate, 'package-build.json')));
  const version = JSON.parse(fs.readFileSync(path.join(SOURCE, '.claude-plugin/plugin.json'))).version;
  assert.equal(manifest.version, version + '+codex.' + sourceDigest.slice(0, 16));
  assert.equal(record.version, manifest.version);
  assert.equal(record.digest, createHash('sha256').update(sourceDigest).update('\0').update(manifestBytes).digest('hex'));
  const relative = 'scripts/codex-runtime-host.cjs', canonical = path.join(SOURCE, relative);
  for (const file of [path.join(candidate, 'host/plugins/delivery-pipeline', relative), path.join(shipped, 'host/plugins/delivery-pipeline', relative)]) {
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(canonical));
    assert.equal(fs.statSync(file).mode & 0o777, fs.statSync(canonical).mode & 0o777);
  }
}

async function publicRole(role, runtime = 'codex', resource) {
  assert.ok(path.basename(fs.realpathSync(process.env.HOME)).startsWith('z20-case-'));
  os.homedir = () => process.env.HOME;
  const smoke = setup('../smoke/phase53-review-acceptance.cjs', 'async function observeRetirement', 'routePayload, coldCurrent');
  const directory = fs.mkdtempSync(path.join(process.env.HOME, 'producer-'));
  fs.cpSync(SOURCE, directory, { recursive: true });
  const restore = smoke.routePayload(directory);
  try {
    const h = setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller",
      'publicIntegrationFixture, semanticFixture, supportedPartitionCaller');
    const architecture = setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'architectureFixture, ordinaryArchitecture');
    const code = setup('phase53-code-review.test.cjs', "for (const runtime of ['codex', 'claude']) {", 'fixture, setup');
    const claude = setup('phase53-claude-review.test.cjs', "for (const role of ['integrator'", 'nativeFixture, ordinary');
    const preamble = require('../fixtures/phase53/codex-preamble-helpers.cjs');
    const api = require(path.join(directory, 'scripts/role-artifact.cjs'));
    const extraction = require(path.join(directory, 'scripts/codex-runtime-host.cjs'));
    await h.publicIntegrationFixture(async f => {
      if (role === 'code-review') code.setup(f);
      preamble.installInstructions(f);
      physical(f.root, process.env.CODEX_HOME);
      const rawRows = new Map();
      const controls = { native(rows, payload) {
        if (runtime !== 'codex') return;
        for (const row of rows) if (row.type === 'turn_context') delete row.payload.workspace_roots;
        if (role === 'code-review') {
          const usage = rows.findIndex(row => row.payload?.type === 'token_count');
          if (usage >= 0) rows.splice(usage, 1);
        }
        rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0, preamble.initialization(f.worktree));
        repeated(rows, payload.stage === 'final' ? 'observed'
          : payload.assignment.id === 'producer-contract' ? 'before-start' : 'after-start');
        if (resource && payload.stage === resource) rows.splice(-3, 0, { type: 'event_msg', payload: { type: 'compacted' } });
        rawRows.set(payload.assignment?.id || 'final', clone(rows));
      }, result(result, payload) {
        if (resource && payload.stage === resource) {
          result.completeness = 'incomplete'; result.unread = result.coverage;
          result.required_context = ['Recorded native resource failure remains unresolved.'];
          result.evidence_markdown += '\nINCOMPLETE: no resource completion credit.';
        }
      } };
      let prepared;
      if (role === 'code-review') prepared = code.fixture(f, runtime, controls);
      else if (runtime === 'claude') {
        prepared = claude.nativeFixture(f, role, controls); prepared.run = () => claude.ordinary(f, role, prepared);
      } else if (role === 'arch-review') {
        prepared = architecture.architectureFixture(f, controls); prepared.run = () => architecture.ordinaryArchitecture(f, prepared);
      } else {
        prepared = h.semanticFixture(f, controls); prepared.run = () => h.supportedPartitionCaller(f, runtime, prepared.options);
      }
      if (resource) {
        await assert.rejects(prepared.run(), error => error.code === 'SEMANTIC_REVIEW_INCOMPLETE');
        assert.equal(api[consumer(role)](inputFor(f)), null);
        assert.equal(cold(f, role, directory), null);
        if (resource === 'worker') {
          assert.equal(prepared.launches.at(-1).payload.stage, 'final');
          for (const launch of prepared.launches.filter(launch => launch.payload.stage === 'worker')) {
            const original = api.readSemanticOriginal({ worktreePath: f.worktree, snapshot_sha256: launch.payload.snapshot_sha256,
              assignment_id: launch.payload.assignment.id });
            assert.equal(original.native.resource_failure.code, 'INTEGRATION_PARTITION_INVALID');
            assert.match(original.native.resource_failure.message, /compaction/);
            assert.equal(original.result.completeness, 'incomplete');
            assert.equal(original.native.reads.semantic_credit, false);
            assert.equal(original.original_text, launch.text);
          }
        }
      } else {
        const completed = await prepared.run();
        assert.equal(completed.result.outcome, 'passed');
        assert.equal(prepared.launches.length, 3);
        assert.equal(new Set(prepared.launches.map(launch => launch.session)).size, 3);
        assert.equal(api[consumer(role)](inputFor(f))?.authenticated, true);
      }
      const originals = [];
      for (const launch of prepared.launches) {
        if (runtime === 'codex') {
          const raw = fs.readFileSync(physical(f.root, launch.nativePath), 'utf8');
          const rows = raw.trim().split('\n').map(JSON.parse);
          assert.deepEqual(rows, rawRows.get(launch.payload.assignment?.id || 'final'), 'original rows survive without rewriting');
          const record = fs.readdirSync(prepared.recorder.storeDir).filter(file => /^record-.*\.json$/.test(file))
            .map(file => JSON.parse(fs.readFileSync(physical(f.root, path.join(prepared.recorder.storeDir, file)))).payload)
            .find(record => record.receipt?.runtime_evidence?.session_id === launch.session);
          assert.ok(record);
          const receipt = prepared.recorder.getVerifiedRecord(record.dispatch_id).receipt;
          const options = { input: launch.input, initialContext: receipt.runtime_evidence.initial_context.launch, sessionId: launch.session };
          const ordered = extraction.extractSemanticInitialInput(rows, options);
          assert.equal(rows.filter(row => row.type === 'turn_context').length, 3);
          assert.ok(ordered.initial_index < ordered.input_index);
          assert.deepEqual(extraction.verifySemanticReads(raw, options).incomplete, []);
        }
        if (launch.payload.stage !== 'worker') continue;
        const original = api.readSemanticOriginal({ worktreePath: f.worktree, snapshot_sha256: launch.payload.snapshot_sha256,
          assignment_id: launch.payload.assignment.id });
        assert.equal(original.original_text, launch.text || launch.originalText);
        assert.equal(original.native.native_pin.sha256, hash(fs.readFileSync(original.native.native_pin.path)));
        if (!resource) assert.equal(original.native.resource_failure, null);
        if (role === 'code-review' && runtime === 'codex') {
          assert.equal(original.native.accounting.status, 'unknown');
          assert.deepEqual(original.native.observation, []);
        }
        originals.push(original);
      }
      const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(f.root, 'candidate'));
      packageParity(candidate);
      const staged = path.join(candidate, 'host/plugins/delivery-pipeline');
      for (const plugin of [directory, path.join(ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline'), staged]) {
        assert.equal(smoke.coldCurrent(f, role, plugin)?.authenticated === true, !resource);
        assert.equal(cold(f, role, plugin)?.authenticated === true, !resource);
        assert.deepEqual(cold(f, role, plugin, originals.map(original => ({ ...original.reference, snapshot_sha256: original.result.snapshot_sha256 }))), originals);
      }
      if (!resource && runtime === 'codex') {
        const final = prepared.launches.at(-1), nativePath = physical(f.root, final.nativePath), before = fs.readFileSync(nativePath);
        const rows = before.toString().trim().split('\n').map(JSON.parse);
        rows.findLast(row => row.type === 'turn_context').payload.future_context.nested.unknown += 'changed';
        try {
          fs.writeFileSync(nativePath, preamble.serialize(rows));
          for (const plugin of [directory, staged]) assert.equal(cold(f, role, plugin), null, 'changed original native pin cannot be accepted');
        } finally { fs.writeFileSync(nativePath, before); }
        assert.equal(cold(f, role, staged)?.authenticated, true);
      }
    });
  } finally { restore(); }
}

test('ordinary Codex integrator retains repeated full contexts through independent final and cold current consumers', () => publicRole('integrator'));

test('shared extractor and reader accept complete JSON equivalence at all supported initial placements without changing rows', () => {
  const h = require('../fixtures/phase53/codex-preamble-helpers.cjs');
  for (const preamble of [false, true]) for (const placement of ['before-start', 'after-start', 'observed']) {
    const { rows, options } = h.orderedFixture();
    if (!preamble) rows.splice(3, 1);
    repeated(rows, placement);
    for (const row of rows.filter(row => row.type === 'turn_context'))
      Object.defineProperty(row.payload.future_context, '__proto__', { value: { exact: true }, enumerable: true });
    const before = h.serialize(rows), ordered = h.runtime.extractSemanticInitialInput(rows, options);
    assert.equal(ordered.turn_id, 'turn');
    assert.equal(ordered.input_index, rows.findLastIndex(row => row.payload?.role === 'user'));
    assert.equal(ordered.final_index, rows.findIndex(row => row.payload?.phase === 'final_answer'));
    assert.equal(ordered.initial_index, preamble ? rows.findIndex(row => row.payload?.role === 'user') : null);
    assert.deepEqual(h.runtime.verifySemanticReads(before, options).incomplete, []);
    assert.equal(h.serialize(rows), before);
  }
});

test('every complete repeated payload and every occurrence binding remains significant in both shared consumers', () => {
  const h = require('../fixtures/phase53/codex-preamble-helpers.cjs');
  const changes = {
    'unknown nested field': p => { p.future_context.nested.unknown += 'changed'; },
    'new unknown field': p => { p.unknown = null; },
    'missing unknown field': p => { delete p.future_context; },
    'nested object field': p => { p.future_context.ordered[3].enabled = false; },
    'array order': p => { p.future_context.ordered.reverse(); },
    'scalar type': p => { p.future_context.ordered[0] = '1'; },
    'null value': p => { p.future_context.ordered[2] = false; },
    'prototype named field': p => { Object.defineProperty(p.future_context, '__proto__', { value: { changed: true }, enumerable: true }); },
    'cwd': p => { p.cwd = '/foreign'; },
    'roots': p => { p.workspace_roots = ['/foreign']; },
    'model': p => { p.model = 'gpt-6-luna'; },
    'effort': p => { p.effort = 'low'; },
    'sandbox': p => { p.sandbox_policy.type = 'workspace-write'; },
    'approval': p => { p.approval_policy = 'on-request'; },
    'network': p => { p.sandbox_policy.network_access = true; },
    'tmp env': p => { p.sandbox_policy.exclude_tmpdir_env_var = true; },
    'slash tmp': p => { p.sandbox_policy.exclude_slash_tmp = true; },
    'collaboration model': p => { p.collaboration_mode = { settings: { model: 'foreign', reasoning_effort: 'high' } }; },
    'collaboration effort': p => { p.collaboration_mode = { settings: { model: p.model, reasoning_effort: 'low' } }; },
    'collaboration instructions': p => { p.collaboration_mode = { settings: { model: p.model, reasoning_effort: p.effort, developer_instructions: 'forged' } }; },
    'turn': p => { p.turn_id = 'foreign'; },
    'missing turn': p => { delete p.turn_id; },
    'session': p => { p.session_id = 'foreign'; },
    'thread': p => { p.thread_id = 'foreign'; },
    'passthrough turn': p => { p.internal_chat_message_metadata_passthrough = { turn_id: 'foreign' }; },
    'passthrough session': p => { p.internal_chat_message_metadata_passthrough = { session_id: 'foreign' }; },
  };
  function refused(rows, options, label) {
    for (const run of [() => h.runtime.extractSemanticInitialInput(rows, options), () => h.runtime.verifySemanticReads(h.serialize(rows), options)])
      assert.throws(run, error => /^RUNTIME_EVIDENCE_/.test(error.code), label);
  }
  for (const [label, change] of Object.entries(changes)) {
    for (const occurrence of [0, 1, 2]) {
      const { rows, options } = h.orderedFixture(); repeated(rows);
      change(rows.filter(row => row.type === 'turn_context')[occurrence].payload);
      refused(rows, options, label + ' occurrence ' + occurrence);
    }
  }
  for (const label of ['cwd', 'roots', 'model', 'effort', 'sandbox', 'approval', 'network', 'tmp env', 'slash tmp',
    'collaboration model', 'collaboration effort', 'collaboration instructions', 'turn', 'missing turn', 'session', 'thread']) {
    const { rows, options } = h.orderedFixture(); repeated(rows);
    for (const row of rows.filter(row => row.type === 'turn_context')) changes[label](row.payload);
    refused(rows, options, 'all equivalent but invalid: ' + label);
  }
  for (const payload of [null, [], 'context', 1, true]) {
    for (const occurrence of [0, 1, 2]) {
      const { rows, options } = h.orderedFixture(); repeated(rows);
      rows.filter(row => row.type === 'turn_context')[occurrence].payload = payload;
      refused(rows, options, 'nonobject occurrence ' + occurrence);
    }
  }
});

test('missing reordered foreign and post-final observations and all existing initialization mutations still refuse', () => {
  const h = require('../fixtures/phase53/codex-preamble-helpers.cjs');
  const mutations = {
    'missing contexts': rows => rows.splice(0, rows.length, ...rows.filter(row => row.type !== 'turn_context')),
    'missing session': rows => rows.splice(0, 1),
    'duplicate session': rows => rows.splice(1, 0, clone(rows[0])),
    'late session': rows => rows.splice(4, 0, rows.shift()),
    'first context after input': rows => {
      const contexts = rows.filter(row => row.type === 'turn_context');
      rows.splice(0, rows.length, ...rows.filter(row => row.type !== 'turn_context'));
      rows.splice(rows.findLastIndex(row => row.payload?.role === 'user') + 1, 0, ...contexts);
    },
    'first context after tools': rows => {
      const contexts = rows.filter(row => row.type === 'turn_context');
      rows.splice(0, rows.length, ...rows.filter(row => row.type !== 'turn_context'));
      rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, ...contexts);
    },
    'context after final': rows => rows.splice(-1, 0, clone(rows.find(row => row.type === 'turn_context'))),
    'context after completion': rows => rows.push(clone(rows.find(row => row.type === 'turn_context'))),
    'duplicate start': rows => rows.splice(2, 0, clone(rows.find(row => row.payload?.type === 'task_started'))),
    'duplicate complete': rows => rows.push(clone(rows.at(-1))),
    'completion before start': rows => rows.unshift(rows.pop()),
    'duplicate input': rows => rows.splice(-3, 0, clone(rows.findLast(row => row.payload?.role === 'user'))),
    'duplicate final': rows => rows.splice(-1, 0, clone(rows.find(row => row.payload?.phase === 'final_answer'))),
    'output before call': rows => {
      const a = rows.findIndex(row => row.payload?.type === 'function_call'), b = rows.findIndex(row => row.payload?.type === 'function_call_output');
      [rows[a], rows[b]] = [rows[b], rows[a]];
    },
    'tool after final': rows => rows.splice(-1, 0, rows.splice(rows.findIndex(row => row.payload?.type === 'function_call'), 1)[0]),
    'duplicate tool': rows => rows.splice(-3, 0, clone(rows.find(row => row.payload?.type === 'function_call'))),
    'foreign tool turn': rows => { rows.find(row => row.payload?.type === 'function_call').payload.turn_id = 'foreign'; },
  };
  for (const [label, mutate] of Object.entries({ ...h.mutations, ...mutations })) {
    const { rows, options } = h.orderedFixture();
    if (Object.hasOwn(h.mutations, label)) { mutate(rows); repeated(rows); } else { repeated(rows); mutate(rows); }
    assert.throws(() => h.runtime.extractSemanticInitialInput(rows, options), undefined, label);
    assert.throws(() => h.runtime.verifySemanticReads(h.serialize(rows), options), undefined, label);
  }
  for (const mutate of [options => { options.initialContext.instructions += 'changed'; },
    options => { options.initialContext.sources[0].text += 'changed'; }, options => { options.sessionId = 'foreign'; },
    options => { options.input += 'changed'; }, options => { delete options.initialContext; }]) {
    const { rows, options } = h.orderedFixture(); repeated(rows); mutate(options);
    assert.throws(() => h.runtime.extractSemanticInitialInput(rows, options));
    assert.throws(() => h.runtime.verifySemanticReads(h.serialize(rows), options));
  }
});

test('identity extraction leaves every native resource marker available to the unchanged resource guard', () => {
  const h = require('../fixtures/phase53/codex-preamble-helpers.cjs');
  const file = path.join(SOURCE, 'scripts/role-artifact.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { nativeObservationSamples };', file);
  const markers = ['context_compacted', 'compacted', 'thread_rolled_back', 'rollback', 'turn_aborted', 'task_failed',
    'error', 'turn.failed', 'model_rerouted', 'context_length_exceeded', 'context_window_exceeded', 'max_output_tokens',
    'input_truncated', 'output_truncated'].map(type => ({ type: 'event_msg', payload: { type } }));
  markers.push({ type: 'compacted' }, { type: 'system', subtype: 'compact_boundary' },
    { type: 'system', subtype: 'microcompact_boundary' }, { type: 'response_item', payload: { type: 'compaction' } },
    { type: 'response_item', payload: { type: 'compacted' } }, { type: 'event_msg', truncated: true },
    { type: 'event_msg', payload: { truncated: true } });
  for (const marker of markers) {
    const { rows, options } = h.orderedFixture(); repeated(rows); rows.splice(-3, 0, marker);
    const raw = h.serialize(rows);
    assert.equal(h.runtime.extractSemanticInitialInput(rows, options).turn_id, 'turn');
    assert.deepEqual(h.runtime.verifySemanticReads(raw, options).incomplete, []);
    for (const stream of [false, true]) assert.throws(() => loaded.exports.nativeObservationSamples(
      { receipt: { runtime: 'codex', runtime_evidence: { session_id: 'session' } } },
      { runtime: 'codex', input: options.input }, { rows: stream ? rows.filter(row => row !== marker) : rows }, stream ? [marker] : []),
    error => error.code === 'INTEGRATION_PARTITION_INVALID' && error.native_resource_outcome === true);
    assert.equal(h.serialize(rows), raw);
  }
});

for (const role of ['arch-review', 'code-review']) test('ordinary Codex ' + role + ' retains repeats through warm cold shipped and staged consumers', () => publicRole(role));
for (const role of ['integrator', 'arch-review', 'code-review']) test('recorded Claude ' + role + ' preserves ordinary warm cold shipped and staged compatibility', () => publicRole(role, 'claude'));
for (const stage of ['worker', 'final']) test('equivalent repeated identity preserves actual compacted ' + stage + ' resource refusal and zero completion credit', () => publicRole('integrator', 'codex', stage));

test('genuine isolated package reproduces the complete inventory identities modes and independently loaded extractor', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z20-package-'));
  try {
    const before = inventory(path.join(ROOT, 'plugins/shipyard'));
    const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(directory, 'candidate'));
    packageParity(candidate);
    assert.deepEqual(inventory(path.join(ROOT, 'plugins/shipyard')), before);
    const file = path.join(candidate, 'host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
    assert.equal(require.cache[file], undefined);
    const staged = require(file), h = require('../fixtures/phase53/codex-preamble-helpers.cjs');
    assert.notEqual(staged, h.runtime);
    const { rows, options } = h.orderedFixture(); repeated(rows);
    assert.deepEqual(staged.extractSemanticInitialInput(rows, options), h.runtime.extractSemanticInitialInput(rows, options));
    assert.deepEqual(staged.verifySemanticReads(h.serialize(rows), options), h.runtime.verifySemanticReads(h.serialize(rows), options));
    rows.findLast(row => row.type === 'turn_context').payload.future_context.nested.unknown += 'changed';
    assert.throws(() => staged.extractSemanticInitialInput(rows, options));
    assert.throws(() => staged.verifySemanticReads(h.serialize(rows), options));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual selector preserves exact 16 28 39 40 prefixes z20 singleton41 current denominator and a future append', () => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const ticketRows = [...first40, [path.basename(__filename)]];
  const actual = s.appendShard(manifest, s.unitTasks(s.unitFiles()));
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(hash(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.equal(parent.length, 36);
  assert.deepEqual(actual.shards.slice(0, 39), first39);
  assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.deepEqual(actual.shards.slice(0, 41), ticketRows);
  assert.equal(actual.shards.flat().filter(task => task === path.basename(__filename)).length, 1);
  for (let i = 0; i < actual.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z20-inventory-'));
  try {
    for (const file of new Set(ticketRows.flat().map(task => s.parseTask(task).file))) fs.writeFileSync(path.join(directory, file), '');
    const ticket = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(ticket.shards, ticketRows);
    assert.equal(ticket.shards.length, 41); assert.equal(ticket.shards.length + 3, 44);
    for (let i = 0; i < ticket.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/41`, directory), ticket.shards[i]);
    for (const file of s.unitFiles()) fs.writeFileSync(path.join(directory, file), '');
    const future = 'zz-future-native-regression.test.cjs'; fs.writeFileSync(path.join(directory, future), '');
    const next = s.appendShard(actual, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards);
    assert.equal(next.shards.length, actual.shards.length + 1); assert.deepEqual(next.shards.at(-1), [future]);
    for (let i = 0; i < next.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${next.shards.length}`, directory, actual), next.shards[i]);
    process.stdout.write(JSON.stringify({ actual_unit_rows: actual.shards.length, actual_workflow_checks: actual.shards.length + 3,
      ticket_unit_rows: 41, ticket_workflow_checks: 44, installed_native_acceptance: false, R8: 'INCOMPLETE', semantic_credit: 0 }) + '\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

if (isMainThread) describe('phase 53 repeated native context observations', { concurrency: 2 }, () => {
  for (const [index, entry] of cases.entries()) registerTest(entry.title, { timeout: 180000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z20-case-')));
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
