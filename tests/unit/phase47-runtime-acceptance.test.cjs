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
