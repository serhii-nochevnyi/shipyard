'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

// Reuse the already owned deterministic fixtures, with their product imports
// rebound to the actual package bytes. These are fixture observations, not
// native release receipts. Only the named boundaries execute.
function packagedSuite(t, filename, pattern, count) {
  const f = productFixture(t);
  const sourceFile = path.join(__dirname, filename);
  let source = fs.readFileSync(sourceFile, 'utf8').replaceAll('../../plugins/delivery-pipeline',
    path.join(f.installed, 'host/plugins/delivery-pipeline'));
  const projected = path.join(f.temporary, filename);
  source = source.replaceAll("require('./assert-harness.cjs')",
    'require(' + JSON.stringify(path.join(__dirname, 'assert-harness.cjs')) + ')');
  // The decompose fixture uses sibling raw stream samples. Retain its test
  // directory while compiling; preload fixtures use their projected file.
  let script = filename === 'codex-decompose-host.test.cjs'
    ? `const Module=require('node:module');const filename=${JSON.stringify(sourceFile)};
      const m=new Module(filename);m.filename=filename;m.paths=Module._nodeModulePaths(${JSON.stringify(__dirname)});
      process.mainModule=m;m._compile(${JSON.stringify(source)},filename);`
    : null;
  fs.writeFileSync(projected, source);
  const env = { ...process.env, CODEX_HOME: path.join(f.temporary, 'codex'),
    GIT_CONFIG_GLOBAL: path.join(f.temporary, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\nname = Acceptance Fixture\nemail = fixture@example.test\n[commit]\ngpgsign = false\n');
  delete env.NODE_OPTIONS; delete env.SHIPYARD_GRAPH_DIR;
  delete env.NODE_TEST_CONTEXT; delete env.SHIPYARD_RESEARCH_HANDBACK_FIXTURE;
  const argv = script ? ['--test-name-pattern', pattern, '-e', script]
    : ['--test', '--test-name-pattern', pattern, projected];
  const result = spawnSync(process.execPath, argv, { env, encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
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
  const response = payload => ({ type: 'response_item', payload });
  const records = [
    { type: 'session_meta', payload: { parent_thread_id: relay.parent_thread_id } },
    response({ type: 'agent_message', author: '/root', recipient: relay.task_path }),
    response({ type: 'custom_tool_call', name: 'exec', call_id: 'first',
      input: 'const r = await tools.exec_command(' + JSON.stringify({ cmd:
        'node -e ' + JSON.stringify('const fs=require("fs"),crypto=require("crypto");console.log(crypto.createHash("sha256").update(fs.readFileSync(' + JSON.stringify(task.path) + ')).digest("hex"))') }) + '); text(r.output);' }),
    response({ type: 'custom_tool_call_output', call_id: 'first', output: task.sha256 }),
  ];
  const jsonl = () => records.map(record => JSON.stringify(record)).join('\n');
  assert.equal(acceptance.validateInlineFirstCall(jsonl(), task, relay, f.scripts), true);
  const good = records[2];
  records[2] = response({ ...good.payload, input: "python - <<'PY'\nread denied\nPY" });
  records[3] = response({ type: 'custom_tool_call_output', call_id: 'first', output: 'operation not permitted' });
  records.push(response({ ...good.payload, call_id: 'later' }),
    response({ type: 'custom_tool_call_output', call_id: 'later', output: task.sha256 }));
  assert.throws(() => acceptance.validateInlineFirstCall(jsonl(), task, relay, f.scripts), /first call/);
});
