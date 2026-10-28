'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { Session } = require('node:inspector');
const { Worker } = require('node:worker_threads');
const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(ROOT, 'plugins/delivery-pipeline');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const contract = 'shipyard.semantic-review.v1';

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function fixtureEnvironment(home) {
  const env = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) {
    if (/^(SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|GIT_CONFIG_)/.test(key)) delete env[key];
  }
  for (const key of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return env;
}

function generateFixture(directory, plugin = SOURCE) {
  const policy = require(path.join(plugin, 'scripts/model-policy.cjs'));
  const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat().map(rung => ({
    model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort,
  }));
  const capabilities = { supportedModels: [...new Set(selections.map(row => row.model))],
    supportedEfforts: [...new Set(selections.map(row => row.effort))], supportedSelections: selections };
  const codexHome = path.join(directory, 'home/.codex'), out = path.join(directory, 'generated');
  const converter = path.join(codexHome, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  write(converter, 'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n');
  const capabilitiesFile = path.join(directory, 'capabilities.json');
  write(capabilitiesFile, JSON.stringify(capabilities) + '\n');
  const project = path.join(directory, 'project');
  write(path.join(project, '.planning/config.json'), '{}\n');
  const executable = path.join(directory, 'bin/codex');
  write(executable, '#!/bin/sh\nprintf "codex-cli 0.155.1\\n"\n');
  fs.chmodSync(executable, 0o755);
  const env = { ...fixtureEnvironment(path.dirname(codexHome)), CODEX_HOME: codexHome,
    GSD_HOME: path.dirname(codexHome), PATH: path.dirname(executable) + path.delimiter + process.env.PATH };
  delete env.NODE_TEST_CONTEXT;
  const generated = spawnSync(process.execPath, [path.join(ROOT, 'scripts/gen-codex-shipyard.cjs'),
    '--plugin', plugin, '--out', out, '--codex-home', codexHome, '--project-dir', project,
    '--phase', '2', '--capabilities', capabilitiesFile, '--gsd-lib', converter],
  { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(generated.status, 0, generated.stderr || String(generated.error));
  const options = { codexHome, phase: 2, capabilities };
  const generator = require(path.join(ROOT, 'scripts/gen-codex-shipyard.cjs'));
  const manifest = generator.validateCodexBundle(out, options);
  return { out, options, manifest, converter, plugin };
}

function loadPrefix(name, end, names) {
  const filename = path.join(ROOT, 'tests/unit', name), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = Module._load;
  try {
    Module._load = function(request, ...args) {
      return request === 'node:test' ? { test() {}, describe() {} } : original.call(this, request, ...args);
    };
    const text = fs.readFileSync(filename, 'utf8');
    assert.ok(text.includes(end), 'fixture boundary must remain explicit: ' + name);
    loaded._compile(text.slice(0, text.indexOf(end)) + '\nmodule.exports = { ' + names + ' };', filename);
  } finally { Module._load = original; }
  return loaded.exports;
}

function routePayload(plugin) {
  const original = Module._resolveFilename;
  Module._resolveFilename = function(...args) {
    const file = original.apply(this, args);
    return typeof file === 'string' && file.startsWith(SOURCE + path.sep)
      ? path.join(plugin, path.relative(SOURCE, file)) : file;
  };
  return () => { Module._resolveFilename = original; };
}

function coldCurrent(f, role, plugin) {
  const artifact = path.join(plugin, 'scripts/role-artifact.cjs');
  const gate = path.join(plugin, 'scripts/gate-trailer.cjs');
  const saved = [require.cache[artifact], require.cache[gate]];
  delete require.cache[artifact]; delete require.cache[gate];
  try {
    const input = { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
      head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid,
      headBranch: f.pr.headRefName };
    const current = require(artifact)[{ integrator: 'currentIntegrationVerdict',
      'arch-review': 'currentArchitectureVerdict', 'code-review': 'currentCodeReviewVerdict' }[role]](input);
    if (role === 'code-review') {
      const result = require(path.join(plugin, 'scripts/phase-code-review.cjs')).verifyCodeReview({
        live: f.pr, worktree: f.worktree, graphDir: f.graphDir });
      assert.equal(result.ok, !!current, JSON.stringify(result));
    } else {
      const checked = require(gate).verifyCurrentReviews({ ...input, getPullRequest: () => ({ ...f.pr }) });
      if (role === 'integrator') assert.deepEqual(checked.integration, current);
      else assert.equal(checked.architecture.ready, !!current);
    }
    return current;
  } finally {
    for (const [index, file] of [artifact, gate].entries()) {
      if (saved[index]) require.cache[file] = saved[index]; else delete require.cache[file];
    }
  }
}

async function observeRetirement(plugin, run) {
  const session = new Session(); session.connect();
  const post = (method, parameters = {}) => new Promise((resolve, reject) =>
    session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
  const retired = {
    'codex-delivery-host.cjs': ['runCodexIntegrationPartitions', 'automaticReaderProfile'],
    'claude-role-host.cjs': ['prepareReservedClaudeIntegration', 'runClaudeIntegrationPartitions', 'integrationStageSchema'],
    'role-artifact.cjs': ['prepareIntegrationPartitions', 'buildPartitionUnits', 'renderPartitionInput', 'compactPair'],
    'codex-arch-review-context.cjs': ['createReaderBatchProfile', 'admitReaderBatchInput', 'readerBatches', 'batchCommand',
      'installedReaderProfile', 'integrationPartitionBinding'],
  };
  try {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    let captured = false;
    const value = await run(async () => {
    const { result } = await post('Profiler.takePreciseCoverage');
    let observed = 0, semanticCalls = 0;
    for (const script of result) {
      const file = script.url.startsWith('file:') ? require('node:url').fileURLToPath(script.url) : script.url;
      if (!file.startsWith(plugin + path.sep)) continue;
      const names = retired[path.basename(file)] || [];
      for (const fn of script.functions) {
        if (names.includes(fn.functionName)) {
          observed++;
          assert.equal(fn.ranges[0].count, 0, 'ordinary dispatch reached retired ' + fn.functionName);
        }
        if (['runSemanticReview', 'runClaudeSemanticReview'].includes(fn.functionName)) semanticCalls += fn.ranges[0].count;
      }
    }
    assert.ok(observed >= 10, 'execution observer must include dormant producer, scheduler and renderer functions: ' + observed);
    assert.ok(semanticCalls > 0, 'execution observer must see the actual semantic coordinator');
    await post('Profiler.stopPreciseCoverage');
    await post('Profiler.disable');
    captured = true;
    });
    assert.ok(captured, 'initial ordinary dispatch must finish before retirement proof');
    return value;
  } finally {
    session.disconnect();
  }
}

async function ordinaryAcceptance(plugin, runtime, role, capture = async () => {}) {
  const codex = loadPrefix('phase53-codex-architecture.test.cjs', "test('caller architecture",
    'architectureFixture, ordinaryArchitecture, publicIntegrationFixture, phaseBinding');
  const integration = loadPrefix('phase53-codex-integration.test.cjs', 'function coldCurrent', 'semanticFixture');
  const claude = loadPrefix('phase53-claude-review.test.cjs', "for (const role of ['integrator'", 'nativeFixture');
  const code = loadPrefix('phase53-code-review.test.cjs', "for (const runtime of ['codex', 'claude'])", 'fixture, setup');
  let acceptedResult;
  await codex.publicIntegrationFixture(async f => {
    if (role === 'code-review') code.setup(f);
    let generated;
    if (runtime === 'codex') {
      generated = generateFixture(path.join(f.root, 'actual-generated-instructions'), plugin);
      const policy = require(path.join(plugin, 'scripts/model-policy.cjs'));
      const selection = policy.resolveDispatch({ runtime, role, signals: { risk: 'high', checkpoint: true } });
      const manifest = structuredClone(generated.manifest);
      manifest.agent_files = [selection.agent_file, ...manifest.agent_files.filter(file => file !== selection.agent_file)];
      write(path.join(generated.out, 'manifest.json'), JSON.stringify(manifest) + '\n');
      require(path.join(ROOT, 'scripts/gen-codex-shipyard.cjs')).validateCodexBundle(generated.out, generated.options);
      f.agents[role] = { dir: path.join(generated.out, 'agents'), manifest: path.join(generated.out, 'manifest.json'),
        selection, capabilities: generated.options.capabilities,
        text: fs.readFileSync(path.join(generated.out, 'agents', selection.agent_file), 'utf8') };
    }
    const controls = runtime === 'codex' && role === 'integrator' ? { native(rows) {
      rows.find(row => row.type === 'turn_context').payload.sandbox_policy.type = 'workspace-write';
    } } : {};
    const prepared = role === 'code-review' ? code.fixture(f, runtime)
      : runtime === 'claude' ? claude.nativeFixture(f, role)
        : role === 'integrator' ? integration.semanticFixture(f, controls) : codex.architectureFixture(f);
    const api = name => require(path.join(plugin, 'scripts', name + '.cjs'));
    const run = role === 'integrator' ? async () => {
      const command = fs.readFileSync(path.join(plugin, 'commands/deliver.md'), 'utf8');
      const section = command.slice(command.indexOf('**Fresh final integration contract.**'));
      const snippet = section.match(/```javascript\n([\s\S]*?)\n\s*```/)[1];
      const invoke = new (Object.getPrototypeOf(async function() {}).constructor)(
        'require', 'CLAUDE_PLUGIN_ROOT', 'options', 'worktree', 'phase', 'run_id', 'runtime', snippet + '\nreturn result;');
      return invoke(require, plugin, prepared.options, f.worktree, 49, 'shipping-' + ++f.count, runtime);
    } : role === 'code-review' ? prepared.run
      : runtime === 'claude' ? () => api('claude-role-host').createClaudeRoleHost(prepared.options).run({
        schema: 'shipyard.claude-role-request.v1', role, worktree: f.worktree, phase: f.phase, pr: f.pr.number })
        : () => codex.ordinaryArchitecture(f, prepared);
    process.stderr.write('ordinary ' + runtime + '/' + role + ': launch\n');
    const result = await run();
    await capture();
    process.stderr.write('ordinary ' + runtime + '/' + role + ': accepted\n');
    assert.equal(result.result.review_contract, contract);
    assert.equal(result.role, role);
    assert.equal(prepared.launches.length, 3);
    const workers = prepared.launches.slice(0, 2), final = prepared.launches[2];
    assert.deepEqual(prepared.completed, [workers[1].payload.assignment.id, workers[0].payload.assignment.id, 'final']);
    assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
    assert.equal(final.payload.role, role);
    assert.equal(final.payload.originals.length, 2);
    for (const original of final.payload.originals) {
      const launch = workers.find(item => item.payload.assignment.id === original.reference.assignment_id);
      assert.equal(original.original_text, launch.text || launch.originalText);
      assert.deepEqual(api('role-artifact').readSemanticOriginal({ worktreePath: f.worktree,
        snapshot_sha256: final.payload.snapshot_sha256, assignment_id: original.reference.assignment_id }), original);
      for (const pin of [original.native.native_pin, original.native.output_pin]) {
        const bytes = fs.readFileSync(pin.path);
        assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
      }
    }
    assert.ok(coldCurrent(f, role, plugin)?.authenticated);
    process.stderr.write('ordinary ' + runtime + '/' + role + ': restart\n');
    const restarted = await run();
    process.stderr.write('ordinary ' + runtime + '/' + role + ': reused\n');
    assert.equal(prepared.launches.length, 3, 'compatible restart must reuse the original sessions');
    assert.deepEqual(restarted.receipt, result.receipt);
    const files = role === 'integrator' ? [path.join(f.worktree, 'src/provider.cjs'),
      path.join(f.worktree, f.rows['T-49-01'].plan),
      path.join(f.worktree, '.planning/architecture/ADR-014-original.md')]
      : role === 'arch-review' ? [path.join(f.graphDir, 'tickets.json')]
        : [final.payload.originals[0].native.native_pin.path, final.payload.originals[0].native.output_pin.path];
    if (generated) files.push(path.join(prepared.options.agentDir,
      JSON.parse(fs.readFileSync(prepared.options.agentManifest)).agent_files[0]));
    for (const file of files) {
      const original = fs.readFileSync(file);
      const manifestFile = generated && prepared.options.agentManifest;
      const manifestBytes = manifestFile && fs.readFileSync(manifestFile);
      try {
        fs.appendFileSync(file, '\n');
        assert.equal(coldCurrent(f, role, plugin), null, 'stale pin: ' + file);
        if (generated && path.dirname(file) === prepared.options.agentDir) {
          const altered = JSON.parse(manifestBytes);
          altered.agent_digests[path.basename(file)] = hash(fs.readFileSync(file));
          fs.writeFileSync(manifestFile, JSON.stringify(altered) + '\n');
          require(path.join(ROOT, 'scripts/gen-codex-shipyard.cjs')).validateCodexBundle(generated.out, generated.options);
          assert.equal(coldCurrent(f, role, plugin), null, 'a new manifest digest cannot replace original instruction custody');
        }
      } finally {
        fs.writeFileSync(file, original);
        if (manifestBytes) fs.writeFileSync(manifestFile, manifestBytes);
      }
      assert.ok(coldCurrent(f, role, plugin)?.authenticated);
    }
    if (plugin !== fs.realpathSync(SOURCE)) for (const relative of [
      'scripts/' + runtime + (runtime === 'claude' ? '-role-host.cjs' : '-delivery-host.cjs'),
      'references/' + role + '.md',
    ]) {
      const file = path.join(plugin, relative), bytes = fs.readFileSync(file);
      try { fs.appendFileSync(file, '\n'); assert.equal(coldCurrent(f, role, plugin), null, 'substituted staged source: ' + relative); }
      finally { fs.writeFileSync(file, bytes); }
      assert.ok(coldCurrent(f, role, plugin)?.authenticated);
    }
    const base = f.pr.baseRefOid;
    try { f.pr.baseRefOid = f.head; assert.equal(coldCurrent(f, role, plugin), null); }
    finally { f.pr.baseRefOid = base; }
    const receipt = result.receipt;
    assert.equal(receipt.runtime, runtime); assert.equal(receipt.role, role);
    const selection = Object.fromEntries(['requested_model', 'requested_effort', 'applied_model', 'applied_effort',
      'observed_model', 'observed_effort', 'policy_hash'].map(key => {
      assert.equal(typeof receipt[key], 'string', 'missing actual receipt field: ' + key);
      return [key, receipt[key]];
    }));
    const instruction = generated ? path.join(prepared.options.agentDir, receipt.agent_file)
      : path.join(plugin, 'references', role + '.md');
    const bytes = fs.readFileSync(instruction);
    acceptedResult = { runtime, role, review_contract: contract, physical_sessions: 3, compatible_restart: true,
      dispatch_id: receipt.dispatch_id, snapshot_sha256: final.payload.snapshot_sha256, selection,
      instruction: { path: instruction, sha256: hash(bytes), bytes: bytes.length },
      worker_accounting: final.payload.originals.map(original => original.native.accounting),
      current_gate: true, retired_dispatches: 0, installed_native_acceptance: false };
  });
  assert.ok(acceptedResult, 'ordinary fixture must return its validated role result');
  return acceptedResult;
}

const regressionGroups = {
  historical: [
    ['phase53-claude-review.test.cjs', 'if (isMainThread) {',
      /^(historical Claude compatibility:|both original Claude)/],
    ['phase53-code-review.test.cjs', 'if (isMainThread) describe', /^original-version code-review history/],
    ['phase49-incremental-integration.test.cjs', null,
      /^unknown integration and dictionary versions fail closed while v1 full input stays supported$/],
  ],
  recovery: [
    ['phase53-review-recovery.test.cjs', 'if (isMainThread) describe',
      /^(codex|claude) code-review: completed original survives|^(codex|claude) integrator: started uncertainty refuses|native original, output and receipt tampering/],
    ['phase53-codex-architecture.test.cjs', null,
      /^architecture refuses (worker-as-final|reused-session|wrong-role|focused-contract) completion authority$/],
  ],
  outcomes: [
    ['phase53-codex-integration.test.cjs', null,
      /^retains complete incomplete original|^independent final evaluates actual producer\/consumer mismatch: needs-fix$/],
    ['phase53-claude-review.test.cjs', 'if (isMainThread) {',
      /retains explicit resource-stop without granting completion/],
    ['phase53-code-review.test.cjs', 'if (isMainThread) describe',
      /incomplete final retains/],
  ],
  ci: [['phase53-ci-observation.test.cjs', null,
    /direct and publication waiter paths agree|same generation forged projection|combined check\/status pages|bound reader refuses inconsistent|fresh direct fallback/]],
  launch: [['phase53-launch-reuse.test.cjs', null,
    /actual CLI and native constructor acquire one unchanged|changed native reference bytes|serialized availability and reuse flags/]],
};

async function runRegressions(plugin, group, onlyTitle) {
  const selected = regressionGroups[group];
  assert.ok(selected, 'unknown acceptance regression group');
  const completed = [], jobs = [];
  for (const [name, end, select] of selected) {
    const filename = path.join(ROOT, 'tests/unit', name), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const registered = [], original = Module._load;
    const register = (title, ...args) => registered.push({ title, run: args.at(-1) });
    try {
      Module._load = function(request, ...args) {
        return request === 'node:test' ? { test: register, describe() {} } : original.call(this, request, ...args);
      };
      let source = fs.readFileSync(filename, 'utf8');
      if (end) {
        assert.ok(source.includes(end), 'explicit regression boundary changed: ' + name);
        source = source.slice(0, source.indexOf(end));
      }
      source = source.replaceAll("path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts')",
        JSON.stringify(path.join(plugin, 'scripts')));
      loaded._compile(source + (source.includes('const cases = []') ? '\nmodule.exports = cases;' : ''), filename);
    } finally { Module._load = original; }
    const cases = Array.isArray(loaded.exports) ? loaded.exports : registered;
    const matches = cases.filter(entry => select.test(entry.title));
    assert.ok(matches.length, 'regression selection became empty: ' + name);
    for (const entry of matches) {
      if (!onlyTitle && group !== 'launch') { jobs.push(entry.title); continue; }
      if (onlyTitle && entry.title !== onlyTitle) continue;
      const after = [];
      try { await entry.run({ after(fn) { after.push(fn); } }); }
      finally { for (const cleanup of after.reverse()) await cleanup(); }
      completed.push(entry.title);
    }
  }
  if (onlyTitle) {
    assert.deepEqual(completed, [onlyTitle], 'worker must finish its exact registered scenario');
    return completed;
  }
  if (group === 'launch') {
    assert.ok(completed.length, 'launch boundary selection must complete');
    return completed;
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (next < jobs.length) {
      const title = jobs[next++];
      await new Promise((resolve, reject) => {
        const worker = new Worker(`
          const { workerData, parentPort } = require('node:worker_threads');
          const smoke = require(workerData.file);
          smoke.runAcceptance(workerData.plugin, workerData.kind, workerData.group, workerData.title)
            .then(result => parentPort.postMessage(result.completed));
        `, { eval: true, workerData: { file: __filename, plugin, group, title, kind: 'source-fixture' } });
        let acknowledged = false;
        worker.on('message', result => {
          try { assert.deepEqual(result, [title]); acknowledged = true; }
          catch (error) { reject(error); }
        });
        worker.on('error', reject);
        worker.on('exit', code => {
          if (code !== 0 || !acknowledged) reject(new Error('unfinished regression worker: ' + title));
          else resolve();
        });
      });
      process.stderr.write(group + ': completed ' + title + '\n');
      completed.push(title);
    }
  }));
  assert.deepEqual([...completed].sort(), [...jobs].sort());
  return completed;
}

async function runAcceptance(plugin, kind, group = 'ordinary', onlyTitle) {
  assert.ok(['source-fixture', 'staged-package-fixture'].includes(kind));
  plugin = fs.realpathSync(plugin);
  const ordinaryRole = /^ordinary:(codex|claude):(integrator|arch-review|code-review)$/.exec(group);
  const restore = routePayload(plugin);
  try {
    if (group !== 'ordinary' && !ordinaryRole) return { identity: kind, payload_root: plugin,
      group, completed: await runRegressions(plugin, group, onlyTitle), installed_native_acceptance: false,
      production_resource_fit: 'unknown', rollout: false, release: false };
    const subjects = ordinaryRole ? [{ runtime: ordinaryRole[1], role: ordinaryRole[2] }]
      : ['codex', 'claude'].flatMap(runtime =>
        ['integrator', 'arch-review', 'code-review'].map(role => ({ runtime, role })));
    const roles = new Array(subjects.length);
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < subjects.length) {
        const index = next++, subject = subjects[index];
        roles[index] = await new Promise((resolve, reject) => {
          const worker = new Worker(`
            const { workerData, parentPort } = require('node:worker_threads');
            require(workerData.file).runOrdinaryRole(workerData.plugin, workerData.runtime, workerData.role)
              .then(result => parentPort.postMessage(result));
          `, { eval: true, workerData: { file: __filename, plugin, ...subject } });
          let result;
          worker.on('message', value => { result = value; });
          worker.on('error', reject);
          worker.on('exit', code => {
            if (code !== 0 || !result || result.runtime !== subject.runtime || result.role !== subject.role)
              reject(new Error('unfinished ordinary worker: ' + subject.runtime + '/' + subject.role));
            else resolve(result);
          });
        });
      }
    }));
    return { identity: kind, payload_root: plugin, roles, installed_native_acceptance: false,
      production_resource_fit: 'unknown', rollout: false, release: false };
  } finally { restore(); }
}

async function runOrdinaryRole(plugin, runtime, role) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-ordinary-worker-')));
  const actual = plugin === fs.realpathSync(SOURCE) ? plugin : path.join(directory, 'payload');
  if (actual !== plugin) fs.cpSync(plugin, actual, { recursive: true });
  const restore = routePayload(actual);
  try {
    const result = await observeRetirement(actual, capture => ordinaryAcceptance(actual, runtime, role, capture));
    for (const file of ['codex-delivery-host', 'claude-role-host', 'codex-runtime-host', 'claude-runtime-host', 'role-artifact'])
      assert.ok(require.cache[path.join(actual, 'scripts', file + '.cjs')], 'actual payload entrypoint was not loaded: ' + file);
    return result;
  } finally { restore(); fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { generateFixture, fixtureEnvironment, runAcceptance, runOrdinaryRole, hash, ROOT, SOURCE };
if (require.main === module) {
  const [kind, plugin, group] = process.argv.slice(2);
  if (!plugin || !['source-fixture', 'staged-package-fixture'].includes(kind)) {
    process.stderr.write('Usage: node tests/smoke/phase53-review-acceptance.cjs <source-fixture|staged-package-fixture> <delivery-pipeline-root> [ordinary|ordinary:<codex|claude>:<integrator|arch-review|code-review>|historical|recovery|outcomes|ci|launch]\nFixture transports only; installed native acceptance and production resource fit remain unknown.\n');
    process.exitCode = 2;
  } else runAcceptance(plugin, kind, group).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
