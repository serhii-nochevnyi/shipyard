'use strict';

// @contract: Fixture setup registers no cases.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const SCRIPTS = path.join(ROOT, 'plugins/delivery-pipeline/scripts');
const stable = require(path.join(SCRIPTS, 'model-policy-internal.cjs')).stableStringify;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function internals(plugin = path.dirname(SCRIPTS)) {
  const file = path.join(plugin, 'scripts/role-artifact.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { decodeSemanticResult, archiveRelative, MANIFEST_NAME, semanticStructuralResult, semanticWireBound, semanticPreflight, semanticPreflightReview, semanticBuildLaunch, semanticResponsibilities, semanticRequiredView, assertSemanticSnapshot, assertSemanticLaunchView, validateSemanticResult };', file);
  return loaded.exports;
}


const assert = require('node:assert/strict');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const clone = value => JSON.parse(JSON.stringify(value));
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'explicit setup-only source boundaries');
  return source.slice(first, last);
}
function setup(name, end, names) {
  const filename = path.join(ROOT, 'tests/unit', name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalCompile = Module.prototype._compile, originalLoad = Module._load;
  try {
    Module._load = function(request, ...args) {
      if (request === 'node:test') return { test() { assert.fail('old test registration reached setup'); },
        describe() { assert.fail('old suite registration reached setup'); } };
      return originalLoad.call(this, request, ...args);
    };
    Module.prototype._compile = function(source, file) {
      if (file === path.join(ROOT, 'tests/unit/phase49-incremental-integration.test.cjs')) {
        const exports = source.lastIndexOf('\nmodule.exports = ');
        assert.ok(exports >= 0);
        source = section(source, "const assert = require('node:assert/strict');", "\ntest('actual integration preparation")
          + section(source, '\nfunction projectOptions(', '\nfunction prepareCurrentIntegration(')
          + section(source, '\nfunction compactPartitionFixtureResult(', '\nfunction partitionManifests(')
          + section(source, '\nasync function fixture(', '\nfunction currentInput(') + source.slice(exports);
      }
      // @contract: Keep exact wire and separately authenticated report views available to final fixtures.
      source = source.replaceAll('result: JSON.parse(original_text)',
        "result: original.expanded_view ? JSON.parse(fs.readFileSync(original.expanded_view.read_path, 'utf8')) : JSON.parse(original_text)");
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
  let ancestor = target;
  for (;;) {
    try { assert.equal(fs.lstatSync(ancestor).isSymbolicLink(), false); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  assert.equal(fs.realpathSync(ancestor), ancestor, 'fixture writes must have physical owned ancestry');
  return target;
}
function finalFields(role) {
  return ['phase', 'head', 'head_tree', 'base', 'base_tree', 'ticket_set', 'ticket_set_digest',
    ...(['arch-review', 'code-review'].includes(role) ? ['repository', 'id', 'pr', 'base_commit', 'merge_base'] : [])];
}
function indexed(full, snapshot) {
  const wire = clone(full);
  wire.result_format = 'snapshot-indexed.v1';
  wire.reviewed_identity_sha256 = hash(stable(full.reviewed_identity));
  wire.coverage_indices = full.coverage.map(id => snapshot.obligations.findIndex(item => item.id === id));
  wire.unread_indices = full.unread.map(id => snapshot.obligations.findIndex(item => item.id === id));
  wire.seam_rows = full.seams.map(({ id, ...row }) => ({ index: snapshot.seams.findIndex(item => item.id === id), ...row }));
  for (const key of ['reviewed_identity', 'coverage', 'unread', 'seams', ...(full.stage === 'final' ? finalFields(full.role) : [])]) delete wire[key];
  return wire;
}
function richReport(result, snapshot, { incomplete = false } = {}) {
  const who = result.assignment_id || 'independent-final';
  result.conclusions = ['Native ' + who + ' evaluated the producer contract against all assigned consumers.',
    'The retained observations belong to this session and do not imply examination by another role.'];
  result.seams = result.seams.map((row, index) => ({ ...row,
    rationale: incomplete ? 'Seam ' + index + ': external dependency context is unavailable; native judgment remains unresolved.'
      : snapshot.obligations.length > 400
      ? 'Seam ' + index + ': consumer preserves producer value; failure stays observable.'
      : who + ': seam ' + index + ' preserves the declared producer value and checks its consumer failure path.',
    ...(snapshot.obligations.length > 400 ? { observation: index }
      : { evidence: ['src/provider.cjs:1', 'src/consumer.cjs:1'], observation: { order: index, reviewer: who } }) }));
  result.findings = result.role === 'code-review'
    ? [{ id: 'INFO-' + who, severity: 'INFO', summary: 'The consumer observes the retained provider value for ' + who + '.' }]
    : [{ id: 'INFO-' + who, type: 'informational', blocking: false,
      summary: 'The consumer observes the retained provider value for ' + who + '.',
      evidence: 'src/consumer.cjs:1', ticket: null }];
  result.evidence_markdown = 'Native report by ' + who + ': complete source, INFO, seam observations and independent conclusions.\n';
  if (incomplete) {
    result.completeness = 'incomplete'; result.outcome = 'human-review-required';
    result.limitations = ['Native ' + who + ' could not establish the external dependency behavior.'];
    result.required_context = ['External dependency contract remains unavailable to ' + who + '.'];
    result.unread = result.coverage.slice(-1);
    result.findings.push(result.role === 'code-review'
      ? { id: 'CONTEXT-' + who, severity: 'BLOCKER', summary: result.required_context[0],
        path: snapshot.material[0].aliases[0].path, line: 1,
        failure_scenario: 'The external dependency may violate the consumer contract while its behavior remains unavailable.',
        fix_ticket: { title: 'Establish the external dependency contract', scope: result.required_context[0],
          files: [snapshot.material[0].aliases[0].path], depends_on: [] } }
      : { id: 'CONTEXT-' + who, type: result.role === 'integrator' ? 'human-question' : 'note', blocking: true,
        summary: result.required_context[0], question: 'What is the external dependency contract?',
        evidence: 'src/consumer.cjs:1', ticket: null });
    result.blocking_count = 1;
    result.seams = result.seams.map(row => ({ ...row, disposition: 'unresolved' }));
    if (result.role === 'arch-review' && result.stage === 'final') result.verdict = 'violation';
  }
  return result;
}

function addReads(runtime, rows) {
  const { registered, template } = require('./code-review-native-driver.cjs');
  const input = runtime === 'codex' ? rows.find(row => row.payload?.role === 'user'
    && row.payload.content.some(block => block.text?.includes('<AUTHENTICATED_SEMANTIC_REVIEW>'))).payload.content.map(block => block.text || '').join('')
    : typeof rows[0].message.content === 'string' ? rows[0].message.content : rows[0].message.content.map(block => block.text || '').join('');
  const payload = JSON.parse(input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
  const files = [...payload.material, payload.catalog, ...payload.originals.flatMap(item => [item, item.expanded_view])].filter(Boolean);
  if (runtime === 'codex') {
    const captured = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
    const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
    for (const [index, file] of files.entries()) {
      const call = template(captured, row => row.payload?.type === 'function_call');
      Object.assign(call.payload, { name: 'exec_command', call_id: 'z21-read-' + index,
        arguments: JSON.stringify({ cmd: 'cat ' + JSON.stringify(file.read_path), max_output_tokens: 5000 }),
        internal_chat_message_metadata_passthrough: { turn_id: turn } });
      delete call.payload.namespace;
      const output = template(captured, row => row.payload?.type === 'function_call_output');
      Object.assign(output.payload, { call_id: call.payload.call_id,
        output: JSON.stringify({ exit_code: 0, output: fs.readFileSync(file.read_path, 'utf8') }),
        internal_chat_message_metadata_passthrough: { turn_id: turn } });
      rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, call, output);
    }
  } else {
    // @contract: Clone registered native Read frames after ordinary session binding.
    const tool = rows.find(row => row.message?.content?.[0]?.name === 'Read');
    const response = rows.find(row => row.message?.content?.[0]?.type === 'tool_result');
    assert.ok(tool && response);
    for (const [index, file] of files.entries()) {
      const call = clone(tool), output = clone(response);
      call.message.content[0].id = 'z21-read-' + index; call.message.content[0].input.file_path = file.read_path;
      output.message.content[0].tool_use_id = call.message.content[0].id;
      output.message.content[0].content = fs.readFileSync(file.read_path, 'utf8');
      rows.splice(rows.length - 1, 0, call, output);
    }
  }
}
const consumer = role => ({ integrator: 'currentIntegrationVerdict', 'arch-review': 'currentArchitectureVerdict',
  'code-review': 'currentCodeReviewVerdict' })[role];
function inputFor(f) {
  return { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number, head: f.pr.headRefOid,
    baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName };
}
function cold(f, role, plugin, originals, expectedError) {
  const child = spawnSync(process.execPath, ['-e', `
    require('node:os').homedir = () => process.argv[4];
    const api = require(process.argv[1]), input = JSON.parse(process.argv[3]), originals = JSON.parse(process.argv[5]);
    try {
      const value = originals ? originals.map(item => api.readSemanticOriginal({ worktreePath: input.worktreePath,
        snapshot_sha256: item.snapshot_sha256, assignment_id: item.reference.assignment_id })) : api[process.argv[2]](input);
      if (process.argv[6]) throw Error('malformed graph unexpectedly returned a value');
      process.stdout.write(JSON.stringify(value));
    } catch (error) {
      if (process.argv[6] !== 'malformed-graph' || !(error instanceof SyntaxError)
          || !/JSON/.test(error.message)) throw error;
      process.stdout.write(JSON.stringify({ refused: true, name: error.name }));
    }`, path.join(plugin, 'scripts/role-artifact.cjs'), consumer(role),
  JSON.stringify(inputFor(f)), os.homedir(), JSON.stringify(originals ? originals.map(original => ({
    reference: original.reference, snapshot_sha256: original.result.snapshot_sha256 })) : null), expectedError || ''],
  { env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, child.stderr);
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
  const digest = crypto.createHash('sha256');
  for (const row of actual.filter(row => !row.directory && !['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)))
    digest.update(row.path + '\0').update(fs.readFileSync(path.join(candidate, row.path)));
  const sourceDigest = digest.digest('hex'), bytes = fs.readFileSync(path.join(candidate, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(bytes), record = JSON.parse(fs.readFileSync(path.join(candidate, 'package-build.json')));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version;
  assert.equal(manifest.version, version + '+codex.' + sourceDigest.slice(0, 16));
  assert.equal(record.version, manifest.version);
  assert.equal(record.digest, hash(sourceDigest + '\0' + bytes));
  for (const name of ['role-artifact.cjs', 'codex-delivery-host.cjs', 'claude-role-host.cjs']) {
    const canonical = path.join(SCRIPTS, name);
    for (const root of [candidate, shipped]) {
      const mirror = path.join(root, 'host/plugins/delivery-pipeline/scripts', name);
      assert.equal(fs.lstatSync(mirror).isFile(), true); assert.equal(fs.lstatSync(canonical).isFile(), true);
      assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonical));
      assert.equal(fs.statSync(mirror).mode & 0o777, fs.statSync(canonical).mode & 0o777);
    }
  }
  return record;
}
async function publicRole(role, runtime, options = {}) {
  const home = fs.realpathSync(process.env.HOME);
  assert.ok(path.basename(home).startsWith('z21-case-'));
  os.homedir = () => home;
  const plugin = fs.mkdtempSync(path.join(home, 'producer-'));
  fs.cpSync(path.dirname(SCRIPTS), plugin, { recursive: true });
  if (options.historical) {
    const { execFileSync } = require('node:child_process');
    for (const name of options.historicalShared ? ['role-artifact.cjs']
      : ['role-artifact.cjs', 'codex-delivery-host.cjs', 'claude-role-host.cjs']) {
      const bytes = execFileSync('git', ['show', 'cfc5bcc51be8815b09d1c5a64f038715f316cf76:plugins/delivery-pipeline/scripts/' + name],
        { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
      fs.writeFileSync(physical(home, path.join(plugin, 'scripts', name)), bytes);
    }
  }
  const smoke = setup('../smoke/phase53-review-acceptance.cjs', 'async function observeRetirement', 'routePayload');
  const restore = smoke.routePayload(plugin), originalLoad = Module._load;
  const api = require(path.join(plugin, 'scripts/role-artifact.cjs')), snapshots = new Map();
  const nativeViews = new Map();
  const observed = { ...api, ...(api.authenticateSemanticStageResult ? { authenticateSemanticStageResult(input) {
    const result = api.authenticateSemanticStageResult(input);
    nativeViews.set(result.assignment_id || 'final', clone(result)); return result;
  } } : {}), prepareSemanticReview(...args) {
    const value = api.prepareSemanticReview(...args); snapshots.set(value.snapshot_sha256, value); return value;
  } };
  Module._load = function(request, parent, ...args) {
    if (request !== 'node:test' && Module._resolveFilename(request, parent) === path.join(plugin, 'scripts/role-artifact.cjs')) return observed;
    return originalLoad.call(this, request, parent, ...args);
  };
  try {
    const h = setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'publicIntegrationFixture, semanticFixture, supportedPartitionCaller');
    const architecture = setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'architectureFixture, ordinaryArchitecture');
    const code = setup('phase53-code-review.test.cjs', "for (const runtime of ['codex', 'claude']) {", 'fixture, setup');
    const claude = setup('phase53-claude-review.test.cjs', "for (const role of ['integrator'", 'nativeFixture, ordinary');
    const preamble = require('./codex-preamble-helpers.cjs');
    await h.publicIntegrationFixture(async f => {
      if (role === 'code-review') code.setup(f);
      preamble.installInstructions(f);
      await options.configureFixture?.(f);
      const expected = new Map();
      const controls = { session: options.session, reuseFinalSession: options.reuseFinalSession, native(rows, payload) {
        if (runtime === 'codex') {
          for (const row of rows) if (row.type === 'turn_context') delete row.payload.workspace_roots;
          if (role === 'code-review') {
            const usage = rows.findIndex(row => row.payload?.type === 'token_count');
            if (usage >= 0) rows.splice(usage, 1);
          }
          const { registered, template } = require('./code-review-native-driver.cjs');
          const initial = template(registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl'), row => row.payload?.role === 'user');
          const fields = preamble.initialization(f.worktree).payload;
          initial.payload.content = fields.content;
          initial.payload.internal_chat_message_metadata_passthrough = fields.internal_chat_message_metadata_passthrough;
          rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0, initial);
        }
        addReads(runtime, rows);
        options.native?.(rows, payload);
      }, result(result, payload) {
        const snapshot = snapshots.get(payload.snapshot_sha256); assert.ok(snapshot);
        richReport(result, snapshot, options);
        options.result?.(result, payload);
        expected.set(result.assignment_id || 'final', clone(result));
        if (!options.full && !options.historical) {
          const wire = indexed(result, snapshot);
          for (const key of Object.keys(result)) delete result[key]; Object.assign(result, wire);
        }
      }, onLaunch: options.onLaunch };
      let prepared;
      if (role === 'code-review') prepared = code.fixture(f, runtime, controls);
      else if (runtime === 'claude') {
        prepared = claude.nativeFixture(f, role, controls); prepared.run = () => claude.ordinary(f, role, prepared);
      } else if (role === 'arch-review') {
        prepared = architecture.architectureFixture(f, controls); prepared.run = () => architecture.ordinaryArchitecture(f, prepared);
      } else {
        prepared = h.semanticFixture(f, controls); prepared.run = () => h.supportedPartitionCaller(f, runtime, prepared.options);
      }
      let completed, failure;
      try { completed = await prepared.run(); } catch (error) { failure = error; }
      if (options.refusal) {
        assert.ok(failure, 'native refusal is required');
        assert.match(failure.code || '', options.refusal);
      } else {
        if (failure) throw failure;
        assert.equal(prepared.launches.length, 3);
        assert.equal(new Set(prepared.launches.map(launch => launch.session)).size, 3);
        assert.equal(api[consumer(role)](inputFor(f))?.authenticated, true);
        if (role !== 'code-review') {
          const actual = completed.result.evidence_markdown ? completed.result : { ...completed.result,
            evidence_markdown: expected.get('final').evidence_markdown };
          assert.deepEqual(actual, expected.get('final'));
        }
      }
      const originals = [];
      for (const launch of prepared.launches.filter(launch => launch.payload.stage === 'worker')) {
        const original = api.readSemanticOriginal({ worktreePath: f.worktree, snapshot_sha256: launch.payload.snapshot_sha256,
          assignment_id: launch.payload.assignment.id });
        const wireText = launch.text || launch.originalText;
        assert.equal(original.original_text, wireText);
        assert.deepEqual(original.result, expected.get(launch.payload.assignment.id));
        assert.equal(Object.hasOwn(original.reference, 'snapshot_sha256'), false);
        const manifest = JSON.parse(fs.readFileSync(path.join(f.worktree, original.reference.artifact_ref)));
        assert.equal(fs.readFileSync(path.join(f.worktree, manifest.files.findings.path), 'utf8'), wireText + '\n');
        for (const pin of [original.native.native_pin, original.native.output_pin]) {
          const raw = fs.readFileSync(pin.path); assert.equal(raw.length, pin.bytes); assert.equal(hash(raw), pin.sha256);
        }
        originals.push(original);
      }
      const context = { f, api, plugin, prepared, snapshots, expected, originals, completed, failure, nativeViews };
      if (!options.historical && !options.refusal) {
        assert.equal(nativeViews.size, 3, 'both workers and role-specific final finish receive complete authenticated views');
        for (const [key, view] of nativeViews) assert.deepEqual(view, expected.get(key));
      }
      if (!options.refusal) {
        assert.equal(cold(f, role, plugin)?.authenticated, true);
        assert.deepEqual(cold(f, role, plugin, originals), originals);
        const shipped = path.join(ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline');
        assert.equal(cold(f, role, shipped)?.authenticated, true);
        assert.deepEqual(cold(f, role, shipped, originals), originals);
        const launches = prepared.launches.length;
        const recovered = await prepared.run();
        assert.equal(prepared.launches.length, launches, 'recorded recovery cannot launch again');
        assert.deepEqual(recovered.result, completed.result);
      } else assert.equal(cold(f, role, plugin), null);
      await options.inspect?.(context);
    });
  } finally { Module._load = originalLoad; restore(); }
}

// @contract: Controlled fixture metadata supplies no installed or native phase proof.
function currentSized(role = 'integrator', runtime = 'codex') {
  const a = internals(), tickets = Array.from({ length: 19 }, (_, i) => ({ id: 'T-53-' + String(i + 1).padStart(2, '0'),
    files: ['src/domain-' + i + '.cjs'], plan: '.planning/phases/53/53-' + i + '-PLAN.md', depends_on: [] }));
  const material = tickets.map((ticket, i) => {
    const count = i === 0 ? 51 : 34;
    const content = Array.from({ length: count }, (_, j) => "require('./external-" + i + '-' + j + ".cjs');").join('\n');
    return { source_id: 's-' + hash(content), content, bytes: Buffer.byteLength(content), sha256: hash(content),
      aliases: [{ path: ticket.files[0], pointer: '/source' }] };
  });
  const obligations = Array.from({ length: 458 }, (_, i) => {
    const source = material[i % material.length];
    return { id: 'o-' + hash('obligation-' + i), source_id: source.source_id, sha256: source.sha256,
      path: source.aliases[0].path, pointer: '/source', governing: false, value: 'Controlled domain obligation ' + i };
  });

  for (let i = 1; i < obligations.length; i += 2) obligations[i].pointer = '/consumer/acceptance/';
  for (const source of material) source.aliases.push({ path: source.aliases[0].path, pointer: '/consumer/acceptance/' });
  const inventory = { material, obligations };
  const identity = { worktree: '/fixture/current-sized', repository: '/fixture/current-sized.git', phase: '53',
    head: 'a'.repeat(40), head_tree: 'b'.repeat(40), base: 'c'.repeat(40), base_tree: 'd'.repeat(40),
    merge_base: 'e'.repeat(40), merge_base_tree: 'f'.repeat(40), base_ref: 'refs/remotes/origin/main', pr: 600,
    ticket_set: tickets.map((item, i) => ({ id: item.id, pr: 400 + i, head: hash(item.id).slice(0, 40),
      base: 'main', branch: 'ticket/' + item.id })),
    ticket_set_digest: hash(stable(tickets)), bookkeeping: [] };

  identity.bookkeeping = tickets.map((ticket, i) => ({ path: ticket.plan, sha256: hash(ticket.id),
    cleared_sha256: hash('cleared-' + ticket.id), context: 'Retained bookkeeping context for domain ' + i + ': ' + 'recorded-source;'.repeat(40) }));
  const delta = 26821 - Buffer.byteLength(stable(identity));
  assert.ok(delta > 0); identity.bookkeeping[0].context += 'x'.repeat(delta);
  const snapshot = { schema: 'shipyard.semantic-review-snapshot.v1', review_contract: 'shipyard.semantic-review.v1',
    role, runtime, stage: 'snapshot', subject: 'phase=53;fixture=current-sized', identity,
    ...inventory, ...a.semanticResponsibilities(inventory, tickets.map(row => ({ id: row.id, row })), role),
    ...(role === 'code-review' ? { code_review_packet: { role_context: { review_round: 1, review_scope: 'full',
      prior_head: null, prior_findings: [], dispositions_digest: hash(stable([])) } } } : {}),
    ...(role === 'arch-review' ? { architecture_packet: { change_metadata: { changes: tickets.map(ticket => ({
      old_path: ticket.files[0], new_path: ticket.files[0], status: 'M' })) }, adr_selection: [{
      path: '.planning/architecture/ADR-034.md', sha256: hash('controlled-governing-contract') }],
      decision_cycles: [], source_authority: [], retained_evidence: [] } } : {}) };
  snapshot.snapshot_sha256 = hash(stable(snapshot)); a.assertSemanticSnapshot(snapshot);
  assert.equal(snapshot.obligations.length, 458); assert.equal(snapshot.seams.length, 663);
  return snapshot;
}
function sizedLaunch(snapshot, stage, assignment = snapshot.assignments[0]) {
  const payload = { result_formats: ['full', 'snapshot-indexed.v1'] };
  return { role: snapshot.role, stage, assignment_id: stage === 'final' ? null : assignment.id,
    snapshot_sha256: snapshot.snapshot_sha256, binding_sha256: '9'.repeat(64),
    input: '<AUTHENTICATED_SEMANTIC_REVIEW>\n' + stable(payload) + '\n</AUTHENTICATED_SEMANTIC_REVIEW>',
    originals: stage === 'worker' ? [] : snapshot.assignments.map(item => ({ assignment_id: item.id,
      dispatch_id: 'semantic-worker-' + hash(item.id), artifact_ref: '.planning/evidence/' + item.id + '/ROLE-ARTIFACT.json',
      artifact_sha256: hash('original-' + item.id) })) };
}
function sizingRecord(snapshot) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-sizing-')));
  const criteria = require(path.join(SCRIPTS, 'claude-reference-content.cjs')).loadClaudeReferenceContent(snapshot.role);
  const instructions = snapshot.runtime === 'claude' ? criteria : 'developer_instructions = \'\'\'\nRead complete fixture material.\n\'\'\'\n';
  const name = snapshot.runtime === 'claude' ? 'instructions.md' : 'agent.toml';
  fs.writeFileSync(physical(directory, path.join(directory, name)), instructions);
  const { snapshot_sha256, ...body } = snapshot;
  Object.assign(body, { criteria, agent_sha256: hash(instructions),
    pins: [{ root: directory, path: name, bytes: Buffer.byteLength(instructions), sha256: hash(instructions) }] });
  const current = { ...body, snapshot_sha256: hash(stable(body)) };
  internals().assertSemanticSnapshot(current);
  const record = { snapshot: current, input_transport: 'host-files', input_root: path.join(directory, 'inputs') };
  fs.mkdirSync(record.input_root);
  return { record, directory, close() { fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { ROOT, SCRIPTS, stable, hash, clone, internals, setup, physical, indexed, richReport,
  consumer, inputFor, cold, inventory, packageParity, publicRole, currentSized, sizedLaunch, sizingRecord };
