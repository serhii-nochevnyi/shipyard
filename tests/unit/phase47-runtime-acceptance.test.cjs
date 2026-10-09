'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const acceptance = require('../smoke/phase47-runtime-acceptance.cjs');
const REPOSITORY = path.resolve(__dirname, '../..');
const PACKAGE = path.join(REPOSITORY, 'plugins/shipyard');

function productFixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-product-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const installed = path.join(temporary, 'package');
  fs.cpSync(PACKAGE, installed, { recursive: true });
  const entries = [];
  const collect = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const file = path.join(directory, name), relative = prefix + name;
      if (fs.statSync(file).isDirectory()) collect(file, relative + '/');
      else entries.push({ path: relative, sha256: acceptance.sha(fs.readFileSync(file)),
        bytes: fs.statSync(file).size, publication_mode: fs.statSync(file).mode & 0o777 });
    }
  };
  collect(PACKAGE);
  const build = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package-build.json')));
  const content = require('node:crypto').createHash('sha256');
  for (const entry of entries) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(entry.path)) continue;
    content.update(entry.path + '\0'); content.update(fs.readFileSync(path.join(PACKAGE, entry.path)));
  }
  return { temporary, installed, binding: { outputs: entries, package_sha256: build.digest,
    source_content_sha256: content.digest('hex'), version: build.version },
  scripts: path.join(installed, 'host/plugins/delivery-pipeline/scripts') };
}

test('an explicit HOLD validates without claiming installed acceptance or launching', () => {
  const ledger = acceptance.openLedger();
  const result = acceptance.validateLedger(ledger);
  assert.equal(result.status, 'HOLD');
  assert.equal(result.accepted, false);
  assert.equal(result.native_launches, 0);
  assert.equal(result.open.length, acceptance.OBLIGATIONS.length);
});

test('missing properties and self-declared transport success cannot complete acceptance', () => {
  const ledger = acceptance.openLedger();
  ledger.obligations.pop();
  assert.throws(() => acceptance.validateLedger(ledger), /obligation inventory/);
  const forged = acceptance.openLedger();
  forged.obligations[0] = { ...forged.obligations[0], status: 'proven',
    proof: { kind: 'transport', exit_code: 0, compliance: 'verified' } };
  assert.throws(() => acceptance.validateLedger(forged), /original proof/);
});

test('unknown accounting cannot be silently converted into zero or savings', () => {
  const ledger = acceptance.openLedger();
  ledger.accounting.parent_tokens = 0;
  assert.throws(() => acceptance.validateLedger(ledger), /unknown accounting/);
  ledger.accounting.parent_tokens = null;
  ledger.accounting.efficiency = 'improved';
  assert.throws(() => acceptance.validateLedger(ledger), /inconclusive/);
});

test('native switches refuse missing identity before any subprocess', () => {
  for (const argv of [['--native'], ['--native', '--candidate', '/tmp/foreign'],
    ['--runtime', 'claude'], ['--delete', '/tmp/anything']]) {
    assert.throws(() => acceptance.parseArgs(argv));
  }
});

test('supplied installation cannot hide behind open obligation status', () => {
  const ledger = acceptance.openLedger();
  ledger.installation = { runtime: 'codex' };
  assert.throws(() => acceptance.validateLedger(ledger), /current installed candidate identity/);
});

test('bounded reads reject missing, changed, symlinked and oversized original evidence', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-acceptance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'original.json');
  fs.writeFileSync(file, '{}');
  const digest = acceptance.sha(fs.readFileSync(file));
  assert.equal(acceptance.readOriginal({ path: file, sha256: digest }).toString(), '{}');
  assert.throws(() => acceptance.readOriginal({ path: file, sha256: '0'.repeat(64) }), /digest/);
  const alias = path.join(root, 'alias.json');
  fs.symlinkSync(file, alias);
  assert.throws(() => acceptance.readOriginal({ path: alias, sha256: digest }), /symlink/);
  assert.throws(() => acceptance.readOriginal({ path: file, sha256: digest }, 1), /bounded/);
  fs.unlinkSync(file);
  assert.throws(() => acceptance.readOriginal({ path: file, sha256: digest }));
});

test('atomic same-byte replacement between path inspection and descriptor open refuses', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'original'), replacement = path.join(root, 'replacement');
  fs.writeFileSync(original, 'same bytes'); fs.writeFileSync(replacement, 'same bytes');
  const open = fs.openSync;
  fs.openSync = function(file, ...args) {
    if (file === original) fs.renameSync(replacement, original);
    return open.call(fs, file, ...args);
  };
  try {
    assert.throws(() => acceptance.readOriginal({ path: original, sha256: acceptance.sha('same bytes') }),
      /replaced before open/);
  } finally { fs.openSync = open; }
});

test('foreign, unsigned or missing receipt stores refuse without creating authority', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-receipt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'missing-store');
  assert.throws(() => acceptance.originalReceipt({ store, dispatch_id: 'foreign' }));
  assert.equal(fs.existsSync(store), false);
  fs.mkdirSync(store, { mode: 0o700 });
  assert.throws(() => acceptance.originalReceipt({ store, dispatch_id: 'foreign' }), /authority/);
  assert.deepEqual(fs.readdirSync(root), ['missing-store']);
});

test('CLI evidence validation reports HOLD with exit zero, invalid evidence exits nonzero', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify(acceptance.openLedger()));
  const runner = path.resolve(__dirname, '../smoke/phase47-runtime-acceptance.cjs');
  const run = () => spawnSync(process.execPath, [runner, '--evidence', file],
    { encoding: 'utf8', timeout: 10000 });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).accepted, false);
  fs.writeFileSync(file, JSON.stringify({ status: 'completed' }));
  assert.equal(run().status, 1);
});

test('actual packaged bytes refuse tampering, missing shared consumers, extra paths and mode drift', t => {
  const f = productFixture(t);
  assert.equal(acceptance.comparePackage(f.installed, f.binding).package_sha256, f.binding.package_sha256);
  const file = path.join(f.scripts, 'role-artifact.cjs');
  const bytes = fs.readFileSync(file), mode = fs.statSync(file).mode & 0o777;
  fs.appendFileSync(file, '\nforeign\n');
  assert.throws(() => acceptance.comparePackage(f.installed, f.binding), /bytes mismatch/);
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, mode === 0o755 ? 0o644 : 0o755);
  assert.throws(() => acceptance.comparePackage(f.installed, f.binding), /mode mismatch/);
  fs.chmodSync(file, mode);
  const extra = path.join(f.installed, 'foreign'); fs.writeFileSync(extra, 'foreign');
  assert.throws(() => acceptance.comparePackage(f.installed, f.binding), /membership/);
  fs.unlinkSync(extra); fs.unlinkSync(file);
  assert.throws(() => acceptance.comparePackage(f.installed, f.binding), /membership/);
});

test('installed identity checks the actual supported bundle, provenance, runtime and capability', t => {
  const f = productFixture(t);
  const git = (...args) => execFileSync('git', ['-C', REPOSITORY, ...args], { encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const policy = require(path.join(f.scripts, 'model-policy.cjs'));
  const host = path.join(f.temporary, 'shipyard');
  fs.cpSync(path.join(f.installed, 'host/plugins/delivery-pipeline'), host, { recursive: true });
  const reference = (name, value) => {
    const file = path.join(f.temporary, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return { path: file, sha256: acceptance.sha(fs.readFileSync(file)) };
  };
  const candidate = acceptance.sha('fixture candidate');
  const dirty = acceptance.sha(git('status', '--porcelain=v1', '--untracked-files=all'));
  const capabilityRoot = path.join(f.temporary, 'registered-capability');
  fs.cpSync(path.join(f.installed, 'host/capabilities/delivery-pipeline'), capabilityRoot, { recursive: true });
  const capabilityFile = path.join(capabilityRoot, 'capability.json');
  fs.writeFileSync(path.join(f.temporary, 'fixture-agent.toml'), 'fixture-agent');
  const identity = { runtime: 'codex', runtime_root: f.temporary, host_root: host, package_root: f.installed,
    candidate_sha256: candidate, package_sha256: f.binding.package_sha256,
    manifest_sha256: acceptance.sha(fs.readFileSync(path.join(f.installed, '.codex-plugin/plugin.json'))),
    source_head: head, source_tree: tree, source_dirty: false, worktree: REPOSITORY,
    worktree_head: head, worktree_tree: tree, worktree_dirty_sha256: dirty,
    policy_sha256: policy.POLICY_HASH, repository_id: common, run_id: 'fixture-run', controller: 'fixture-controller',
    provenance: reference('provenance.json', { schema: 'shipyard.host-provenance.v1', install_kind: 'dogfood',
      dirty: false, source_sha: head }), capability: { path: capabilityFile, sha256: acceptance.sha(fs.readFileSync(capabilityFile)) },
    agent_manifest: reference('agent-manifest.json', { policy_hash: policy.POLICY_HASH,
      agent_digests: { 'fixture-agent.toml': acceptance.sha('fixture-agent') } }),
    native_capabilities: reference('native-capabilities.json', { supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['high'] }),
    codex_executable: reference('fixture-cli', { fixture: true }) };
  const selected = { selection: { candidate_sha256: candidate }, binding: { ...f.binding,
    source: { head, identities: [], policy_sha256: policy.POLICY_HASH, common } }, identity: { head, tree, dirty_sha256: dirty } };
  assert.equal(acceptance.inspectInstalled(identity, selected).package_sha256, f.binding.package_sha256);
  assert.throws(() => acceptance.inspectInstalled({ ...identity, runtime: 'claude' }, selected), /runtime=codex/);
  assert.throws(() => acceptance.inspectInstalled({ ...identity, candidate_sha256: '0'.repeat(64) }, selected));
  assert.throws(() => acceptance.inspectInstalled({ ...identity, source_dirty: true }, selected));
  assert.throws(() => acceptance.inspectInstalled({ ...identity,
    native_capabilities: reference('empty-capability.json', {}) }, selected), /capabilities/);
  fs.appendFileSync(path.join(host, 'scripts/role-artifact.cjs'), '\nforeign\n');
  assert.throws(() => acceptance.inspectInstalled(identity, selected), /actual installed executable drift/);
});

test('existing boundary original receipt authenticates read-only; copied claims and altered records refuse', t => {
  const f = productFixture(t);
  const boundaryModule = require(path.join(f.scripts, 'dispatch-boundary.cjs'));
  const store = path.join(f.temporary, 'receipts');
  const recorder = boundaryModule.createDurableRecorder(store);
  const agentContent = 'fixture agent';
  const adapter = {
    validateGeneratedAgent: resolution => ({ valid: true, exists: true, content_verified: true,
      policy_hash: resolution.policy_hash, agent_file: resolution.agent_file,
      agent_file_digest: acceptance.sha(agentContent), agent_file_content: agentContent }),
    launchStatic: resolution => ({ receipt_type: 'adr-014.application', runtime: 'codex', role: resolution.role,
      dispatch_id: resolution.dispatch_id, launch_id: 'fixture-' + resolution.dispatch_id,
      requested_model: resolution.model, requested_effort: resolution.effort,
      applied_model: resolution.model, applied_effort: resolution.effort,
      observed_model: resolution.model, observed_effort: resolution.effort,
      agent_file: resolution.agent_file, agent_file_digest: resolution.agent_file_digest,
      policy_hash: resolution.policy_hash }),
  };
  const boundary = boundaryModule.createDispatchBoundary({ recorder, adapters: { codex: adapter }, cwd: f.temporary });
  boundary.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'acceptance-original' }, { ticket: 'fixture' });
  const reference = { store, dispatch_id: 'acceptance-original' };
  const names = fs.readdirSync(f.temporary).sort();
  const original = acceptance.originalReceipt(reference, f.scripts);
  assert.equal(original.receipt.compliance, 'verified');
  assert.deepEqual(fs.readdirSync(f.temporary).sort(), names);
  assert.throws(() => acceptance.originalReceipt({ ...reference, receipt: { ...original.receipt,
    launch_id: 'foreign' } }, f.scripts), /foreign/);
  const file = path.join(store, 'record-' + acceptance.sha(reference.dispatch_id) + '.json');
  const raw = JSON.parse(fs.readFileSync(file)); raw.payload.receipt.launch_id = 'foreign';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => acceptance.originalReceipt(reference, f.scripts), /tampered/);
});

function packagedSuite(t, filename, pattern, count) {
  const f = productFixture(t);
  const sourceFile = path.join(__dirname, filename);
  let source = fs.readFileSync(sourceFile, 'utf8').replaceAll('../../plugins/delivery-pipeline',
    path.join(f.installed, 'host/plugins/delivery-pipeline'));
  const projected = path.join(f.temporary, filename);
  source = source.replaceAll("require('./assert-harness.cjs')",
    'require(' + JSON.stringify(path.join(__dirname, 'assert-harness.cjs')) + ')');
  const script = filename === 'codex-decompose-host.test.cjs'
    ? path.join(f.temporary, 'packaged-entry.cjs') : null;
  if (script) fs.writeFileSync(script, `const Module=require('node:module');
    const fs=require('node:fs');const path=require('node:path');
    const filename=process.argv[2];const source=fs.readFileSync(process.argv[3],'utf8');
    const m=new Module(filename);m.filename=filename;
    m.paths=Module._nodeModulePaths(path.dirname(filename));
    process.mainModule=m;m._compile(source,filename);`);
  fs.writeFileSync(projected, source);
  const env = { ...process.env, CODEX_HOME: path.join(f.temporary, 'codex'),
    GIT_CONFIG_GLOBAL: path.join(f.temporary, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\nname = Acceptance Fixture\nemail = fixture@example.test\n[commit]\ngpgsign = false\n');
  delete env.NODE_OPTIONS; delete env.SHIPYARD_GRAPH_DIR;
  delete env.NODE_TEST_CONTEXT; delete env.SHIPYARD_RESEARCH_HANDBACK_FIXTURE;
  const argv = script ? ['--test-name-pattern', pattern, script, sourceFile, projected]
    : ['--test', '--test-name-pattern', pattern, projected];
  const result = spawnSync(process.execPath, argv, { env, encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'signal=' + result.signal + '\n' + result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp('(?:# |ℹ )pass ' + count + '\\b'));
}

test('packaged detached CLI exercises both public load orders under real parsing', t => {
  packagedSuite(t, 'codex-decompose-host.test.cjs', '^fresh public .* detached CLI', 2);
});

test('packaged semantic completed and artifact-producing blocked callbacks retain original receipt authority', t => {
  packagedSuite(t, 'phase47-research-handback.test.cjs',
    '^(authenticated completed callbacks|artifact-producing blocked worker)', 2);
});

test('packaged legitimate and indirect notify callbacks have independent caps and owned cleanup', t => {
  const f = productFixture(t);
  const harness = path.join(__dirname, 'assert-harness.cjs');
  const source = fs.readFileSync(path.join(__dirname, 'configure-codex-notify.test.cjs'), 'utf8')
    .replace("require('./assert-harness.cjs')", 'require(' + JSON.stringify(harness) + ')')
    .replace(/const SCRIPT = .*;/, 'const SCRIPT = ' + JSON.stringify(path.join(f.installed,
      'host/scripts/configure-codex-notify.cjs')) + ';')
    .replace(/const WRAPPER = .*;/, 'const WRAPPER = ' + JSON.stringify(path.join(f.scripts, 'codex-notify.cjs')) + ';')
    .replace("require('../../scripts/configure-codex-notify.cjs')", 'require(' + JSON.stringify(path.join(f.installed,
      'host/scripts/configure-codex-notify.cjs')) + ')');
  const script = `const h=require(${JSON.stringify(harness)}),original=h.test;
    h.test=(name,fn)=>{if(/^(installed wrapper delivers legitimate|real A→B→A callback)/.test(name))original(name,fn);};
    const Module=require('node:module'),filename=${JSON.stringify(path.join(__dirname, 'configure-codex-notify.test.cjs'))};
    const m=new Module(filename);m.filename=filename;m.paths=Module._nodeModulePaths(${JSON.stringify(__dirname)});
    m._compile(${JSON.stringify(source)},filename);`;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(f.temporary, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.SHIPYARD_GRAPH_DIR;
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 15000,
    maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 passed, 0 failed/);
});

test('first-call inline task attestation refuses a denied heredoc followed by a later hash', t => {
  const f = productFixture(t);
  const task = { path: path.join(f.temporary, 'retained-task.md'), bytes: 4, sha256: acceptance.sha('task') };
  fs.writeFileSync(task.path, 'task', { mode: 0o600 });
  const relay = { parent_thread_id: 'parent', task_path: '/root/gsd_task' };
  const captured = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-parent.jsonl'),
    'utf8').trim().split('\n').map(line => JSON.parse(line));
  const sessionFrame = captured.find(row => row.type === 'session_meta');
  const responseFrame = captured.find(row => row.type === 'response_item');
  assert(sessionFrame && responseFrame, 'registered capture must contain both native frame shapes');
  const response = payload => ({ ...structuredClone(responseFrame), payload });
  const records = [
    { ...structuredClone(sessionFrame), payload: { ...sessionFrame.payload, parent_thread_id: relay.parent_thread_id } },
    response({ type: 'agent_message', author: '/root', recipient: relay.task_path }),
    response({ type: 'custom_tool_call', name: 'exec', call_id: 'first',
      input: 'const r = await tools.exec_command(' + JSON.stringify({ cmd:
        'node -e ' + JSON.stringify('const fs=require("fs"),crypto=require("crypto");console.log(crypto.createHash("sha256").update(fs.readFileSync(' + JSON.stringify(task.path) + ')).digest("hex"))') }) + '); text(r.output);' }),
    response({ type: 'custom_tool_call_output', call_id: 'first', output: task.sha256 }),
  ];
  const jsonl = () => records.map(record => JSON.stringify(record)).join('\n');
  assert.equal(acceptance.validateInlineFirstCall(jsonl(), task, relay, f.scripts), true);
  records[3] = response({ type: 'custom_tool_call_output', call_id: 'first',
    output: 'Script completed\nTASK_SHA256=' + task.sha256 + '\nSOURCE=retained-task.md\nPrior denied HOST outcomes remain denied.' });
  assert.equal(acceptance.validateInlineFirstCall(jsonl(), task, relay, f.scripts), true);
  records[3] = response({ type: 'custom_tool_call_output', call_id: 'first',
    output: 'operation not permitted\nTASK_SHA256=' + task.sha256 + '\nSOURCE=retained-task.md' });
  assert.throws(() => acceptance.validateInlineFirstCall(jsonl(), task, relay, f.scripts), /first call was denied/);
  const good = records[2];
  records[2] = response({ ...good.payload, input: "python - <<'PY'\nread denied\nPY" });
  records[3] = response({ type: 'custom_tool_call_output', call_id: 'first', output: 'operation not permitted' });
  records.push(response({ ...good.payload, call_id: 'later' }),
    response({ type: 'custom_tool_call_output', call_id: 'later', output: task.sha256 }));
  assert.throws(() => acceptance.validateInlineFirstCall(jsonl(), task, relay, f.scripts), /first call/);
});


test('current candidate refusal cannot be converted to missing-native HOLD', () => {
  const ledger = acceptance.openLedger();
  ledger.candidate = { candidate_path: '/tmp/foreign-final-candidate' };
  assert.throws(() => acceptance.validateLedger(ledger));
});

test('a corrective ledger requires the exact signed retained original ledger', () => {
  const ledger = acceptance.openLedger();
  ledger.corrective_generation = { original_ledger: { path: '/tmp/foreign', sha256: '0'.repeat(64) } };
  assert.throws(() => acceptance.validateLedger(ledger));
});


test('current successor allocation keeps the original inventories separate', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  assert.equal(publication.SUCCESSOR_CORRECTIVE.length, 5);
  assert.equal(publication.CORRECTIVE.length, 9);
  assert.notEqual(publication.SUCCESSOR_HANDOFF, publication.FINAL_HANDOFF);
  assert.notEqual(publication.SUCCESSOR_HANDOFF_SHA, publication.FINAL_HANDOFF_SHA);
  for (const kind of ['foreign', 'ADR-026', ''])
    assert.throws(() => acceptance.inspectCandidate(null, REPOSITORY, kind), /unknown generation branch/);
});

test('successor contract refuses missing, stale, foreign and expanded authority', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  const handback = { purpose: 'ADR-027-current-ticket-evidence', source_head: 'c9bd8ccae0c688e034cf9f94df4ad0cfc4c909b7',
    changed_outputs: publication.SUCCESSOR_CORRECTIVE,
    corrective_allocation: { 'T-47-21': publication.SUCCESSOR_CORRECTIVE } };
  for (const approval of [{}, { purpose: 'ADR-026-final' }, { actor: 'trusted-coordinator', native_receipt: false },
    { source_head: '8192ba38942be328b27f8aa54984eae7cd47231c' }])
    assert.throws(() => publication.validateSuccessorContract(handback, approval));
});

test('volume successor retains distinct three, five and nine output contracts', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  assert.equal(publication.VOLUME_CORRECTIVE.length, 3);
  assert.equal(publication.SUCCESSOR_CORRECTIVE.length, 5);
  assert.equal(publication.CORRECTIVE.length, 9);
  assert.notEqual(publication.VOLUME_HANDOFF, publication.SUCCESSOR_HANDOFF);
  assert.notEqual(publication.VOLUME_HANDOFF_SHA, publication.SUCCESSOR_HANDOFF_SHA);
  assert.throws(() => acceptance.inspectCandidate(null, REPOSITORY, 'volume'), /unknown generation branch/);
});

test('volume successor refuses foreign, incomplete and expanded current approval', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  for (const approval of [{}, { purpose: 'ADR-027-current-ticket-evidence' },
    { native_receipt: true }, { source_head: 'c9bd8ccae0c688e034cf9f94df4ad0cfc4c909b7' }])
    assert.throws(() => publication.validateVolumeContract({}, approval));
});

test('volume contract checks both configuration identities and current checker plans', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  const phase = '.planning/phases/47-complete-deferred-decomposition-wait-attribution';
  const plan22 = '5225fd21717e38d59a10c2921e1e1dfd8b54c0a2bc1c3e1115a623485095b7b7';
  const plan23 = 'c6a3f59e634d5683b2c7cda80520d0d4584dffb4bf9ad2d62bab67dddcedfc8c';
  const handback = { purpose: 'ADR-027-current-ticket-volume',
    source_head: '462683f52df5c3e2ab45a08d8a5e72f9281e5750',
    changed_outputs: publication.VOLUME_CORRECTIVE,
    corrective_allocation: { 'T-47-23': publication.VOLUME_CORRECTIVE },
    tail_plan_amendments: [{ sha256: plan22 }, { sha256: plan23 }],
    current_checker: { verdict: { status: 'passed', blockers: [], input_sha256: {
      [phase + '/47-22-PLAN.md']: plan22, [phase + '/47-23-PLAN.md']: plan23 } } } };
  const approval = { ...handback, schema: 'shipyard.phase47-current-source-approval.v1',
    status: 'approved', actor: 'trusted-coordinator', native_receipt: false,
    reviewed_source_config_sha256: '2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9',
    coordinator_config_sha256: '63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780' };
  publication.validateVolumeContract(handback, approval);
  for (const mutation of [{ reviewed_source_config_sha256: approval.coordinator_config_sha256 },
    { coordinator_config_sha256: approval.reviewed_source_config_sha256 },
    { corrective_allocation: { 'T-47-23': publication.SUCCESSOR_CORRECTIVE } },
    { tail_plan_amendments: [{ sha256: plan23 }, { sha256: plan22 }] },
    { current_checker: { verdict: { status: 'failed', blockers: ['missing inputs'] } } }])
    assert.throws(() => publication.validateVolumeContract(handback, { ...approval, ...mutation }));
  assert.throws(() => publication.validateVolumeContract({ ...handback,
    changed_outputs: publication.SUCCESSOR_CORRECTIVE }, approval));
});

test('main-review-repair contract refuses configuration swaps and forged publication authority', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  const { REPAIR_CORRECTIVE, REPAIR_PLANS, VOLUME_HANDOFF, VOLUME_HANDOFF_SHA, SOURCE39_SHA, COORDINATOR48_SHA, HISTORICAL43_SHA } = publication;
  const PHASE = '.planning/phases/47-complete-deferred-decomposition-wait-attribution';
  const repairFixture = { purpose: 'ADR-027-main-review-repair', source_head: 'a'.repeat(40),
      changed_outputs: REPAIR_CORRECTIVE, corrective_allocation: { 'T-47-27': REPAIR_CORRECTIVE },
      tail_plan_amendments: REPAIR_PLANS.map(sha256 => ({ sha256 })),
      prior_final_handoff: { path: VOLUME_HANDOFF, sha256: VOLUME_HANDOFF_SHA },
      source_correction: { strict_configuration_identity: { source39: SOURCE39_SHA,
        coordinator48: COORDINATOR48_SHA, historical43: HISTORICAL43_SHA },
      command_approval: { path: '/tmp/phase47-main-review-exact-command-approval.json',
        sha256: '2e7bd51c86d5eff1d65fe09fcf3d366cd27d5dd98eea86a7af0689ae2009696e' } },
      current_checker: { verdict: { status: 'passed', blockers: [], artifact_paths: [], input_sha256:
        Object.fromEntries(REPAIR_PLANS.map((digest, i) => [PHASE + '/47-' + (24 + i) + '-PLAN.md', digest])) } } };

  const approval = { ...repairFixture, schema: 'shipyard.phase47-current-source-approval.v1',
    status: 'approved', actor: 'trusted-coordinator', native_receipt: false,
    reviewed_source_config_sha256: SOURCE39_SHA, coordinator_config_sha256: COORDINATOR48_SHA };
  publication.validateRepairContract(repairFixture, approval);
  const followup = structuredClone(repairFixture);
  followup.source_head = '485058d9797efc40469a6db005dc4449e68015b1';
  followup.changed_outputs = publication.F1_CORRECTIVE;
  followup.corrective_allocation['T-47-27'] = publication.F1_CORRECTIVE;
  followup.source_correction.scope_disposition = { path: '/tmp/phase47-F1-existing-contract-scope.json', sha256: 'a'.repeat(64) };
  followup.source_correction.previous_repair_publication = { path: publication.REPAIR_HANDOFF, sha256: publication.REPAIR_HANDOFF_SHA };
  const followupApproval = { ...structuredClone(approval), ...structuredClone(followup) };
  publication.validateRepairContract(followup, followupApproval, true);
  for (const mutate of [r => { r.changed_outputs = publication.REPAIR_CORRECTIVE; },
    r => { r.corrective_allocation['T-47-27'] = publication.REPAIR_CORRECTIVE; },
    r => { r.source_correction.previous_repair_publication.sha256 = '0'.repeat(64); },
    r => { r.source_correction.previous_repair_publication.path = publication.F1_HANDOFF; },
    r => { r.source_correction.scope_disposition.path = '/tmp/foreign.json'; },
    r => { r.source_head = repairFixture.source_head; }]) {
    const changed = structuredClone(followup); mutate(changed);
    assert.throws(() => publication.validateRepairContract(changed, { ...followupApproval, ...changed }, true));
  }
  const r2 = structuredClone(followup);
  r2.source_head = '15a205063774993bc35404b5c8c8f1013f98b016';
  r2.source_correction.scope_disposition.path = '/tmp/phase47-R2-existing-contract-scope.json';
  r2.source_correction.previous_current_publication = {
    path: publication.F1_HANDOFF, sha256: publication.F1_HANDOFF_SHA,
    historical_source_contract: publication.F1_HISTORICAL_CONTRACT,
    selection_path: '/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/selection.json',
    selection_sha256: '68623cda4d53280dca2ad625589a45680b54949ed69afad81f3598cddc5d00f5',
    binding_path: '/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/12b4367bd4d9aaf0dbaea193a5c6693de09499c652a59b3d935d9cad5e022fa8/binding.json',
    binding_sha256: '3753108de3d078bc90ee50c8618f28f6170b03756c94f2419855ba80c1ed7523' };
  const r2Approval = { ...structuredClone(approval), ...structuredClone(r2) };
  publication.validateRepairContract(r2, r2Approval, 'R2');
  for (const key of ['selection_path', 'selection_sha256', 'binding_path', 'binding_sha256']) {
    for (const missing of [true, false]) {
      const changed = structuredClone(r2);
      if (missing) delete changed.source_correction.previous_current_publication[key];
      else changed.source_correction.previous_current_publication[key] = key.endsWith('_sha256') ? '0'.repeat(64) : '/foreign/' + key;
      const changedApproval = { ...structuredClone(r2Approval), ...structuredClone(changed) };
      assert.throws(() => publication.validateRepairContract(changed, changedApproval, 'R2'),
        new RegExp('previous GENF1 drift: ' + key));
    }
  }
  assert.equal(publication.F1_CORRECTIVE.length, 3);
  assert.equal(publication.F1_HANDOFF_SHA, '27ca0d42db637e83f181d398f0d047959d4295a8486967cfe798dd24476e5509');

  for (const mutate of [a => { a.coordinator_config_sha256 = SOURCE39_SHA; },
    a => { a.reviewed_source_config_sha256 = COORDINATOR48_SHA; },
    a => { a.coordinator_config_sha256 = HISTORICAL43_SHA; },
    a => { a.current_checker.verdict.status = 'blocked'; },
    a => { a.current_checker.verdict.input_sha256[PHASE + '/47-27-PLAN.md'] = '0'.repeat(64); },
    a => { a.corrective_allocation['T-47-27'].push('foreign'); },
    a => { a.prior_final_handoff.sha256 = '0'.repeat(64); },
    a => { a.source_correction.strict_configuration_identity.historical43 = SOURCE39_SHA; },
    a => { a.native_receipt = true; }]) {
    const altered = structuredClone(approval); mutate(altered);
    assert.throws(() => publication.validateRepairContract(repairFixture, altered));
  }
  assert.equal(publication.REPAIR_CORRECTIVE.length, 8);
  assert.equal(publication.VOLUME_CORRECTIVE.length, 3);
  assert.notEqual(publication.REPAIR_HANDOFF, publication.VOLUME_HANDOFF);
  for (const selector of ['main-review', 'repair', 'ADR-027-main-review-repair'])
    assert.throws(() => acceptance.inspectCandidate(null, REPOSITORY, selector), /unknown generation branch/);
});

test('a publication fixture cannot advance original native HOLD obligations', () => {
  const ledger = acceptance.openLedger();
  const result = acceptance.validateLedger(ledger);
  assert.equal(result.status, 'HOLD');
  assert.equal(result.accepted, false);
  assert.equal(result.native_launches, 0);
  assert.equal(ledger.obligations.length, 20);
  const forged = structuredClone(ledger);
  forged.obligations[0] = { ...forged.obligations[0], status: 'proven',
    proof: { kind: 'main-review-repair', package_parity: true, build_calls: 0 } };
  assert.throws(() => acceptance.validateLedger(forged), /original proof/);
});


function hostRecordsAvailable(t, files) {
  if (process.env.SHIPYARD_PHASE47_HOST_TESTS !== '1') {
    t.skip('explicit host integration requires SHIPYARD_PHASE47_HOST_TESTS=1');
    return false;
  }
  for (const file of files) {
    try { fs.accessSync(file, fs.constants.R_OK); }
    catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      t.skip('original host evidence unavailable: ' + file);
      return false;
    }
  }
  return true;
}

test('historical volume materialization binds original index and entry to the exact current handoff', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  const row = publication.ORIGINAL_ENTRIES.find(item =>
    item.predecessor_handoff.path === publication.VOLUME_HANDOFF);
  const indexed = { path: row.original_path, bytes: row.bytes, sha256: row.sha256 };
  const entry = { ...indexed, physical_path: row.original_physical_path };
  const record = { schema: 'shipyard.phase47-historical-planner-materialization.v1',
    actor: 'trusted-coordinator', native_receipt: false,
    volume_handoff: { path: publication.VOLUME_HANDOFF, sha256: publication.VOLUME_HANDOFF_SHA },
    current_handoff: { path: publication.REPAIR_HANDOFF, sha256: publication.REPAIR_HANDOFF_SHA },
    original_artifact_index: row.original_artifact_index,
    entry: { original_path: row.original_path, original_physical_path: row.original_physical_path,
      bytes: row.bytes, sha256: row.sha256, retained_path: path.join(path.dirname(publication.REPAIR_HANDOFF), 'volume-original-CONTEXT.md') },
    current_context: { path: row.original_physical_path, bytes: row.current_bytes,
      sha256: row.current_sha256 } };
  publication.validateVolumeMaterialization(record, record.original_artifact_index, indexed, entry);
  for (const mutate of [r => { r.entry.sha256 = '0'.repeat(64); },
    r => { r.entry.bytes++; }, r => { r.entry.original_path += '-foreign'; },
    r => { r.original_artifact_index.sha256 = '0'.repeat(64); },
    r => { r.original_artifact_index.path += '-foreign'; },
    r => { r.current_handoff.sha256 = publication.VOLUME_HANDOFF_SHA; },
    r => { r.volume_handoff.sha256 = publication.REPAIR_HANDOFF_SHA; },
    r => { r.entry.retained_path += '-foreign'; },
    r => { r.current_context.sha256 = r.entry.sha256; },
    r => { r.actor = 'caller'; }]) {
    const altered = structuredClone(record); mutate(altered);
    assert.throws(() => publication.validateVolumeMaterialization(altered,
      record.original_artifact_index, indexed, entry));
  }
  assert.throws(() => publication.validateVolumeMaterialization(record,
    record.original_artifact_index, { ...indexed, bytes: indexed.bytes + 1 }, entry));
  for (const status of ['', '[GNUPG:] VALIDSIG ' + '0'.repeat(40),
    '[GNUPG:] VALIDSIG 2F485C0A455BA33463F66332900FCE87BD1BFF0D\n[GNUPG:] VALIDSIG foreign'])
    assert.throws(() => publication.validateOperatorSignature(status));
  publication.validateOperatorSignature('[GNUPG:] VALIDSIG 2F485C0A455BA33463F66332900FCE87BD1BFF0D');
});

test('host-only historical volume materialization authenticates retained original bytes', t => {
  const publication = require('./phase47-package-publication.test.cjs');
  if (!hostRecordsAvailable(t, [publication.MATERIALIZATION])) return;
  const record = JSON.parse(fs.readFileSync(publication.MATERIALIZATION));
  if (!hostRecordsAvailable(t, [record.original_artifact_index.path, record.entry.retained_path])) return;
  const index = JSON.parse(fs.readFileSync(record.original_artifact_index.path));
  const indexed = index.entries.find(row => row.path === record.entry.original_path);
  const entry = { ...indexed, physical_path: record.entry.original_physical_path };
  publication.validateVolumeMaterialization(record, record.original_artifact_index, indexed, entry);
  for (const mutate of [r => { r.entry.sha256 = '0'.repeat(64); },
    r => { r.entry.bytes++; }, r => { r.entry.original_path += '-foreign'; },
    r => { r.original_artifact_index.sha256 = '0'.repeat(64); },
    r => { r.original_artifact_index.path += '-foreign'; },
    r => { r.current_handoff.sha256 = publication.VOLUME_HANDOFF_SHA; },
    r => { r.volume_handoff.sha256 = publication.REPAIR_HANDOFF_SHA; },
    r => { r.entry.retained_path += '-foreign'; },
    r => { r.current_context.sha256 = r.entry.sha256; },
    r => { r.actor = 'caller'; }]) {
    const altered = structuredClone(record); mutate(altered);
    assert.throws(() => publication.validateVolumeMaterialization(altered,
      record.original_artifact_index, indexed, entry));
  }
  assert.throws(() => publication.validateVolumeMaterialization(record,
    record.original_artifact_index, { ...indexed, bytes: indexed.bytes + 1 }, entry));
  for (const status of ['', '[GNUPG:] VALIDSIG ' + '0'.repeat(40),
    '[GNUPG:] VALIDSIG 2F485C0A455BA33463F66332900FCE87BD1BFF0D\n[GNUPG:] VALIDSIG foreign'])
    assert.throws(() => publication.validateOperatorSignature(status));
  publication.validateOperatorSignature('[GNUPG:] VALIDSIG 2F485C0A455BA33463F66332900FCE87BD1BFF0D');
  const retained = fs.readFileSync(record.entry.retained_path);
  assert.equal(retained.length, record.entry.bytes);
  assert.equal(crypto.createHash('sha256').update(retained).digest('hex'), record.entry.sha256);
  const tampered = Buffer.from(retained); tampered[0] ^= 1;
  assert.notEqual(crypto.createHash('sha256').update(tampered).digest('hex'), record.entry.sha256);
});

test('v2 original materialization fixes exactly three predecessor/index/role entries', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  const rows = structuredClone(publication.ORIGINAL_ENTRIES);
  const record = { schema: 'shipyard.phase47-historical-planner-materialization.v2',
    actor: 'trusted-coordinator', native_receipt: false,
    current_handoff: { path: publication.REPAIR_HANDOFF, sha256: publication.REPAIR_HANDOFF_SHA },
    previous_materialization: { path: publication.MATERIALIZATION, sha256: publication.MATERIALIZATION_SHA },
    entries: rows };
  for (const row of rows) {
    const indexed = { path: row.original_path, bytes: row.bytes, sha256: row.sha256 };
    const entry = { ...indexed, physical_path: row.original_physical_path };
    const validate = (r, predecessor = row.predecessor_handoff, result = row.native_result,
      index = row.original_artifact_index) => publication.validateOriginalMaterialization(
      r, predecessor, result, index, indexed, entry);
    assert.deepEqual(validate(record), row);
    assert.throws(() => publication.validateOriginalMaterialization(record,
      row.predecessor_handoff, row.native_result, row.original_artifact_index,
      { ...indexed, path: indexed.path + '-foreign' }, entry), { code: 'ERR_ASSERTION' });
    for (const field of ['sha256', 'bytes', 'current_sha256', 'retained_path']) {
      const changed = structuredClone(record);
      const target = changed.entries.find(item => item.sha256 === row.sha256);
      target[field] = typeof target[field] === 'number' ? target[field] + 1 : target[field] + '-tampered';
      assert.throws(() => validate(changed), { code: 'ERR_ASSERTION' });
    }
    assert.throws(() => validate(record, { ...row.predecessor_handoff, sha256: '0'.repeat(64) }), { code: 'ERR_ASSERTION' });
    assert.throws(() => validate(record, row.predecessor_handoff,
      { ...row.native_result, path: row.native_result.path + '-foreign-role' }), { code: 'ERR_ASSERTION' });
    assert.throws(() => validate(record, row.predecessor_handoff, row.native_result,
      { ...row.original_artifact_index, sha256: '0'.repeat(64) }), { code: 'ERR_ASSERTION' });
  }
  for (const entries of [rows.slice(1), [...rows, rows[0]], [rows[1], rows[0], rows[2]]])
    assert.throws(() => publication.validateOriginalMaterialization({ ...record, entries },
      rows[0].predecessor_handoff, rows[0].native_result, rows[0].original_artifact_index,
      { path: rows[0].original_path, bytes: rows[0].bytes, sha256: rows[0].sha256 },
      { path: rows[0].original_path, physical_path: rows[0].original_physical_path,
        bytes: rows[0].bytes, sha256: rows[0].sha256 }), { code: 'ERR_ASSERTION' });
});


test('host-only source-repair coverage uses genuine fixed authority with temporary HOME and refuses foreign records', t => {
  const publication = require('./phase47-package-publication.test.cjs');
  if (!hostRecordsAvailable(t, [publication.REPAIR_HANDOFF])) return;
  const handback = JSON.parse(fs.readFileSync(publication.REPAIR_HANDOFF));
  const coverageRoot = path.resolve(path.dirname(path.dirname(publication.REPAIR_HANDOFF)), '../../coverage');
  if (!hostRecordsAvailable(t, [handback.current_source_approval.path, path.join(coverageRoot, 'coverage.key')])) return;
  const approval = JSON.parse(fs.readFileSync(handback.current_source_approval.path));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'p47-coverage-home-'));
  const previousHome = process.env.HOME;
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  try {
    process.env.HOME = temporary;
    assert.equal(os.homedir(), temporary);
    for (const repair of approval.source_correction.source_repairs) {
      assert.deepEqual(publication.reauthenticateRepairCoverage(repair), repair.coverage);
      const tampered = structuredClone(repair);
      tampered.coverage.record.tree = 'f'.repeat(40);
      assert.throws(() => publication.reauthenticateRepairCoverage(tampered));
      const foreign = structuredClone(repair);
      foreign.coverage.record.repo = 'foreign/phase47-coverage';
      assert.throws(() => publication.reauthenticateRepairCoverage(foreign));
    }
    assert.deepEqual(fs.readdirSync(temporary), []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('source-repair coverage routes fixed authority independently of HOME and rejects fixture tampering', t => {
  const publication = require('./phase47-package-publication.test.cjs');
  const cv = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
  const { stableStringify } = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-coverage-fixture-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'authority'), home = path.join(temporary, 'missing-host-home');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(home);
  const key = crypto.randomBytes(32), keyPath = path.join(root, 'coverage.key');
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY, encoding: 'utf8' }).trim();
  const metadata = execFileSync('git', ['show', '-s', '--format=%P%n%T', commit],
    { cwd: REPOSITORY, encoding: 'utf8' }).trimEnd().split('\n');
  const repo = 'fixture/phase47';
  const record = { kind: 'remedy', commit, repo, repository_id: cv.repositoryIdentity(REPOSITORY),
    parents: metadata[0] ? metadata[0].split(' ') : [], tree: metadata[1],
    remedy: { workflow: 'fixture.yml', run_id: '1', dispatch_head: commit } };
  const file = path.join(root, 'coverage', encodeURIComponent(repo), commit + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = payload => fs.writeFileSync(file, JSON.stringify({ format: 'shipyard.conveyor-coverage.v1',
    payload, integrity: { algorithm: 'hmac-sha256',
      mac: crypto.createHmac('sha256', key).update(stableStringify(payload)).digest('hex') } }));
  write(record);
  const repair = { current_head: commit, coverage: { covered: true, record } };
  const fixedRoot = path.resolve(path.dirname(path.dirname(publication.REPAIR_HANDOFF)), '../../coverage');
  let calls = 0;
  const verifyFixture = options => {
    calls++;
    assert.deepEqual(options, { commit, repo: options.repo, worktree: REPOSITORY,
      root: fixedRoot, keyPath: path.join(fixedRoot, 'coverage.key') });
    return cv.verify({ ...options, root, keyPath });
  };
  const previousHome = process.env.HOME, previousRoot = process.env.SHIPYARD_COVERAGE_ROOT;
  try {
    process.env.HOME = home; process.env.SHIPYARD_COVERAGE_ROOT = home;
    assert.equal(os.homedir(), home);
    assert.deepEqual(publication.reauthenticateRepairCoverage(repair, REPOSITORY, verifyFixture), repair.coverage);
    const altered = structuredClone(repair); altered.coverage.record.tree = 'f'.repeat(40);
    assert.throws(() => publication.reauthenticateRepairCoverage(altered, REPOSITORY, verifyFixture), { code: 'ERR_ASSERTION' });
    const foreign = structuredClone(repair); foreign.coverage.record.repo = 'foreign/phase47';
    assert.throws(() => publication.reauthenticateRepairCoverage(foreign, REPOSITORY, verifyFixture), { code: 'ERR_ASSERTION' });
    const raw = JSON.parse(fs.readFileSync(file)); raw.payload.tree = 'f'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => publication.reauthenticateRepairCoverage(repair, REPOSITORY, verifyFixture), /unauthenticated/);
    write({ ...record, tree: 'f'.repeat(40) });
    assert.throws(() => publication.reauthenticateRepairCoverage(repair, REPOSITORY, verifyFixture), /metadata mismatch/);
    fs.unlinkSync(keyPath);
    assert.throws(() => publication.reauthenticateRepairCoverage(repair, REPOSITORY, verifyFixture), /ENOENT/);
    assert.equal(calls, 6);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    for (const [name, value] of [['HOME', previousHome], ['SHIPYARD_COVERAGE_ROOT', previousRoot]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});


test('F1 narrowed scope and previous GEN27 identities refuse widened or substituted authority', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const scope = { schema: 'shipyard.phase47-existing-contract-remedy.v1', actor: 'trusted-coordinator',
    native_receipt: false, status: 'approved', finding: { id: 'F1' }, ticket_count: 27, new_tickets: 0,
    source_ticket: 'T-47-26', source_pr: 447, publication_ticket: 'T-47-27',
    actual_corrective_package_outputs: p.F1_CORRECTIVE, publication_files: p.REPAIR_OWNERS,
    preserve_previous_generation: { path: p.REPAIR_HANDOFF, sha256: p.REPAIR_HANDOFF_SHA },
    plan_pins: p.REPAIR_PLANS.map(sha256 => ({ sha256 })), config_sha256: p.COORDINATOR48_SHA,
    historical_index_sha256: 'f28d939b31f05fc9ca1da2ce024151e04449a4c1e84315fd56b0d449bf2fc58e' };
  p.validateF1Scope(scope);
  for (const mutate of [r => { r.new_tickets = 1; }, r => { r.ticket_count = 28; },
    r => { r.publication_files.push('foreign'); }, r => { r.actual_corrective_package_outputs = p.REPAIR_CORRECTIVE; },
    r => { r.plan_pins[3].sha256 = '0'.repeat(64); }, r => { r.config_sha256 = p.SOURCE39_SHA; },
    r => { r.preserve_previous_generation.sha256 = '0'.repeat(64); }, r => { r.native_receipt = true; }]) {
    const altered = structuredClone(scope); mutate(altered); assert.throws(() => p.validateF1Scope(altered));
  }
  const previous = { selection_path: '/fixed/selection.json', selection_sha256: 'a'.repeat(64),
    binding_path: '/fixed/binding.json', binding_sha256: 'b'.repeat(64) };
  const ref = { path: p.REPAIR_HANDOFF, sha256: p.REPAIR_HANDOFF_SHA, ...previous };
  p.validatePreviousRepairPublication(ref, previous);
  for (const key of Object.keys(ref))
    assert.throws(() => p.validatePreviousRepairPublication({ ...ref, [key]: 'foreign' }, previous));
});

test('fresh F1 materializations retain exact original three mappings and frozen byte identities', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const previousV1 = { current_handoff: { path: p.REPAIR_HANDOFF, sha256: p.REPAIR_HANDOFF_SHA },
    entry: { retained_path: path.join(path.dirname(p.REPAIR_HANDOFF), 'volume-original-CONTEXT.md'), bytes: 224296,
      sha256: '79c335ae5ab21f168ac86d1d890e66a577c621c1e5c180d1e2b0e3eccfa240b0' } };
  const previousV2 = { current_handoff: previousV1.current_handoff,
    previous_materialization: { path: p.MATERIALIZATION, sha256: p.MATERIALIZATION_SHA }, entries: p.ORIGINAL_ENTRIES };
  const v1 = structuredClone(previousV1), v2 = structuredClone(previousV2);
  for (const fresh of [v1, v2]) fresh.current_handoff = { path: p.F1_HANDOFF, sha256: 'a'.repeat(64) };
  v2.previous_materialization = { path: path.join(path.dirname(p.F1_HANDOFF), 'historical-materialization.json'), sha256: 'b'.repeat(64) };
  for (const row of [v1.entry, ...v2.entries]) row.retained_path = path.join(path.dirname(p.F1_HANDOFF), path.basename(row.retained_path));
  const check = (first = v1, second = v2) => p.validateFreshMaterializations(first, second, previousV1, previousV2, 'a'.repeat(64), 'b'.repeat(64));
  check();
  for (const mutate of [r => { r.entries.pop(); }, r => { r.entries.reverse(); },
    r => { r.entries[0].sha256 = '0'.repeat(64); }, r => { r.entries[1].native_result.sha256 = '0'.repeat(64); },
    r => { r.entries[2].original_artifact_index.sha256 = '0'.repeat(64); },
    r => { r.entries[0].retained_path = p.ORIGINAL_ENTRIES[0].retained_path; },
    r => { r.current_handoff.sha256 = p.REPAIR_HANDOFF_SHA; },
    r => { r.previous_materialization.sha256 = p.MATERIALIZATION_SHA; }]) {
    const changed = structuredClone(v2); mutate(changed); assert.throws(() => check(v1, changed));
  }
  const changed = structuredClone(v1); changed.entry.bytes++; assert.throws(() => check(changed));
});

test('fixed GEN27 historical parent contract uses signed attestations without a raw board (non-native fixture)', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  const source = { head: 'a'.repeat(40), delivery_state_sha256: 'b'.repeat(64), parent_commits: {}, provenance: {} };
  for (let n = 1; n <= 26; n++) {
    const id = 'T-47-' + String(n).padStart(2, '0');
    source.parent_commits[id] = { head: 'c'.repeat(40), merge: source.head, base_merge_commits: [source.head] };
    source.provenance[id] = { pr: n, base: 'epic/47', url: 'https://github.com/serhii-nochevnyi/shipyard/pull/' + n, state_sha256: 'd'.repeat(64) };
  }
  const approval = structuredClone(source);
  let ancestors = 0;
  const ancestor = (before, after) => { assert.equal(before, source.head); assert.equal(after, source.head); ancestors++; };
  publication.validateSignedHistoricalParents(source, approval, ancestor);
  assert.equal(ancestors, 52);
  for (const mutate of [
    s => { s.parent_commits['T-47-26'].merge = 'e'.repeat(40); },
    s => { s.provenance['T-47-26'].state_sha256 = 'e'.repeat(64); },
    s => { delete s.parent_commits['T-47-01']; },
    s => { s.provenance['T-47-01'].pr = 0; },
    s => { s.provenance['T-47-01'].base = ''; },
    s => { s.provenance['T-47-01'].url = 'https://example.org'; },
    s => { s.provenance['T-47-01'].state_sha256 = 'invalid'; },
    s => { s.parent_commits['T-47-01'].head = 'invalid'; },
  ]) {
    const changed = structuredClone(source); mutate(changed);
    assert.throws(() => publication.validateSignedHistoricalParents(changed, approval, ancestor));
    if (Object.keys(changed.parent_commits).length !== 26 || changed.provenance['T-47-01'].pr === 0
      || changed.provenance['T-47-01'].base === '' || changed.provenance['T-47-01'].url === 'https://example.org'
      || changed.provenance['T-47-01'].state_sha256 === 'invalid' || changed.parent_commits['T-47-01']?.head === 'invalid')
      assert.throws(() => publication.validateSignedHistoricalParents(changed, structuredClone(changed), ancestor));
  }
});

test('historical resolution refuses foreign original tuple and tampered resolution before native reads', () => {
  const publication = require('./phase47-package-publication.test.cjs');
  for (const ref of [null, { path: '/tmp/foreign-contract.json', sha256: '0'.repeat(64) },
    { path: '/tmp/phase47-F1-pinned-historical-source-contract.json', sha256: '0'.repeat(64) }])
    assert.throws(() => publication.authenticatePinnedHistoricalContract(ref, {}, {}));
});

test('historical identity equality refuses altered original tuple (non-native fixture)', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const source = { head: 'a'.repeat(40), delivery_state_sha256: 'b'.repeat(64) };
  const contract = { original_generation: { path: p.REPAIR_HANDOFF, sha256: p.REPAIR_HANDOFF_SHA },
    original_source_identity_sha256: crypto.createHash('sha256').update(acceptance.canonical(source)).digest('hex'),
    original_source_head: source.head, original_delivery_state_digest: source.delivery_state_sha256, original_parent_count: 26 };
  const original = { source_identity_sha256: contract.original_source_identity_sha256 };
  p.validatePinnedHistoricalIdentity(contract, source, original);
  for (const mutate of [c => { c.original_generation.sha256 = '0'.repeat(64); },
    c => { c.original_generation.path = p.F1_HANDOFF; }, c => { c.original_source_head = 'e'.repeat(40); },
    c => { c.original_delivery_state_digest = 'e'.repeat(64); }, c => { c.original_parent_count = 27; }]) {
    const changed = structuredClone(contract); mutate(changed);
    assert.throws(() => p.validatePinnedHistoricalIdentity(changed, source, original));
  }
  assert.throws(() => p.validatePinnedHistoricalIdentity(contract, { ...source, head: 'e'.repeat(40) }, original));
});


test('R2 exact scope and pinned GENF1 history refuse missing or tampered references', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const scope = { schema: 'shipyard.phase47-existing-contract-remedy.v1', actor: 'trusted-coordinator',
    native_receipt: false, status: 'approved', finding: { id: 'F2' }, ticket_count: 27, new_tickets: 0,
    source_ticket: 'T-47-26', source_pr: 449, publication_ticket: 'T-47-27',
    actual_corrective_package_outputs: p.F1_CORRECTIVE, publication_files: p.REPAIR_OWNERS,
    preserve_previous_generation: { path: p.REPAIR_HANDOFF, sha256: p.REPAIR_HANDOFF_SHA },
    preserve_previous_current_generation: { path: p.F1_HANDOFF, sha256: p.F1_HANDOFF_SHA },
    plan_pins: p.REPAIR_PLANS.map(sha256 => ({ sha256 })), config_sha256: p.COORDINATOR48_SHA,
    historical_index_sha256: 'f28d939b31f05fc9ca1da2ce024151e04449a4c1e84315fd56b0d449bf2fc58e' };
  p.validateR2Scope(scope);
  for (const mutate of [s => { s.source_pr = 447; }, s => { s.finding.id = 'F1'; },
    s => { s.actual_corrective_package_outputs.push('foreign'); },
    s => { delete s.preserve_previous_current_generation; },
    s => { s.preserve_previous_current_generation.sha256 = '0'.repeat(64); }]) {
    const altered = structuredClone(scope); mutate(altered); assert.throws(() => p.validateR2Scope(altered));
  }
  const previous = { selection_path: '/fixed/selection.json', selection_sha256: 'a'.repeat(64),
    binding_path: '/fixed/binding.json', binding_sha256: 'b'.repeat(64) };
  const ref = { path: p.F1_HANDOFF, sha256: p.F1_HANDOFF_SHA, ...previous,
    historical_source_contract: p.F1_HISTORICAL_CONTRACT };
  p.validatePreviousCurrentPublication(ref, previous);
  for (const key of Object.keys(ref)) {
    const altered = structuredClone(ref); delete altered[key];
    assert.throws(() => p.validatePreviousCurrentPublication(altered, previous));
    assert.throws(() => p.validatePreviousCurrentPublication({ ...ref, [key]: 'foreign' }, previous));
  }
  if (p.R2_HANDOFF_SHA !== null) assert.match(p.R2_HANDOFF_SHA, /^[a-f0-9]{64}$/);
  assert.notEqual(p.R2_HANDOFF, p.F1_HANDOFF);
});


test('exact GENF1 historical identity retains its separate pin and signed source attestation', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const source = { head: '485058d9797efc40469a6db005dc4449e68015b1', delivery_state_sha256: 'b'.repeat(64) };
  const contract = { original_generation: { path: p.F1_HANDOFF, sha256: p.F1_HANDOFF_SHA },
    original_source_identity_sha256: crypto.createHash('sha256').update(acceptance.canonical(source)).digest('hex'),
    original_source_head: source.head, original_delivery_state_digest: source.delivery_state_sha256, original_parent_count: 26 };
  const original = { source_identity_sha256: contract.original_source_identity_sha256 };
  p.validatePinnedHistoricalIdentity(contract, source, original, true);
  assert.throws(() => p.validatePinnedHistoricalIdentity(contract, source, original));
  for (const mutate of [r => { r.original_generation.path = p.REPAIR_HANDOFF; },
    r => { r.original_generation.sha256 = p.REPAIR_HANDOFF_SHA; },
    r => { r.original_delivery_state_digest = '0'.repeat(64); }]) {
    const altered = structuredClone(contract); mutate(altered);
    assert.throws(() => p.validatePinnedHistoricalIdentity(altered, source, original, true));
  }
  assert.throws(() => p.authenticatePinnedHistoricalContract(null, { source }, {}));
  assert.throws(() => p.authenticatePinnedHistoricalContract({ ...p.F1_HISTORICAL_CONTRACT, sha256: '0'.repeat(64) }, { source }, {}));
});


test('genuine historical-F1 inspection rechecks the complete original authenticated selection', t => {
  const p = require('./phase47-package-publication.test.cjs');
  if (!hostRecordsAvailable(t, [p.F1_HANDOFF, p.F1_HISTORICAL_CONTRACT.path])) return;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: REPOSITORY, encoding: 'utf8' }).trim();
  const original = p.authenticateRepairSuccessor(common, REPOSITORY, 'F1', p.F1_HISTORICAL_CONTRACT);
  const inspected = acceptance.inspectCandidate(null, REPOSITORY, 'historical-F1');
  assert.deepEqual(inspected.authenticated, original);
  assert.equal(inspected.identity.output_count, 161);
  assert.equal(inspected.identity.source_head, original.selected.binding.source.head);
  assert.equal(inspected.identity.source_tree, original.selected.binding.source.tree);
  assert.deepEqual(inspected.identity.generation_handback, { path: p.F1_HANDOFF, sha256: p.F1_HANDOFF_SHA });
  assert.equal(inspected.identity.historical_only, true);
  assert.equal(inspected.identity.generation_kind, 'historical-F1');
  assert.equal(Object.keys(original.selected.binding.source.parent_commits).length, 26);
});

test('pending R2 selection refuses before authority access and retains exact original materialization mappings', () => {
  const p = require('./phase47-package-publication.test.cjs');
  if (p.R2_HANDOFF_SHA === null) {
    assert.throws(() => acceptance.inspectCandidate(), /actual signed main-review-repair generation is pending/);
  } else {
    assert.match(p.R2_HANDOFF_SHA, /^[a-f0-9]{64}$/);
  }
  const previousV1 = { current_handoff: { path: p.REPAIR_HANDOFF, sha256: p.REPAIR_HANDOFF_SHA },
    entry: { retained_path: path.join(path.dirname(p.REPAIR_HANDOFF), 'volume-original-CONTEXT.md'), bytes: 224296,
      sha256: '79c335ae5ab21f168ac86d1d890e66a577c621c1e5c180d1e2b0e3eccfa240b0' } };
  const previousV2 = { current_handoff: previousV1.current_handoff,
    previous_materialization: { path: p.MATERIALIZATION, sha256: p.MATERIALIZATION_SHA }, entries: p.ORIGINAL_ENTRIES };
  const v1 = structuredClone(previousV1), v2 = structuredClone(previousV2);
  for (const fresh of [v1, v2]) fresh.current_handoff = { path: p.R2_HANDOFF, sha256: 'a'.repeat(64) };
  v2.previous_materialization = { path: path.join(path.dirname(p.R2_HANDOFF), 'historical-materialization.json'), sha256: 'b'.repeat(64) };
  for (const row of [v1.entry, ...v2.entries]) row.retained_path = path.join(path.dirname(p.R2_HANDOFF), path.basename(row.retained_path));
  const check = (second = v2) => p.validateFreshMaterializations(v1, second, previousV1, previousV2, 'a'.repeat(64), 'b'.repeat(64), p.R2_HANDOFF);
  check();
  for (const mutate of [r => { r.entries.pop(); }, r => { r.entries[0].sha256 = '0'.repeat(64); },
    r => { r.entries[1].native_result.sha256 = '0'.repeat(64); },
    r => { r.current_handoff.path = p.F1_HANDOFF; }]) {
    const altered = structuredClone(v2); mutate(altered); assert.throws(() => check(altered));
  }
});


test('T16 source-repair contract pins the real stage and rejects authority and allocation drift', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const stage = p.T16_STAGE;
  const binding = {
    schema: 'shipyard.phase47-t16-publication-binding.v1', actor: 'trusted-coordinator', native_receipt: false,
    build_calls: 1, changed_outputs: p.T16_CORRECTIVE, ticket: 'T-47-16', phase_membership: 27,
    outputs: Array.from({length:161}, (_, i) => ({path: 'fixture/' + i})),
    source: {head:'d1e3fcb20c4c8d3786dd7fa7294bd519fa57618d', tree:'215134d0bc1063547f391ed654764e0afc823c1a',
      config_sha256:p.COORDINATOR48_SHA, plan_sha256:'f52ee4c06fbc5af6a04c8298d4ca3176f0b14519183c0fbf2a54d2d589cb3c56'},
    builder:'scripts/package-shipyard-codex.cjs', version:'0.71.0+codex.b7fbd7d015a08f33',
    source_finalization:{commit:'d1e3fcb20c4c8d3786dd7fa7294bd519fa57618d', tree:'215134d0bc1063547f391ed654764e0afc823c1a',
      verification:{digest:'2e54221eabbf9cc97508791834c5ea737d6af66afe5c7a59da331b4256a41f36',outcome:'passed'}},
    previous_publication:{path:p.R2_HANDOFF,sha256:p.R2_HANDOFF_SHA,
      selection_sha256:'1394f2b6cfb5447194b80a67b4e6456416cd3b1d1b40926da8b34073c995f3c1',
      binding_sha256:'e3e08aefe542e17732976f670950fbced1c094eafae96d80fca4c53c3491d6a7'}
  };
  const selection = {schema:'shipyard.phase47-t16-publication-selection.v1',candidate_path:stage+'/candidate',
    binding_path:stage+'/binding.json',binding_sha256:'1f4c6584245d59dfb0fd8c8d2893d84201ad0854a2ebcd972a204e296b627f35',
    source_commit:binding.source.head,version:binding.version,output_count:161};
  const handback = {...selection,schema:'shipyard.phase47-t16-publication-generation.v1',actor:binding.actor,
    native_receipt:false,status:'completed',build_calls:1,changed_outputs:p.T16_CORRECTIVE,
    selection_path:stage+'/selection.json',selection_sha256:'cb368749284ad1dce8157c8c64ce37c6d7b44a6662b14d3a3b9907f4685f0a03',
    previous_publication:binding.previous_publication,outputs:161};
  p.validateT16Contract(handback,selection,binding);
  for (const mutate of [b=>b.phase_membership=26,b=>b.source.head='a'.repeat(40),b=>b.source.config_sha256=p.SOURCE39_SHA,
    b=>b.changed_outputs=[...b.changed_outputs,'foreign'],b=>b.native_receipt=true,b=>b.outputs.pop(),
    b=>b.previous_publication.sha256='a'.repeat(64),b=>b.source_finalization.verification.digest='a'.repeat(64),
    b=>b.outputs[1]=b.outputs[0]]) {
    const changed=structuredClone(binding);mutate(changed);assert.throws(()=>p.validateT16Contract(handback,selection,changed));
  }
  const r4b = structuredClone(binding), r4s = structuredClone(selection), r4h = structuredClone(handback);
  r4b.source.head = r4b.source_finalization.commit = '6bd6943be0d617144803399b987a2877ed365c0c';
  r4b.source.changes = ['plugins/delivery-pipeline/scripts/deliver-dispatch.cjs', 'tests/unit/architecture-target.test.cjs', 'tests/unit/role-artifact.test.cjs'];
  r4b.source.tree = r4b.source_finalization.tree = '0588af073a11d35dab3abfd87aa5aa3349eca9aa';
  r4b.source_finalization.verification.digest = 'c2fda6a34be316bf5af4ace1f1cd26d48f0d89abebb870a660817d662fc54323';
  r4b.previous_publication = r4h.previous_publication = {path:stage+'/generation.json',sha256:p.R3_HANDOFF_SHA,
    selection_path:stage+'/selection.json',selection_sha256:handback.selection_sha256,
    binding_path:stage+'/binding.json',binding_sha256:selection.binding_sha256};
  r4b.build_sequence = 'built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild';
  r4b.builder_inventory = {path:'/tmp/phase47-16-copilot-ci-repair-candidate-inventory.json',sha256:'d1ba21dd591a0e519689d3a4238eaa2699d8df867f6e5f05fe55f07d034f67a2'};
  r4b.publication_native_result = {path:'/tmp/phase47-16-copilot-package-parity-result.json',sha256:'ba3b54faee7d91d449c96de098f6785d44b6a335caddf109eef10f7ad14a6fca'};
  for (const object of [r4b,r4s,r4h]) object.version = '0.71.0+codex.daf277913a59a95f';
  for (const object of [r4b,r4h]) object.changed_outputs = p.R4_CORRECTIVE;
  for (const object of [r4s,r4h]) {
    object.source_commit = r4b.source.head; object.candidate_path = p.R4_STAGE+'/candidate';
    object.binding_path = p.R4_STAGE+'/binding.json'; object.binding_sha256 = 'd6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783';
  }
  r4h.selection_path = p.R4_STAGE+'/selection.json'; r4h.selection_sha256 = '7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae';
  p.validateR4Contract(r4h,r4s,r4b);
  for (const mutate of [b=>b.source.head=binding.source.head,b=>b.changed_outputs=p.T16_CORRECTIVE,
    b=>b.build_sequence='rebuilt-after-proof',b=>b.builder_inventory.sha256='f'.repeat(64),
    b=>b.publication_native_result.path='/tmp/foreign',b=>b.phase_membership=26,
    b=>b.previous_publication.sha256=p.R2_HANDOFF_SHA,b=>b.source_finalization.tree=binding.source.tree]) {
    const changed=structuredClone(r4b);mutate(changed);assert.throws(()=>p.validateR4Contract(r4h,r4s,changed));
  }
  const r5b=structuredClone(r4b), r5h=structuredClone(r4h), r5s=structuredClone(r4s);
  r5b.source_finalization={"path":"/tmp/phase47-16-bounded-final-retry-trusted-fixer-finalization.json","sha256":"094bf1244879ae03fa95708b12b49df0de922dbc0eae815c4938d8b95e3e724b","commit":"74597623434d748357fcafedc87ed8d7397b7757","tree":"6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090","verification":{"digest":"e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-bounded-clean-parity-result.json","fixer_result_sha256":"8f052bf028805172bdd4103289fd6201fb530a4cd517bce675af20b7e8dbcdf1"};
  r5b.previous_publication={"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/generation.json","sha256":"d749a68e28c4355cd59c49b70ca42636d57d5cd318ff0a8d489e24383dd9a035","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/selection.json","selection_sha256":"7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/binding.json","binding_sha256":"d6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783"};
  r5b.changed_outputs=[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","package-build.json"];
  r5b.version="0.71.0+codex.b8ac969962427971";
  r5b.builder_inventory={"path":"/tmp/phase47-16-bounded-clean-candidate-inventory.json","sha256":"402ad93713ccd39501ffc8360724f31ad7ea26a2e276cdb2b1bb919e00fc0cd6"};
  r5b.publication_native_result={"path":"/tmp/phase47-16-bounded-clean-parity-result.json","sha256":"8f052bf028805172bdd4103289fd6201fb530a4cd517bce675af20b7e8dbcdf1"};
  r5h.source_commit="74597623434d748357fcafedc87ed8d7397b7757";
  r5h.selection_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json";
  r5h.selection_sha256="0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90";
  r5h.binding_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json";
  r5h.binding_sha256="062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979";
  r5h.candidate_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/candidate";
  r5h.version="0.71.0+codex.b8ac969962427971";
  r5h.changed_outputs=[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","package-build.json"];
  r5h.previous_publication={"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/generation.json","sha256":"d749a68e28c4355cd59c49b70ca42636d57d5cd318ff0a8d489e24383dd9a035","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/selection.json","selection_sha256":"7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/binding.json","binding_sha256":"d6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783"};
  r5s.source_commit="74597623434d748357fcafedc87ed8d7397b7757";
  r5s.binding_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json";
  r5s.binding_sha256="062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979";
  r5s.candidate_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/candidate";
  r5s.version="0.71.0+codex.b8ac969962427971";
  r5b.source.head="74597623434d748357fcafedc87ed8d7397b7757";
  r5b.source.tree="6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090";
  r5b.source.changes=["plugins/delivery-pipeline/scripts/role-artifact.cjs", "tests/unit/architecture-target.test.cjs", "tests/unit/role-artifact.test.cjs"];
  p.validateR5Contract(r5h,r5s,r5b);
  for (const mutate of [b=>b.source.head=r4b.source.head,b=>b.source.tree=r4b.source.tree,
    b=>b.changed_outputs=p.R4_CORRECTIVE,b=>b.source.config_sha256=p.SOURCE39_SHA,
    b=>b.previous_publication.sha256=p.R3_HANDOFF_SHA,b=>b.native_receipt=true,
    b=>b.builder_inventory.sha256='f'.repeat(64),b=>b.publication_native_result.path='/tmp/foreign',
    b=>b.source_finalization.sha256='f'.repeat(64),b=>b.source_finalization.verification.digest='f'.repeat(64),
    b=>b.build_sequence='rebuilt-after-proof',b=>b.outputs[1]=b.outputs[0]]) {
    const changed=structuredClone(r5b);mutate(changed);assert.throws(()=>p.validateR5Contract(r5h,r5s,changed));
  }
  const movedR5=structuredClone(r5s);movedR5.candidate_path+='/foreign';
  assert.throws(()=>p.validateR5Contract(r5h,movedR5,r5b));
  const moved=structuredClone(selection);moved.candidate_path+='/foreign';
  assert.throws(()=>p.validateT16Contract(handback,moved,binding));
});

test('R2 historical admission refuses snapshot promotion and changed original authority (portable)', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const contract = { schema: 'shipyard.phase47-r2-historical-authentication.v1', actor: 'trusted-coordinator', native_receipt: false,
    snapshot: { path: '/tmp/phase47-R2-historical-authentication-before-T16.json', sha256: 'ce4f18bb385e2894182d35e395a1dffd933492fd568496cae32458db266101fc', bytes: 684623 },
    original_handoff: { path: p.R2_HANDOFF, sha256: p.R2_HANDOFF_SHA },
    validated_current: { head: '265110621c8097a83867a9e9dd7958c0e7830cb2', tree: 'e713fcbb21a22761c956bae621529544947e67dd', canonical_input_digest: '9365fc4817abc41cce69798cb84bf9a8938e4b9d1e0645ba5dce5a9781aebbd0', source_ancestor: true },
    original_raw_board_retained: false, original_raw_board_reconstructed: false, rebuilds: 0 };
  const snapshot = { current: structuredClone(contract.validated_current), handback: {
    selection_sha256: '1394f2b6cfb5447194b80a67b4e6456416cd3b1d1b40926da8b34073c995f3c1',
    binding_sha256: 'e3e08aefe542e17732976f670950fbced1c094eafae96d80fca4c53c3491d6a7' },
    selected: { binding: { canonical_input_digest: contract.validated_current.canonical_input_digest } } };
  p.validateR2HistoricalAdmission(contract, snapshot);
  for (const mutate of [x => { x.native_receipt = true; }, x => { x.actor = 'native'; },
    x => { x.snapshot.path = '/tmp/foreign.json'; }, x => { x.snapshot.sha256 = '0'.repeat(64); },
    x => { x.original_handoff.sha256 = '0'.repeat(64); }, x => { x.validated_current.head = '0'.repeat(40); },
    x => { x.original_raw_board_reconstructed = true; }, x => { x.rebuilds = 1; }]) {
    const changed = structuredClone(contract); mutate(changed);
    assert.throws(() => p.validateR2HistoricalAdmission(changed, snapshot));
  }
  const changed = structuredClone(snapshot); changed.handback.binding_sha256 = '0'.repeat(64);
  assert.throws(() => p.validateR2HistoricalAdmission(contract, changed));
});

test('R2 historical selector cannot bypass its signed snapshot admission', () => {
  const p = require('./phase47-package-publication.test.cjs');
  assert.throws(() => p.authenticateRepairSuccessor('/Volumes/KINGSTON/claude-shipyard/.git', REPOSITORY, 'R2-history'),
    /signed pinned R2 historical admission required/);
});

test('R6 shared-epic successor rejects stale authority, expanded allocation and moved provenance', () => {
  const p = require('./phase47-package-publication.test.cjs');
  const {h,s,b} = {"h":{"schema":"shipyard.phase47-t16-publication-generation.v1","actor":"trusted-coordinator","native_receipt":false,"authority":"Operator standing phase47 repair authorization; existing T47-16 supported publisher ownership","status":"completed","source_commit":"fb444e75a115c57c70d27cb70f37c3a0e742a2df","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/selection.json","selection_sha256":"e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json","binding_sha256":"1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/candidate","version":"0.71.0+codex.c926509d9f20d683","outputs":161,"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/gate-trailer.cjs","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"],"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/generation.json","sha256":"bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json","selection_sha256":"0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json","binding_sha256":"062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979"},"build_calls":1},"s":{"schema":"shipyard.phase47-t16-publication-selection.v1","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/candidate","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json","binding_sha256":"1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33","source_commit":"fb444e75a115c57c70d27cb70f37c3a0e742a2df","version":"0.71.0+codex.c926509d9f20d683","output_count":161},"b":{"schema":"shipyard.phase47-t16-publication-binding.v1","actor":"trusted-coordinator","native_receipt":false,"ticket":"T-47-16","phase_membership":27,"source":{"head":"fb444e75a115c57c70d27cb70f37c3a0e742a2df","tree":"4188f087f978ccda7cb9c942232e1c742aa532f0","status_sha256":"6e45799e5a3580b192b5210dd523a70d0b18bd525166ef2d4a911c29488d4db9","index_sha256":"e1b2fe99c8f0bfbb363f5245e3a579da1ee01d3397b1a98fb0c5a32ba80691f3","graph_sha256":"0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392","delivery_state_sha256":"09718fa827cd287f7095c69b8e792a65e610c78ac845decba87ae9f8c8236946","config_sha256":"1195fed6807740e886592ba92ca99913368becde6b21d8de8126ecf134a0efe9","plan_sha256":"f52ee4c06fbc5af6a04c8298d4ca3176f0b14519183c0fbf2a54d2d589cb3c56","worktree":"/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-16-main421-feedback","common":"/Volumes/KINGSTON/claude-shipyard/.git","changes":["plugins/delivery-pipeline/scripts/gate-trailer.cjs","plugins/delivery-pipeline/scripts/role-artifact.cjs","plugins/delivery-pipeline/scripts/sentinel.cjs","plugins/delivery-pipeline/scripts/state-sync.cjs","tests/unit/architecture-target.test.cjs","tests/unit/role-artifact.test.cjs"]},"source_finalization":{"path":"/tmp/phase47-16-shared-epic-final-trusted-fixer-finalization.json","sha256":"ab3064f6d6948be1f41f88514377c8d5a83e2ea3bf60d044b7b2a96093b7bf14","commit":"fb444e75a115c57c70d27cb70f37c3a0e742a2df","tree":"4188f087f978ccda7cb9c942232e1c742aa532f0","verification":{"digest":"3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-shared-epic-parity-result.json","fixer_result_sha256":"593238c7bae5aee8881cfae3e668d0a3d8628e9e0acbb495a8fcd7aa82c13eec"},"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/generation.json","sha256":"bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json","selection_sha256":"0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json","binding_sha256":"062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979"},"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/gate-trailer.cjs","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"],"version":"0.71.0+codex.c926509d9f20d683","installed_native_obligations":"HOLD; no promotion","builder":"scripts/package-shipyard-codex.cjs","build_calls":1,"build_sequence":"built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild","builder_inventory":{"path":"/tmp/phase47-16-shared-epic-candidate-inventory.json","sha256":"a0984feb89d0ffc4c3d2616fb2bd7d847b467af2e5a1993f2bedb3b550437a51"},"publication_native_result":{"path":"/tmp/phase47-16-shared-epic-parity-result.json","sha256":"593238c7bae5aee8881cfae3e668d0a3d8628e9e0acbb495a8fcd7aa82c13eec"}}};
  b.outputs = Array.from({length:161}, (_, i) => ({path: `fixture-${i}`}));
  p.validateR6Contract(h,s,b);
  for (const mutate of [
    b => { b.source.head = '74597623434d748357fcafedc87ed8d7397b7757'; },
    b => { b.source.tree = '6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090'; },
    b => { b.source.changes.pop(); },
    b => { b.changed_outputs.push('foreign.cjs'); },
    b => { b.source.config_sha256 = p.SOURCE39_SHA; },
    b => { b.previous_publication.sha256 = p.R4_HANDOFF_SHA; },
    b => { b.source_finalization.verification.digest = 'e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8'; },
    b => { b.builder_inventory.path += '.foreign'; },
    b => { b.publication_native_result.sha256 = '0'.repeat(64); },
    b => { b.build_sequence = 'rebuilt-after-proof'; },
    b => { b.build_calls = 2; },
    b => { b.source.plan_sha256 = '0'.repeat(64); },
    b => { b.native_receipt = true; },
    b => { b.phase_membership = 26; },
  ]) {
    const changed = structuredClone(b); mutate(changed);
    assert.throws(() => p.validateR6Contract(h,s,changed));
  }
  for (const mutate of [
    s => { s.candidate_path += '/foreign'; },
    s => { s.binding_sha256 = '0'.repeat(64); },
    s => { s.output_count = 160; },
  ]) {
    const changed = structuredClone(s); mutate(changed);
    assert.throws(() => p.validateR6Contract(h,changed,b));
  }
  assert.throws(() => p.validateR5Contract(h,s,b));
});

test('R7 literal planning-root successor rejects changed authority and allocation', () => {
  const p=require('./phase47-package-publication.test.cjs');
  const {h,s,b}={"h":{"schema":"shipyard.phase47-t16-publication-generation.v1","actor":"trusted-coordinator","native_receipt":false,"authority":"Operator standing phase47 repair authorization; existing T47-16 supported publisher ownership","status":"completed","source_commit":"cab5dc80ac223814713088fc5077860882508b8c","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/selection.json","selection_sha256":"94f3a5b13babfa51b5389b0c7b9d4ab8a9f3abf504e4561672f0bfa76eb42c92","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json","binding_sha256":"777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/candidate","version":"0.71.0+codex.bf58e0d9b9d7b99f","outputs":161,"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"],"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/generation.json","sha256":"b3a59beb7e369cb891e5934fe974e1bcad9d3ba7c96078fa6d6595b294a40de9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/selection.json","selection_sha256":"e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json","binding_sha256":"1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33"},"build_calls":1},"s":{"schema":"shipyard.phase47-t16-publication-selection.v1","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/candidate","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json","binding_sha256":"777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1","source_commit":"cab5dc80ac223814713088fc5077860882508b8c","version":"0.71.0+codex.bf58e0d9b9d7b99f","output_count":161},"b":{"schema":"shipyard.phase47-t16-publication-binding.v1","actor":"trusted-coordinator","native_receipt":false,"ticket":"T-47-16","phase_membership":27,"source":{"head":"cab5dc80ac223814713088fc5077860882508b8c","tree":"df908628cd1016a4f7d41c89661b23f1dbaa4f94","status_sha256":"6e45799e5a3580b192b5210dd523a70d0b18bd525166ef2d4a911c29488d4db9","index_sha256":"8ba75c15bfb33b9582523dcfb009992ac6b2430a1bccaf1854b5c2496577c9bb","inputs":[{"path":"capabilities/delivery-pipeline/capability.json","sha256":"6003e6967a0516616929a4f2bebce5651cd17dda6b4f939aeb42657a57a265d8","bytes":12281,"mode":420},{"path":"capabilities/delivery-pipeline/checks/graph-gate.cjs","sha256":"81eef2321a30265a49bc7995898615039e65b01629b58a83901f5501c4ce89fa","bytes":6333,"mode":420},{"path":"capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs","sha256":"7a9163986331889aa216ecbe7dc064768f65f3568609696c78a98644d511ec89","bytes":5618,"mode":420},{"path":"capabilities/delivery-pipeline/checks/uat-gate.cjs","sha256":"b86c513e4888e69a5772375ad601b28b8baef65136b7b8f0053c76d37921a6b2","bytes":2041,"mode":420},{"path":"plugins/delivery-pipeline/.claude-plugin/marketplace.json","sha256":"6187585974f462f1f822ca303a876ea7c0ea30b327f8bf8c0f9bd57549c241ed","bytes":628,"mode":420},{"path":"plugins/delivery-pipeline/.claude-plugin/plugin.json","sha256":"263d9068b1d868429b44bf3f5bd4b5b4f79a42c1dc8a94daf9432b5eb833a300","bytes":736,"mode":420},{"path":"plugins/delivery-pipeline/commands/bench.md","sha256":"78eb6d6a7394c4fc1f79fab336976259ea0af9c6689c6194fbb97b684146ba62","bytes":9688,"mode":420},{"path":"plugins/delivery-pipeline/commands/decompose.md","sha256":"b225f40bd1568e7e8747c84d9b25dd6c21ba4aa85a4c7f47233e19c9d298a59d","bytes":44905,"mode":420},{"path":"plugins/delivery-pipeline/commands/deliver.md","sha256":"0a31806f2b1a3d592f5a30e5f4d67c9747a6481a6a2b07fcb1e9973defe9beea","bytes":192756,"mode":420},{"path":"plugins/delivery-pipeline/commands/investigate.md","sha256":"f04abc6643af4e56e8f1b84021de874838bb6ce92a80f9535e082d3a406da6fb","bytes":15687,"mode":420},{"path":"plugins/delivery-pipeline/commands/route.md","sha256":"fc37b666b774fd4cbcbe50a80e5b1ca23444498aae8cba12b5182ba9ca2d0588","bytes":5705,"mode":420},{"path":"plugins/delivery-pipeline/references/arch-review.md","sha256":"da6d7e53bf362be0930fa09a39fdb0c7a34a875714a25102784e5a604674461c","bytes":8598,"mode":420},{"path":"plugins/delivery-pipeline/references/ci-fix.md","sha256":"a9ed6329bccf9e6a1a63b1dfb48a0ff69b2e851e8101d624316bc8322a15f9f6","bytes":10258,"mode":420},{"path":"plugins/delivery-pipeline/references/drift-check.md","sha256":"5d2f3b2c2ffd0a35aae5c0f2fd21e90e639ae3743c5f2951e33e2c25fde84b35","bytes":6174,"mode":420},{"path":"plugins/delivery-pipeline/references/integrator.md","sha256":"49c603a8a832b018f16f7a17beb1c01d3e5a168ba02ba12e279bc690dc7a2ead","bytes":7535,"mode":420},{"path":"plugins/delivery-pipeline/references/inv-research.md","sha256":"804bfa137c7fa65cb346265833979190998b875e0d0a06ada5f0d5d5e42ab10c","bytes":4942,"mode":420},{"path":"plugins/delivery-pipeline/references/pr-sentinel.md","sha256":"103e9f69d49f0bb4e877472d46194daddfcbc6a06b7cd08c022c35d40d92ebac","bytes":43876,"mode":420},{"path":"plugins/delivery-pipeline/references/review-fix.md","sha256":"6dd58c5f006afe21b03e0fcc26c6edcc01f81792a4aa74a13e8ad814816cc025","bytes":8765,"mode":420},{"path":"plugins/delivery-pipeline/scripts/adr-bootstrap.cjs","sha256":"c83945835650c41a45f46a8f28a9e2bc50e5ddcda8200e5d9d9dc0f113670a3c","bytes":6049,"mode":420},{"path":"plugins/delivery-pipeline/scripts/adr-ingest.cjs","sha256":"b89b739c84741e621635da48a11a7ae585d8d56f63914dbe7040db85d2fd4bcb","bytes":8387,"mode":420},{"path":"plugins/delivery-pipeline/scripts/architecture-target.cjs","sha256":"fb5b230a36d8e4e932f24ec139d1cb1d7a728ca3005ba7c3ff4f5df5a283c016","bytes":4818,"mode":420},{"path":"plugins/delivery-pipeline/scripts/attempt-history.cjs","sha256":"04b223d9c84f464a6377b3147a520b33af47ff36aacf0b4763a48874c9810574","bytes":15439,"mode":420},{"path":"plugins/delivery-pipeline/scripts/auto-route.cjs","sha256":"648042781253a94c8430c7041abcb208fc33227f3eed2836f3a42c456837aaa3","bytes":4343,"mode":420},{"path":"plugins/delivery-pipeline/scripts/backlog-index.cjs","sha256":"1e62ba13e34936d984461be145f3ef9e80c1627fea1fd2cae89ae70c03ecea96","bytes":8871,"mode":420},{"path":"plugins/delivery-pipeline/scripts/base-merge.cjs","sha256":"8e2297611bb167dafac74b7842f0a57f712fe1237522cc904cc8dfdde0ebf0ed","bytes":15773,"mode":493},{"path":"plugins/delivery-pipeline/scripts/capacity-lease.cjs","sha256":"89605a871eeee764022766f0177a05c129320082b6be1c0394ce9ab19d81c1b6","bytes":16831,"mode":420},{"path":"plugins/delivery-pipeline/scripts/check-state.cjs","sha256":"156e73078f88148438a4bf4beee8ceba597ec1b955ce27b892bc1d1346c75042","bytes":10197,"mode":420},{"path":"plugins/delivery-pipeline/scripts/ci-wait.cjs","sha256":"1daa1cf0bf8cb80deb0466f5e8701507c470756000231aa4a2591ae7926d98cf","bytes":61615,"mode":493},{"path":"plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs","sha256":"bcbaf39ab49b120121e65ae02c5b8d29bf42f158506717ae49de7b345809250d","bytes":2653,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-decompose-host.cjs","sha256":"448f4bc4fcf4c1cfbaea4a2e8a23530d6c250bdc578618edf0759576012ff7dd","bytes":40689,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-delivery-host.cjs","sha256":"ee3274386311d2c0810425e3ecef18059f12c89df9a9695b97bbf9583e47ac1a","bytes":56060,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs","sha256":"9d0682e37ee5d7a45d620eaaf6fc2b9e2b23ff0adc8bbed4e86d097cb9f3ba07","bytes":48661,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-investigation-host.cjs","sha256":"237bdd5b3e89d2a47c8c67b35a3a1e7fa840fb7af4e0d303a75d4f08c734e8cd","bytes":5996,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-reference-content.cjs","sha256":"19677a8b73e6867bc9053390f0989aec98b6b283ff6e5250d8f554cfd2423a32","bytes":3351,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-role-host.cjs","sha256":"91b6ec67635d973f48bb42e119db1cdbfa0917eeaa205e62f15b6654ef92b5f7","bytes":82325,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-runtime-host.cjs","sha256":"f773c1c09346ba2de0516258377f81786e1e68c2c5172e8381b3f850031e48e4","bytes":49451,"mode":420},{"path":"plugins/delivery-pipeline/scripts/claude-workflow-host.cjs","sha256":"13b335a4b5202acd22f486ddd62c414ac89952f0ddc44ae9f7898874beca879f","bytes":24588,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-agent.cjs","sha256":"4baebeb58049fdf1dc5631c5782d1759b480ea082a30d7523992ac5876cd006c","bytes":12626,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs","sha256":"bfe852a3064b26f0f537a057f8b11b823d813d183e7f69b47d430ea9d42cb55a","bytes":76730,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-decompose-host.cjs","sha256":"ae81ddf6233bf404767c0c60d62701bdcac45b5775597f787cccd3da69129a20","bytes":73613,"mode":493},{"path":"plugins/delivery-pipeline/scripts/codex-delivery-host.cjs","sha256":"c6c6b049d7078455b003212e3798c680ed44f46bc719f6bddb5190db74c8b1e7","bytes":106775,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs","sha256":"5ea14c3d16e9fa37d541d88f7de24f59c5fd0be6b73c5e13f141ffbb1721d8d6","bytes":28584,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-model-remap.cjs","sha256":"ad03617d0e74cdc65ec4af29cd8a249fdb2b3547e6f0f78d8030c78f5df87ab7","bytes":9599,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-notify.cjs","sha256":"9822b05bc07a97f5a5d3b2296837eeff8d1237d1e9dfdb7ea109e5454a484eeb","bytes":1803,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs","sha256":"1189b37f8cae64f624cce63d69f618a9e34f525e1d1bdd742a48af60de9494ec","bytes":21164,"mode":420},{"path":"plugins/delivery-pipeline/scripts/codex-runtime-host.cjs","sha256":"12fb1fb21ccf12838a53010613f7a3d458a1eb2ff0870a686a9b9b6420d3e521","bytes":81793,"mode":420},{"path":"plugins/delivery-pipeline/scripts/command-runner.cjs","sha256":"e9d15511531ac6f9a93005261225f3250dafc173b854675d63a36f83aa0029db","bytes":13348,"mode":420},{"path":"plugins/delivery-pipeline/scripts/comment-policy.cjs","sha256":"fcd3a3c9b3e4457bec9ce62087d52ac965e36775d7bdca6be29d94971f008ece","bytes":24341,"mode":420},{"path":"plugins/delivery-pipeline/scripts/context-packet.cjs","sha256":"28caa586dd241f91e53d8f8084af9fcb27f57774b9b6223bbaa1b4e99bc2f639","bytes":32779,"mode":420},{"path":"plugins/delivery-pipeline/scripts/conveyor-coverage.cjs","sha256":"e4ef6439fa74c309e3f00f411ec7d3d3094778602755a3fe6bd742c6a447c789","bytes":18358,"mode":420},{"path":"plugins/delivery-pipeline/scripts/conveyor-scratch.cjs","sha256":"518f9236934c150e58f0da7f68a7882617246c98b188684bce9cc963168d44f9","bytes":2953,"mode":420},{"path":"plugins/delivery-pipeline/scripts/degenerate-green.cjs","sha256":"155ea656ef56bc929e9693605f020fb477cf3976805fc0165c8a2d314dc2c14a","bytes":34565,"mode":493},{"path":"plugins/delivery-pipeline/scripts/deliver-dispatch.cjs","sha256":"faf7ce51f221493961e90e3a5ba3156cae42a34b853e2139689ffd31a245399e","bytes":57157,"mode":420},{"path":"plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs","sha256":"e586a2e7578148cbb2836bcfe343722d982ee00b2259cbb73ea7a023ccf48f8c","bytes":17918,"mode":420},{"path":"plugins/delivery-pipeline/scripts/development-artifacts.cjs","sha256":"36b097bbb3cd95e6ee1b8941e2326e015c5c66f22a561083d6c81b8880521530","bytes":1485,"mode":420},{"path":"plugins/delivery-pipeline/scripts/diamond-parents.cjs","sha256":"48a0c28df2d76c406735e3e207d6a7a1fa6d9a3dd7adadbf8d0ac5597a6404fe","bytes":3989,"mode":420},{"path":"plugins/delivery-pipeline/scripts/dispatch-boundary.cjs","sha256":"91272501fc894f0561f36710ceae108886b9c754d28ee188535f5d493ad2e9ef","bytes":127747,"mode":420},{"path":"plugins/delivery-pipeline/scripts/dispatch-record.cjs","sha256":"000d04da3925feb7b5cc3f588eaec35df9645e2c02bc9ab46454498107d43d00","bytes":109946,"mode":420},{"path":"plugins/delivery-pipeline/scripts/drift-needed.cjs","sha256":"ccba8d9ca000f7cb46c31196e00b6f675e89ae7f20a899c7580f3b6a1e3387b8","bytes":25204,"mode":493},{"path":"plugins/delivery-pipeline/scripts/drift-record.cjs","sha256":"4541a864a409476878b6479b05e17fe5ecb1d5eaba24a8c9baa173253e24d56d","bytes":9930,"mode":493},{"path":"plugins/delivery-pipeline/scripts/effort-experiment.cjs","sha256":"7c80f594428569dde29b2009dcb33d58e2449668c8bc6ea5ec6750d7bacf653a","bytes":18072,"mode":420},{"path":"plugins/delivery-pipeline/scripts/epic-branch.sh","sha256":"38a71742354fa31ed8c7143a7a8f2fd0e8b7ea719576ed3ff4b4f28e23a3e0e7","bytes":23270,"mode":493},{"path":"plugins/delivery-pipeline/scripts/escalation-record.cjs","sha256":"0e86b50123f7a6968d68a95037b10d4f42e0cc32600f8bed3362e8a184555800","bytes":27561,"mode":420},{"path":"plugins/delivery-pipeline/scripts/failure-signature.cjs","sha256":"1f8caa7d204595348f9cbcd494b652f8efb050769b12a801bbf7759e5504c963","bytes":36322,"mode":420},{"path":"plugins/delivery-pipeline/scripts/front.cjs","sha256":"da15f116bc7bab57210883b3b1d3e1aba79c1155b127fa7b490a0bae9a607d90","bytes":107652,"mode":420},{"path":"plugins/delivery-pipeline/scripts/frontmatter.cjs","sha256":"ea36dc16e84746a5e2ec20435a620c63754922dbb6a4b219ea29cfac6894497c","bytes":11652,"mode":420},{"path":"plugins/delivery-pipeline/scripts/gate-trailer.cjs","sha256":"81ae95db5d3ac2e9d5fe58a8d3c4e100cfa240c8ab6d8d7a0e033469aa8edb50","bytes":38897,"mode":420},{"path":"plugins/delivery-pipeline/scripts/graph-dir.cjs","sha256":"df216746ca137e576ff5d8a30fd4a774e81a7f0a947c0eaa709096dbce4dca7d","bytes":8455,"mode":420},{"path":"plugins/delivery-pipeline/scripts/gsd-agent-root.cjs","sha256":"290a915c2277ff9db8f56df1e9908492b0d389ed695c88bbf598b3beb95ec577","bytes":1619,"mode":420},{"path":"plugins/delivery-pipeline/scripts/gsd-sync.cjs","sha256":"2c786f6ed4f69d69def87599e70bc488261f77e5338e70ae74c46c8db48169f0","bytes":59143,"mode":420},{"path":"plugins/delivery-pipeline/scripts/gsd-tune.cjs","sha256":"6c1631b3bc9a8f0da06d3287294e34aec3e2ec7f7174999979a8ae0f8cca4538","bytes":60992,"mode":493},{"path":"plugins/delivery-pipeline/scripts/host-provenance.cjs","sha256":"43c83df97f398cdbec8f2623bc610ea0a5d6251ebe032278d0e8b014d4f5ca0d","bytes":4332,"mode":420},{"path":"plugins/delivery-pipeline/scripts/host-verification.cjs","sha256":"7821d83325758e5b71c7d25604556ff41a495bcccaacbbe1fb9ca8813a417d86","bytes":14981,"mode":420},{"path":"plugins/delivery-pipeline/scripts/jira-export.cjs","sha256":"cc16b5f5c1785fb3249693868d10723209528fb4c89c57140f0e2124d83041ec","bytes":16340,"mode":420},{"path":"plugins/delivery-pipeline/scripts/jira-project.cjs","sha256":"b8dc7b32a66f6ef70bcc4ddb66333b92761698342621c7869faa294cce26f894","bytes":41534,"mode":420},{"path":"plugins/delivery-pipeline/scripts/live-receipt.cjs","sha256":"373fc2eaab3667d17666f071f98ce43872eb6897f4b49fb4f4747743af643af2","bytes":5599,"mode":420},{"path":"plugins/delivery-pipeline/scripts/lock.cjs","sha256":"9fa25b424f255df50a4cfd29b46cbb57d9e538e8404fa3dbc99081072de0ea7e","bytes":23742,"mode":420},{"path":"plugins/delivery-pipeline/scripts/log-event.cjs","sha256":"32a2650607d4c43c4233d6a3643f370a5484c2f1bc288cc8c8e6682e4528928d","bytes":22146,"mode":420},{"path":"plugins/delivery-pipeline/scripts/model-capability.cjs","sha256":"3ced6df833f4213803d39113b91346beca5e85b17854d962957962218c37baf7","bytes":7014,"mode":420},{"path":"plugins/delivery-pipeline/scripts/model-policy-internal.cjs","sha256":"84ed98ee287d2b5066f8099b74d11550dcf75d52a6ebd69cc7d6e75a2375176a","bytes":46225,"mode":420},{"path":"plugins/delivery-pipeline/scripts/model-policy.cjs","sha256":"1cac648169da7236ea5fcd8a2a8dc722672031e8aa882a3687feaeafc296f680","bytes":2747,"mode":420},{"path":"plugins/delivery-pipeline/scripts/optimization-report.cjs","sha256":"2e2a31a0d73908492dcb4446b6ec695a6ebdfc1523cef7783b0e049e215b6dd4","bytes":18195,"mode":420},{"path":"plugins/delivery-pipeline/scripts/orchestration-overhead.cjs","sha256":"14d704537dc39a76c3e2d53173f7da8f8efc4c4494d724228d354bdcfe9941dd","bytes":40409,"mode":420},{"path":"plugins/delivery-pipeline/scripts/parent-moving.cjs","sha256":"60af7fbc2971081bf1b3ef42f28e39981313d95c808b229bf0edcd570eb742ff","bytes":8056,"mode":420},{"path":"plugins/delivery-pipeline/scripts/path-owner.cjs","sha256":"a7527c2bdde9fed97aa94dfd6019413bbc5c27457747437944aaee541a9a0f0b","bytes":10474,"mode":420},{"path":"plugins/delivery-pipeline/scripts/phase-integrator-preflight.cjs","sha256":"f8167c0324d6a4e957d43d5f705eea17ee843089f6a4e2a193c69e1fbb6e3c9b","bytes":13751,"mode":420},{"path":"plugins/delivery-pipeline/scripts/pipeline-config.cjs","sha256":"adf1542d878ec99ef784636355ab29270e88c7b11cf3b767f8ec0a23d1c7b050","bytes":133703,"mode":420},{"path":"plugins/delivery-pipeline/scripts/pipeline-stats.cjs","sha256":"cb425f9f34d3dc7b0774f40a2da9228ca522a7e52899447b58bf1e26f5bb9af8","bytes":50248,"mode":420},{"path":"plugins/delivery-pipeline/scripts/plan-delivery.cjs","sha256":"0ba27e02156c2071227a6fd7b154910dd5376aa7d0a8e8adef60333c3b34b7c5","bytes":10007,"mode":420},{"path":"plugins/delivery-pipeline/scripts/planning-result-sealer.cjs","sha256":"0ad1c2538007e8004272ed83099a841f2223eafaa9c765190e2732b1b77c8715","bytes":32534,"mode":420},{"path":"plugins/delivery-pipeline/scripts/planning-untrack.cjs","sha256":"7a3c8f9ce136b2c0756d414dce0c64b02e7107446991786fddb1ff6e9f2e969d","bytes":5363,"mode":420},{"path":"plugins/delivery-pipeline/scripts/planning-writer-lease.cjs","sha256":"abef7cd685442eb5c0d2f0cec5a3e1ec94c0ba3865b767bcb5f664f13b106200","bytes":17565,"mode":420},{"path":"plugins/delivery-pipeline/scripts/pr-hygiene.cjs","sha256":"645f65bf2d242b649f63434f8dd59fefda54e466376d819d0dc3ac2c9728807c","bytes":15370,"mode":420},{"path":"plugins/delivery-pipeline/scripts/pr-ledger.cjs","sha256":"c527a23c7cee7fb4b696f484b9596e6ecfe20dd0f20071ce704df9127e3b888c","bytes":4710,"mode":420},{"path":"plugins/delivery-pipeline/scripts/publish-gate.cjs","sha256":"a3dfd1a087eb1a0937fb70b64e9b7a818558c24ed400fb5b3ae4f9d1438c76e0","bytes":4167,"mode":420},{"path":"plugins/delivery-pipeline/scripts/refusal-hints.cjs","sha256":"b827286d8325cef6b0ed9150682236e409809104c0e690651aab88e04019baf2","bytes":4220,"mode":420},{"path":"plugins/delivery-pipeline/scripts/repo-remedy.cjs","sha256":"7a5e1d2d913788e4c52eb7d9ac76e4ab0a58dbed92ef3ef14aadf5ec43299c5a","bytes":13581,"mode":420},{"path":"plugins/delivery-pipeline/scripts/repo-resolve.cjs","sha256":"a2296de6896808a6ddcfb4ab2e2ae1fc86bdd2fed63330cd4c4bcd4962113d87","bytes":64908,"mode":420},{"path":"plugins/delivery-pipeline/scripts/review-signature.cjs","sha256":"bc6647f2bb3fb8f4751d0836dd7eecdbf1aba7772864791041184dd6b3638dc4","bytes":5841,"mode":420},{"path":"plugins/delivery-pipeline/scripts/reviewers.cjs","sha256":"b87260cced2038dd34b2bc8f8f655b8ac47b30757c37c149d411b2af2b469a25","bytes":30191,"mode":420},{"path":"plugins/delivery-pipeline/scripts/role-artifact.cjs","sha256":"42fb2de5f3d7d3ff3dbc3296c75b482680cfefb78ae307b2ea259f075ca13395","bytes":203569,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-contract.cjs","sha256":"b36f29cb76216d966d18300375c57dfb560d320a393b1ead111436ea9936b5db","bytes":32547,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-controller.cjs","sha256":"c01ca92b21500583b8cb5d06b769bc51e34cdd0aa71cc89813fd72d7ffcee592","bytes":40255,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-reachability.cjs","sha256":"82521571cd09179108dd001a399d85253b11203f00a686506c734585dfe9f50a","bytes":15579,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-rollout.cjs","sha256":"bc22068b84e5e5494a86f554aac67e544aab749eb759257f08b2afe6535ad0ef","bytes":27667,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-scope.cjs","sha256":"7663a9ed9fee9b6301e45d7bac631e2f3668341c31c03c940fe9b5ac5e379a44","bytes":3867,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-store.cjs","sha256":"f9b65358176d3b3f85879aa7a7a0a64ab0b028f62e74d5593f46a2f7b7bcaaac","bytes":16884,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-telemetry.cjs","sha256":"9a06f407463018e76fb4d489658c083136c3aede63e5eadd6d049983c1a70afd","bytes":30137,"mode":420},{"path":"plugins/delivery-pipeline/scripts/run-waker.cjs","sha256":"2be6b833b03390311b69cb20d7b91501429d89fbc01fb1c49ab2b18c00dcac33","bytes":13144,"mode":420},{"path":"plugins/delivery-pipeline/scripts/runtime-adapters.cjs","sha256":"bf2632cbe3f4fe978c098a782d8607878437dbec3f6a65bc400a9b79a6977a54","bytes":3249,"mode":420},{"path":"plugins/delivery-pipeline/scripts/runtime-context.cjs","sha256":"0d251f21763a406808927df496328604fd6ead8ab288b5293fcfd7771a316b44","bytes":15395,"mode":420},{"path":"plugins/delivery-pipeline/scripts/scope-gate.cjs","sha256":"66bad0b62274eb894e1d7e1b247149dda122cb5cb2e9d7fcd6af071517b3182b","bytes":7345,"mode":493},{"path":"plugins/delivery-pipeline/scripts/sentinel-preflight.cjs","sha256":"eb8efdf0898e0dd30d9fcf0bca9cf5c1b8949fcb5f7b807a0bbd9a8e3a93033d","bytes":11010,"mode":420},{"path":"plugins/delivery-pipeline/scripts/sentinel.cjs","sha256":"811d69d88fdff93caeb62152fa6715e9cb967e3116bc8e5b84d2e18ccbd2e093","bytes":96500,"mode":420},{"path":"plugins/delivery-pipeline/scripts/session-handoff.cjs","sha256":"7bca63e23781e93698f15f6a72372024df09b745af61b0fee29c8674d27e080b","bytes":76852,"mode":420},{"path":"plugins/delivery-pipeline/scripts/session-observer.cjs","sha256":"f215590f50d0d140815760ab6b031d4620855d0bdb73c199274820b03326f0be","bytes":16880,"mode":420},{"path":"plugins/delivery-pipeline/scripts/state-sync.cjs","sha256":"25a550d4638d959ba6c5d446624805f77207e294a20eee0c3bd51050877ed35a","bytes":90863,"mode":420},{"path":"plugins/delivery-pipeline/scripts/statusline-collector.cjs","sha256":"c5f0287dc42c93b27acf5b56efd30384fe3d16ebe02e74ce0114d6a18b38cd9c","bytes":3876,"mode":420},{"path":"plugins/delivery-pipeline/scripts/stop-gate-arm.cjs","sha256":"d875a535a29a894f9ca39099ec5c3dbd4eb632cddabdf961f1f391425cb75fb6","bytes":6401,"mode":420},{"path":"plugins/delivery-pipeline/scripts/stop-gate.cjs","sha256":"80f885bc84f219741fee7323363491556c8a3a68a542fcd88315d52cb4e26243","bytes":42163,"mode":493},{"path":"plugins/delivery-pipeline/scripts/subscription-observation.cjs","sha256":"fc5b506958ac626e20db3973f637764d1e2a35b14db82354295f2481878fe894","bytes":13711,"mode":420},{"path":"plugins/delivery-pipeline/scripts/subscription-store.cjs","sha256":"32c4c106b3e503ca27ea933457046a45f71cb35aa61489c27fc6bd9853a38dfb","bytes":13930,"mode":420},{"path":"plugins/delivery-pipeline/scripts/ticket-base.cjs","sha256":"e405d99f73925be2f47a958c00e8cd118ffc197e4744a32e9ec3304e23386ced","bytes":5648,"mode":420},{"path":"plugins/delivery-pipeline/scripts/ticket-pr-match.cjs","sha256":"164b6dabbbc3b3cb6e65c3bc7e7ce91cf1105bef054dffcbabf933712af8f413","bytes":3274,"mode":420},{"path":"plugins/delivery-pipeline/scripts/ticket-worktree.sh","sha256":"b64296a5d0189db6f9f1065a05bb7aef3eb4bc4b80dfa11c241a0c9c21a9bad9","bytes":34020,"mode":420},{"path":"plugins/delivery-pipeline/scripts/tracker-eligibility.cjs","sha256":"9ed520d850c9e1ee411c00ecafbee142d99ffcb9df442712f09f00364f96e574","bytes":6865,"mode":420},{"path":"plugins/delivery-pipeline/scripts/tracker-record.cjs","sha256":"88929c33af32a94e181aa8f1f9c32947ea95fa9dd870be0cdae471e1dfa1885d","bytes":44631,"mode":420},{"path":"plugins/delivery-pipeline/scripts/usage-attribution.cjs","sha256":"a94ca972c87a94c59aa5e7eb1a34338141c621ce992e10e2472d5cf4a85657a9","bytes":84854,"mode":420},{"path":"plugins/delivery-pipeline/scripts/usage-report.cjs","sha256":"751a4fa13e8a762bd5547502eea2bc8ee8fd0f1b326615e3e0198f2b53f232ea","bytes":54953,"mode":420},{"path":"plugins/delivery-pipeline/scripts/validate-graph.cjs","sha256":"650dbf73497483bdcfd3c2dd9d844d38495cf538b185f2cf64f290e688bd26d5","bytes":36994,"mode":420},{"path":"plugins/delivery-pipeline/scripts/validate-inv.cjs","sha256":"9725e2f6cdad7a32166f9dcbcc410575ba7d4018311c00dcc25bbeb697f227ec","bytes":2542,"mode":420},{"path":"plugins/delivery-pipeline/scripts/wait-events.cjs","sha256":"5c075e53caeeba295fc6ce3e281dd9c0a7b66f74c77e31e1c12d5102b9b06354","bytes":42954,"mode":420},{"path":"plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","sha256":"830914a0b3e79b8f3a8e8fc8d774bc8d25f414735f92dcfe3ff95e73df52c39c","bytes":15645,"mode":420},{"path":"plugins/delivery-pipeline/templates/adr/ADR.md","sha256":"21d4d65048d4dbe19284a2f28d2fcd8431a7b325d63c8c27d9fb124de2623763","bytes":498,"mode":420},{"path":"plugins/delivery-pipeline/templates/inv/DECISIONS.md","sha256":"405b857efdb28e2680f95e8815a61a39d21602900fdfeedae9ac1f22db1b0fa9","bytes":408,"mode":420},{"path":"plugins/delivery-pipeline/templates/inv/OPEN-QUESTIONS.md","sha256":"1c79594daaf320ccb5d84670de409389c930ae813e27fea281bb240b64e4d02e","bytes":300,"mode":420},{"path":"plugins/delivery-pipeline/templates/inv/OPTIONS.md","sha256":"2b1c6fe748cf47cec0c396441ab08b51270bba0bf8109c4500a2baa0aa8064e3","bytes":349,"mode":420},{"path":"plugins/delivery-pipeline/templates/inv/PROBLEM.md","sha256":"214cb35c66c4c09062ddef7eeb97047bc076b646523558d9456cc59bfbe32e79","bytes":596,"mode":420},{"path":"plugins/delivery-pipeline/templates/inv/RESEARCH.md","sha256":"e27f87c2a29e7d1726c4f4727eafaf47faac32c791fa0c1beaf1cd52ab88b8a6","bytes":355,"mode":420},{"path":"plugins/delivery-pipeline/templates/inv/RISKS.md","sha256":"53131875cf8338616a5c43eaa44b11e5b5506ecfc7fefa14c04b1166ef59f6bc","bytes":199,"mode":420},{"path":"plugins/delivery-pipeline/workflows/drift-gate.mjs","sha256":"9ac0928078ecde52ad9c7da8036411b21498c37aa670f306e02e4ab26321a38c","bytes":18011,"mode":420},{"path":"plugins/delivery-pipeline/workflows/executors.mjs","sha256":"90f9f0f7b1c6a2f1b4f706a0fe836844fb2d0d18f814bcddf4bee239734beae2","bytes":25218,"mode":420},{"path":"plugins/delivery-pipeline/workflows/fix-round.mjs","sha256":"5825e938203665151d8a18954b3e1521d4b3cfb38a8156a4f0694df9a9aa7bda","bytes":26985,"mode":420},{"path":"plugins/delivery-pipeline/workflows/investigation-research.mjs","sha256":"f8df24ff290a526832c7f713d9d4d81bfda8a96c0b0c4e78a46f11415ec6e573","bytes":18047,"mode":420},{"path":"scripts/bootstrap-shipyard-plugin.cjs","sha256":"6243388b9c91d3596aa974e06a63999ac4c7c5c692065df3a7875e19222df2a6","bytes":8260,"mode":420},{"path":"scripts/configure-codex-notify.cjs","sha256":"c6ac599af2729b937eba24e540ef6b9e899ebe9d899aa0ef8921745e69d64a2d","bytes":10046,"mode":420},{"path":"scripts/ensure-gsd-core.sh","sha256":"f9ab31022791870d4eeaf1fbc97f508b46939a253e78e3953316810b6b15ed32","bytes":21930,"mode":493},{"path":"scripts/ensure-gsd-plugin.cjs","sha256":"74f749c4dbfe9825a1aeeaa38a6b559c044825b8b95cc615ccdc56253f690e67","bytes":2030,"mode":420},{"path":"scripts/gen-codex-shipyard.cjs","sha256":"7a7de386a1b74aade8e38fd4a8d804176b3a62c9934165f3a0ed2d405968e824","bytes":20255,"mode":493},{"path":"scripts/install-shipyard-capability.sh","sha256":"ffe9877c7a8c136f1554e1448700f2977d51b7783cef5d47837942fc3a5a6558","bytes":4992,"mode":493},{"path":"scripts/install-shipyard-codex.sh","sha256":"c935339d04f05485594bcc15606f80a23f04e3faa3a98d233b49c853651176de","bytes":38803,"mode":493},{"path":"scripts/merge-codex-config.cjs","sha256":"e6bbebab52b469bc5c3bc6b37fdba57eb06d95eb297fee6d608075b852e35123","bytes":19944,"mode":493},{"path":"scripts/package-shipyard-codex.cjs","sha256":"a56374d7f5e31734d52259bcbadad434e4eb7bb3af045e01bfa3b51e0f77e71b","bytes":5338,"mode":420}],"graph_sha256":"0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392","delivery_state_sha256":"dc685c3b29507ed9f8d81df49a44af51100e1b1703d80142bed1fc24cc80a6a4","config_sha256":"1195fed6807740e886592ba92ca99913368becde6b21d8de8126ecf134a0efe9","plan_sha256":"f52ee4c06fbc5af6a04c8298d4ca3176f0b14519183c0fbf2a54d2d589cb3c56","worktree":"/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-16-main421-feedback","common":"/Volumes/KINGSTON/claude-shipyard/.git","changes":["plugins/delivery-pipeline/scripts/role-artifact.cjs","plugins/delivery-pipeline/scripts/sentinel.cjs","plugins/delivery-pipeline/scripts/state-sync.cjs","tests/unit/architecture-target.test.cjs","tests/unit/sentinel.test.cjs","tests/unit/state-sync-listing.test.cjs"]},"source_finalization":{"path":"/tmp/phase47-16-planning-root-final-trusted-fixer-finalization.json","sha256":"3cf075199ae9c73a8683155f994c618579aef3e71416dfdb0f9708ad08661a3b","commit":"cab5dc80ac223814713088fc5077860882508b8c","tree":"df908628cd1016a4f7d41c89661b23f1dbaa4f94","verification":{"digest":"b2d78c0ad1a32bda4557eb9c25df6b33bdf9c5e340c79d214c440fa2a51a7bb9","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/b2d78c0ad1a32bda4557eb9c25df6b33bdf9c5e340c79d214c440fa2a51a7bb9.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-planning-root-parity-result.json","fixer_result_sha256":"82f9bd8a6d20ed93da685fa8e1f30fc9a269c8243d678f75f7ea087e99a47570"},"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/generation.json","sha256":"b3a59beb7e369cb891e5934fe974e1bcad9d3ba7c96078fa6d6595b294a40de9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/selection.json","selection_sha256":"e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json","binding_sha256":"1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33"},"source_snapshots":{"graph":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/source-graph.json","sha256":"0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392"},"state":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/source-delivery-state.json","sha256":"dc685c3b29507ed9f8d81df49a44af51100e1b1703d80142bed1fc24cc80a6a4"}},"outputs":[{"path":"fixture-0"},{"path":"fixture-1"},{"path":"fixture-2"},{"path":"fixture-3"},{"path":"fixture-4"},{"path":"fixture-5"},{"path":"fixture-6"},{"path":"fixture-7"},{"path":"fixture-8"},{"path":"fixture-9"},{"path":"fixture-10"},{"path":"fixture-11"},{"path":"fixture-12"},{"path":"fixture-13"},{"path":"fixture-14"},{"path":"fixture-15"},{"path":"fixture-16"},{"path":"fixture-17"},{"path":"fixture-18"},{"path":"fixture-19"},{"path":"fixture-20"},{"path":"fixture-21"},{"path":"fixture-22"},{"path":"fixture-23"},{"path":"fixture-24"},{"path":"fixture-25"},{"path":"fixture-26"},{"path":"fixture-27"},{"path":"fixture-28"},{"path":"fixture-29"},{"path":"fixture-30"},{"path":"fixture-31"},{"path":"fixture-32"},{"path":"fixture-33"},{"path":"fixture-34"},{"path":"fixture-35"},{"path":"fixture-36"},{"path":"fixture-37"},{"path":"fixture-38"},{"path":"fixture-39"},{"path":"fixture-40"},{"path":"fixture-41"},{"path":"fixture-42"},{"path":"fixture-43"},{"path":"fixture-44"},{"path":"fixture-45"},{"path":"fixture-46"},{"path":"fixture-47"},{"path":"fixture-48"},{"path":"fixture-49"},{"path":"fixture-50"},{"path":"fixture-51"},{"path":"fixture-52"},{"path":"fixture-53"},{"path":"fixture-54"},{"path":"fixture-55"},{"path":"fixture-56"},{"path":"fixture-57"},{"path":"fixture-58"},{"path":"fixture-59"},{"path":"fixture-60"},{"path":"fixture-61"},{"path":"fixture-62"},{"path":"fixture-63"},{"path":"fixture-64"},{"path":"fixture-65"},{"path":"fixture-66"},{"path":"fixture-67"},{"path":"fixture-68"},{"path":"fixture-69"},{"path":"fixture-70"},{"path":"fixture-71"},{"path":"fixture-72"},{"path":"fixture-73"},{"path":"fixture-74"},{"path":"fixture-75"},{"path":"fixture-76"},{"path":"fixture-77"},{"path":"fixture-78"},{"path":"fixture-79"},{"path":"fixture-80"},{"path":"fixture-81"},{"path":"fixture-82"},{"path":"fixture-83"},{"path":"fixture-84"},{"path":"fixture-85"},{"path":"fixture-86"},{"path":"fixture-87"},{"path":"fixture-88"},{"path":"fixture-89"},{"path":"fixture-90"},{"path":"fixture-91"},{"path":"fixture-92"},{"path":"fixture-93"},{"path":"fixture-94"},{"path":"fixture-95"},{"path":"fixture-96"},{"path":"fixture-97"},{"path":"fixture-98"},{"path":"fixture-99"},{"path":"fixture-100"},{"path":"fixture-101"},{"path":"fixture-102"},{"path":"fixture-103"},{"path":"fixture-104"},{"path":"fixture-105"},{"path":"fixture-106"},{"path":"fixture-107"},{"path":"fixture-108"},{"path":"fixture-109"},{"path":"fixture-110"},{"path":"fixture-111"},{"path":"fixture-112"},{"path":"fixture-113"},{"path":"fixture-114"},{"path":"fixture-115"},{"path":"fixture-116"},{"path":"fixture-117"},{"path":"fixture-118"},{"path":"fixture-119"},{"path":"fixture-120"},{"path":"fixture-121"},{"path":"fixture-122"},{"path":"fixture-123"},{"path":"fixture-124"},{"path":"fixture-125"},{"path":"fixture-126"},{"path":"fixture-127"},{"path":"fixture-128"},{"path":"fixture-129"},{"path":"fixture-130"},{"path":"fixture-131"},{"path":"fixture-132"},{"path":"fixture-133"},{"path":"fixture-134"},{"path":"fixture-135"},{"path":"fixture-136"},{"path":"fixture-137"},{"path":"fixture-138"},{"path":"fixture-139"},{"path":"fixture-140"},{"path":"fixture-141"},{"path":"fixture-142"},{"path":"fixture-143"},{"path":"fixture-144"},{"path":"fixture-145"},{"path":"fixture-146"},{"path":"fixture-147"},{"path":"fixture-148"},{"path":"fixture-149"},{"path":"fixture-150"},{"path":"fixture-151"},{"path":"fixture-152"},{"path":"fixture-153"},{"path":"fixture-154"},{"path":"fixture-155"},{"path":"fixture-156"},{"path":"fixture-157"},{"path":"fixture-158"},{"path":"fixture-159"},{"path":"fixture-160"}],"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"],"version":"0.71.0+codex.bf58e0d9b9d7b99f","installed_native_obligations":"HOLD; no promotion","builder":"scripts/package-shipyard-codex.cjs","build_calls":1,"build_sequence":"built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild","builder_inventory":{"path":"/tmp/phase47-16-planning-root-candidate-inventory.json","sha256":"61a2df1c6ac216650d120e8c477cb42ffbacf86ed6de44e14baca2d166e24d17"},"publication_native_result":{"path":"/tmp/phase47-16-planning-root-parity-result.json","sha256":"82f9bd8a6d20ed93da685fa8e1f30fc9a269c8243d678f75f7ea087e99a47570"}}};
  p.validateR7Contract(h,s,b);
  for (const mutate of [
    b => { b.source.head = '0'.repeat(40); },
    b => { b.source.tree = '0'.repeat(40); },
    b => { b.source.changes.pop(); },
    b => { b.changed_outputs.push('foreign'); },
    b => { b.previous_publication.sha256 = p.R5_HANDOFF_SHA; },
    b => { b.source_finalization.verification.digest = '0'.repeat(64); },
    b => { b.source.config_sha256 = p.SOURCE39_SHA; },
    b => { b.phase_membership = 26; },
    b => { b.build_calls = 2; },
    b => { b.native_receipt = true; },
  ]) {
    const changed=structuredClone(b); mutate(changed);
    assert.throws(() => p.validateR7Contract(h,s,changed));
  }
  const foreign=structuredClone(s);foreign.candidate_path += '/foreign';
  assert.throws(() => p.validateR7Contract(h,foreign,b));
  assert.throws(() => p.validateR6Contract(h,s,b));
});

test('R8 signed squash tuple requires exact merge tree and both ancestry edges', () => {
  const p=require('./phase47-package-publication.test.cjs');
  const source={head:'0b7791c208c2d3069c868d39af4f6bd9b2720e3c',tree:'a'.repeat(40)};
  const e={schema:'shipyard.phase47-t16-squash-publication.v1',actor:'trusted-coordinator',native_receipt:false,
    ticket:'T-47-16',repo:'serhii-nochevnyi/shipyard',pr:452,head:source.head,
    source_stage_sha256:p.R8_HANDOFF_SHA,source_tree:source.tree,merge_tree:source.tree,
    merge_commit:'b'.repeat(40),base_commit:'265110621c8097a83867a9e9dd7958c0e7830cb2',state:'MERGED'};
  const common='/Volumes/KINGSTON/claude-shipyard/.git';
  for (const missing of [null, undefined, {}])
    assert.throws(() => p.validateSquashPublication(missing,source,common,() => source.tree,() => {}));
  assert.throws(() => p.validateSquashPublication({...e,pr:451},source,common,() => source.tree,() => {}));
  const edges=[];
  p.validateSquashPublication(e,source,common,() => source.tree,(a,b) => edges.push([a,b]));
  assert.deepEqual(edges,[[e.base_commit,e.merge_commit],[e.merge_commit,'HEAD']]);
  for (const [field,value] of Object.entries({schema:'foreign',actor:'foreign',native_receipt:true,
    ticket:'T-47-27',repo:'foreign',pr:450,head:'0'.repeat(40),source_stage_sha256:'0'.repeat(64),
    source_tree:'0'.repeat(40),merge_tree:'0'.repeat(40),merge_commit:'invalid',base_commit:'0'.repeat(40),state:'OPEN'})) {
    assert.throws(() => p.validateSquashPublication({...e,[field]:value},source,common,() => source.tree,() => {}));
  }
  assert.throws(() => p.validateSquashPublication(e,source,'/foreign',() => source.tree,() => {}));
  assert.throws(() => p.validateSquashPublication(e,source,common,() => 'c'.repeat(40),() => {}));
  for (const denied of [e.base_commit,e.merge_commit])
    assert.throws(() => p.validateSquashPublication(e,source,common,() => source.tree,a => {if(a===denied)throw Error('not ancestor');}));
});


test('R8 literal authenticated-batch successor rejects altered pins and inventory', () => {
  const p=require('./phase47-package-publication.test.cjs');
  const h={"schema":"shipyard.phase47-t16-publication-generation.v1","actor":"trusted-coordinator","native_receipt":false,"authority":"Operator standing phase47 repair authorization; existing T47-16 supported publisher ownership","status":"completed","source_commit":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/selection.json","selection_sha256":"e53f5bcff100db381aba215bc899f541250f9102ee24a14ab84014a02e5d821d","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/binding.json","binding_sha256":"c9de489f0d340ba0d49c28d6a18b0c95b9915db81d549e31bebe0b99e05b52d7","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/candidate","version":"0.71.0+codex.b319402d6ef6389f","outputs":161,"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/commands/deliver.md","host/plugins/delivery-pipeline/references/arch-review.md","host/plugins/delivery-pipeline/references/pr-sentinel.md","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","package-build.json"],"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/generation.json","sha256":"5d8f2d08de1421849719fdd3db3f3f01b9b8caca474b5b9a4efc485857cbec1a","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/selection.json","selection_sha256":"94f3a5b13babfa51b5389b0c7b9d4ab8a9f3abf504e4561672f0bfa76eb42c92","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json","binding_sha256":"777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1"},"build_calls":1}, s={"schema":"shipyard.phase47-t16-publication-selection.v1","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/candidate","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/binding.json","binding_sha256":"c9de489f0d340ba0d49c28d6a18b0c95b9915db81d549e31bebe0b99e05b52d7","source_commit":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","version":"0.71.0+codex.b319402d6ef6389f","output_count":161}, b={"schema":"shipyard.phase47-t16-publication-binding.v1","actor":"trusted-coordinator","native_receipt":false,"ticket":"T-47-16","phase_membership":27,"source":{"head":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","tree":"4a4afdf128ea7bc533004800a8a2a5d1f9856cc7","status_sha256":"6e45799e5a3580b192b5210dd523a70d0b18bd525166ef2d4a911c29488d4db9","index_sha256":"b0ccd33707914bceb1fed67170744a3e282a3d1447c36ccab910c49e7e787270","inputs":[],"graph_sha256":"0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392","delivery_state_sha256":"7b7c07cbbac8d7d0bf10b8c639fe6c9da75230974098e482f36e0fdcbcabef96","config_sha256":"1195fed6807740e886592ba92ca99913368becde6b21d8de8126ecf134a0efe9","plan_sha256":"f52ee4c06fbc5af6a04c8298d4ca3176f0b14519183c0fbf2a54d2d589cb3c56","worktree":"/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-16-native-landing","common":"/Volumes/KINGSTON/claude-shipyard/.git","changes":["plugins/delivery-pipeline/commands/deliver.md","plugins/delivery-pipeline/references/arch-review.md","plugins/delivery-pipeline/references/pr-sentinel.md","plugins/delivery-pipeline/scripts/role-artifact.cjs","plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","tests/unit/role-artifact.test.cjs"]},"source_finalization":{"path":"/tmp/phase47-16-pr452-final-trusted-fixer-finalization.json","sha256":"f4e5324daa6630f54972323c9c4420f691d54ba031fa76cdfc80ba6eb9394fd3","commit":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","tree":"4a4afdf128ea7bc533004800a8a2a5d1f9856cc7","verification":{"digest":"a38ee7ab4425f7e49a55510bf962df87608e33b722cd4b0d17126716e4e1460b","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9948690cafe3db51f405d431c9f1d12f7529e3300907234e81c069fcbe642162/verification/a38ee7ab4425f7e49a55510bf962df87608e33b722cd4b0d17126716e4e1460b.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-pr452-review-fix-result.json","fixer_result_sha256":"90c94c82cbeb98954044f4ce4c71f221f738f22c2dc23c62a2d946a6d308c85f"},"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/generation.json","sha256":"5d8f2d08de1421849719fdd3db3f3f01b9b8caca474b5b9a4efc485857cbec1a","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/selection.json","selection_sha256":"94f3a5b13babfa51b5389b0c7b9d4ab8a9f3abf504e4561672f0bfa76eb42c92","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json","binding_sha256":"777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1"},"source_snapshots":{"graph":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/source-graph.json","sha256":"0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392"},"state":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/source-delivery-state.json","sha256":"7b7c07cbbac8d7d0bf10b8c639fe6c9da75230974098e482f36e0fdcbcabef96"}},"outputs":[{"path":"0"},{"path":"1"},{"path":"2"},{"path":"3"},{"path":"4"},{"path":"5"},{"path":"6"},{"path":"7"},{"path":"8"},{"path":"9"},{"path":"10"},{"path":"11"},{"path":"12"},{"path":"13"},{"path":"14"},{"path":"15"},{"path":"16"},{"path":"17"},{"path":"18"},{"path":"19"},{"path":"20"},{"path":"21"},{"path":"22"},{"path":"23"},{"path":"24"},{"path":"25"},{"path":"26"},{"path":"27"},{"path":"28"},{"path":"29"},{"path":"30"},{"path":"31"},{"path":"32"},{"path":"33"},{"path":"34"},{"path":"35"},{"path":"36"},{"path":"37"},{"path":"38"},{"path":"39"},{"path":"40"},{"path":"41"},{"path":"42"},{"path":"43"},{"path":"44"},{"path":"45"},{"path":"46"},{"path":"47"},{"path":"48"},{"path":"49"},{"path":"50"},{"path":"51"},{"path":"52"},{"path":"53"},{"path":"54"},{"path":"55"},{"path":"56"},{"path":"57"},{"path":"58"},{"path":"59"},{"path":"60"},{"path":"61"},{"path":"62"},{"path":"63"},{"path":"64"},{"path":"65"},{"path":"66"},{"path":"67"},{"path":"68"},{"path":"69"},{"path":"70"},{"path":"71"},{"path":"72"},{"path":"73"},{"path":"74"},{"path":"75"},{"path":"76"},{"path":"77"},{"path":"78"},{"path":"79"},{"path":"80"},{"path":"81"},{"path":"82"},{"path":"83"},{"path":"84"},{"path":"85"},{"path":"86"},{"path":"87"},{"path":"88"},{"path":"89"},{"path":"90"},{"path":"91"},{"path":"92"},{"path":"93"},{"path":"94"},{"path":"95"},{"path":"96"},{"path":"97"},{"path":"98"},{"path":"99"},{"path":"100"},{"path":"101"},{"path":"102"},{"path":"103"},{"path":"104"},{"path":"105"},{"path":"106"},{"path":"107"},{"path":"108"},{"path":"109"},{"path":"110"},{"path":"111"},{"path":"112"},{"path":"113"},{"path":"114"},{"path":"115"},{"path":"116"},{"path":"117"},{"path":"118"},{"path":"119"},{"path":"120"},{"path":"121"},{"path":"122"},{"path":"123"},{"path":"124"},{"path":"125"},{"path":"126"},{"path":"127"},{"path":"128"},{"path":"129"},{"path":"130"},{"path":"131"},{"path":"132"},{"path":"133"},{"path":"134"},{"path":"135"},{"path":"136"},{"path":"137"},{"path":"138"},{"path":"139"},{"path":"140"},{"path":"141"},{"path":"142"},{"path":"143"},{"path":"144"},{"path":"145"},{"path":"146"},{"path":"147"},{"path":"148"},{"path":"149"},{"path":"150"},{"path":"151"},{"path":"152"},{"path":"153"},{"path":"154"},{"path":"155"},{"path":"156"},{"path":"157"},{"path":"158"},{"path":"159"},{"path":"160"}],"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/commands/deliver.md","host/plugins/delivery-pipeline/references/arch-review.md","host/plugins/delivery-pipeline/references/pr-sentinel.md","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","package-build.json"],"version":"0.71.0+codex.b319402d6ef6389f","installed_native_obligations":"HOLD; no promotion","builder":"scripts/package-shipyard-codex.cjs","build_calls":1,"build_sequence":"built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild","builder_inventory":{"path":"/tmp/phase47-16-pr452-candidate-inventory.json","sha256":"a003127099ff3a327804d6405620e6a57a4ba504c93ce5368a7dbff8fb4f6699"},"publication_native_result":{"path":"/tmp/phase47-16-pr452-parity-result.json","sha256":"e5b93cd1aa6cbf42b2bd1aff135f03222bd561ba3ada0de2b4e37e387aa43ce7"}};
  p.validateR8Contract(h,s,b);
  for (const field of Object.keys(h)) {
    const changed=structuredClone(h); changed[field]=null;
    assert.throws(() => p.validateR8Contract(changed,s,b), field);
  }
  for (const field of Object.keys(s)) {
    const changed=structuredClone(s); changed[field]=null;
    assert.throws(() => p.validateR8Contract(h,changed,b), field);
  }
  for (const field of Object.keys(b)) {
    if (field === 'source') continue;
    const changed=structuredClone(b); changed[field]=null;
    assert.throws(() => p.validateR8Contract(h,s,changed), field);
  }
  for (const field of Object.keys(b.source)) {
    if (field === 'inputs') continue;
    const changed=structuredClone(b); changed.source[field]=null;
    assert.throws(() => p.validateR8Contract(h,s,changed), field);
  }
  const duplicate=structuredClone(b); duplicate.outputs[1]=duplicate.outputs[0];
  assert.throws(() => p.validateR8Contract(h,s,duplicate));
});


test('R8 installed package literal shape validates bytes and refuses drift without legacy hashes', t => {
  const fixture = productFixture(t);
  const binding = structuredClone(fixture.binding);
  delete binding.source_content_sha256;
  delete binding.package_sha256;
  for (const entry of binding.outputs) {
    entry.sealed_mode = entry.publication_mode & ~0o222;
    fs.chmodSync(path.join(fixture.installed, entry.path), entry.sealed_mode);
  }
  assert.throws(() => acceptance.comparePackage(fixture.installed, binding, true), /content digest mismatch/);
  const normalized = acceptance.r8InstalledPackageBinding(fixture.installed, binding);
  assert.equal(normalized.package_sha256, fixture.binding.package_sha256);
  assert.equal(normalized.source_content_sha256, fixture.binding.source_content_sha256);
  assert.equal(binding.package_sha256, undefined);
  const changed = structuredClone(binding);
  changed.outputs[0].sha256 = '0'.repeat(64);
  assert.throws(() => acceptance.r8InstalledPackageBinding(fixture.installed, changed), /sealed output drift/);
  const legacy = { identity: { generation_kind: 'main-review-repair' },
    selection: { candidate_sha256: 'original' }, binding: { source: { identities: ['original'], policy_sha256: 'policy' } } };
  assert.deepEqual(acceptance.installedContract(legacy), {
    inputs: ['original'], policy: 'policy', candidate: 'original', binding: legacy.binding });
});
