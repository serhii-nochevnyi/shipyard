'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const SOURCE = path.join(ROOT, 'plugins/delivery-pipeline');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const LIMIT = 180000;
const OUTPUT = 8 * 1024 * 1024;
const snapshots = new Map();

function setup(name, boundary, names, plugin, adapt = source => source) {
  const filename = path.join(ROOT, 'tests', name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  let source = fs.readFileSync(filename, 'utf8');
  if (plugin) source = source.replace("path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts')",
    JSON.stringify(path.join(plugin, 'scripts')));
  assert.ok(source.includes(boundary), 'explicit setup boundary: ' + name);
  source = adapt(source.slice(0, source.indexOf(boundary)));
  const original = Module._load;
  try {
    Module._load = function(request, ...args) {
      if (request === 'node:test') return { test() {}, describe() {} };
      const api = original.call(this, request, ...args);
      if (!request.endsWith('/role-artifact.cjs')) return api;
      return { ...api, prepareSemanticReview(...input) {
        const snapshot = api.prepareSemanticReview(...input);
        snapshots.set(snapshot.snapshot_sha256, snapshot);
        return snapshot;
      } };
    };
    loaded._compile(source + '\nmodule.exports = { ' + names + ' };', filename);
  } finally { Module._load = original; }
  return loaded.exports;
}

function cold(f, plugin, deadline) {
  const input = { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
    head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName };
  const result = spawnSync(process.execPath, [__filename, '--cold', plugin, JSON.stringify(input), JSON.stringify(f.pr), os.homedir()], {
    env: process.env, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: OUTPUT,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = prefix + entry.name, file = path.join(root, relative), stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink());
      return entry.isDirectory() ? inventory(root, relative + '/')
        : [{ path: relative, sha256: hash(fs.readFileSync(file)), mode: stat.mode & 0o7777 }];
    });
}

function parity(candidate) {
  assert.deepEqual(inventory(candidate), inventory(path.join(ROOT, 'plugins/shipyard')));
  const digest = createHash('sha256');
  for (const row of inventory(candidate)) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)) continue;
    digest.update(row.path + '\0').update(fs.readFileSync(path.join(candidate, row.path)));
  }
  const sourceDigest = digest.digest('hex');
  const manifestBytes = fs.readFileSync(path.join(candidate, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes), record = JSON.parse(fs.readFileSync(path.join(candidate, 'package-build.json')));
  const version = JSON.parse(fs.readFileSync(path.join(SOURCE, '.claude-plugin/plugin.json'))).version;
  assert.equal(manifest.version, version + '+codex.' + sourceDigest.slice(0, 16));
  assert.equal(record.version, manifest.version);
  assert.equal(record.digest, createHash('sha256').update(sourceDigest).update('\0').update(manifestBytes).digest('hex'));
  for (const file of ['package-build.json', '.codex-plugin/plugin.json'])
    assert.deepEqual(fs.readFileSync(path.join(candidate, file)), fs.readFileSync(path.join(ROOT, 'plugins/shipyard', file)));
}

function shards() {
  const s = require('../../unit/shard-files.cjs'), manifest = s.readManifest();
  assert.equal(hash(fs.readFileSync(path.join(ROOT, 'tests/unit/shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.equal(manifest.shards.length, 16);
  const actual = s.appendShard(manifest, s.unitTasks(s.unitFiles()));
  assert.equal(hash(JSON.stringify(actual.shards.slice(0, 28))),
    'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  const appended = ['phase53-z11-ci-check-identity.test.cjs', 'phase53-z12-claude-transcript-stability.test.cjs',
    'phase53-z13-negative-query-outcomes.test.cjs', 'phase53-z14-codex-native-preamble.test.cjs',
    'phase53-z14b-codex-native-preamble-final.test.cjs', 'phase53-z15-responsibility-support.test.cjs',
    'phase53-z16-final-followup-acceptance.test.cjs', 'phase53-z16b-final-followup-negative.test.cjs'];
  assert.deepEqual(actual.shards.slice(28, 28 + appended.length), appended.map(file => [file]));
  const denominator = actual.shards.length;
  assert.ok(denominator >= 28 + appended.length);
  const futureTask = 'zz-future-phase-regression.test.cjs';
  const extended = s.appendShard(manifest, s.unitTasks([...s.unitFiles(), futureTask]));
  assert.deepEqual(extended.shards.slice(0, denominator), actual.shards);
  assert.deepEqual(extended.shards.at(-1), [futureTask]);
  for (let i = 0; i < denominator; i++)
    assert.deepEqual(s.selectTaskShard(`${i + 1}/${denominator}`), actual.shards[i]);
  for (const file of appended) assert.equal(actual.shards.flat().filter(item => item === file).length, 1);
  return denominator;
}

function scoped(payload, snapshot, validation) {
  assert.ok(snapshot, 'capture the complete actual public preparation');
  validation.assertSemanticSnapshot(snapshot);
  assert.equal(payload.snapshot_sha256, snapshot.snapshot_sha256);
  assert.deepEqual(payload.reviewed_identity, snapshot.identity);
  const assignment = snapshot.assignments.find(item => item.id === payload.assignment?.id);
  assert.equal(payload.assignment?.id || null, assignment?.id || null);
  assert.equal(payload.responsibility_view_version, 'shipyard.semantic-responsibility-view.v1');
  const view = validation.semanticRequiredView(snapshot, assignment);
  assert.deepEqual(payload.material.map(({ read_path, ...source }) => source), view.material);
  assert.deepEqual(payload.obligations, view.obligations);
  assert.deepEqual(payload.obligation_ids, view.obligation_ids);
  assert.deepEqual(payload.seams, view.seams);
  assert.deepEqual(payload.required_context, view.required_context);
  if (!assignment) {
    assert.equal(payload.assignment, null);
    assert.deepEqual(payload.material.map(item => item.source_id), snapshot.material.map(item => item.source_id));
    assert.deepEqual(payload.independent_final_seam_ids, snapshot.independent_final_seam_ids);
    assert.deepEqual(payload.cross_responsibility_seam_ids, snapshot.cross_responsibility_seam_ids);
    return;
  }
  const { required_material_source_ids, required_criteria_obligation_ids, required_seam_ids, required_context, ...inline } = assignment;
  assert.deepEqual(payload.assignment, inline);
  assert.deepEqual(required_material_source_ids, view.material.map(item => item.source_id));
  assert.deepEqual(required_criteria_obligation_ids, view.obligations.filter(item => !item.source_id).map(item => item.id));
  assert.deepEqual(required_seam_ids, view.seams.map(item => item.id));
  assert.deepEqual(required_context, view.required_context);
  assert.deepEqual(payload.material.map(item => item.source_id), assignment.required_material_source_ids);
  assert.deepEqual(payload.seams.map(item => item.id), assignment.required_seam_ids);
  for (const id of assignment.support_obligation_ids) assert.ok(assignment.support_reasons[id]?.length);
  const catalog = fs.readFileSync(payload.catalog.read_path);
  assert.equal(hash(catalog), payload.catalog.sha256);
  const global = JSON.parse(catalog);
  assert.ok(global.material.length >= payload.material.length);
  for (const id of payload.obligation_ids) assert.ok(global.obligations.some(item => item.id === id));
}

function finding(result) {
  result.findings.push({ id: 'Z16-INFO', type: 'informational', blocking: false,
    summary: 'Hermetic combined boundary stimulus.', evidence: 'src/provider.cjs:1', ticket: null });
}

async function combined(plugin, runtime, deadline, kind) {
  const smoke = setup('smoke/phase53-review-acceptance.cjs', 'async function observeRetirement',
    'generateFixture, fixtureEnvironment, loadPrefix, routePayload');
  const restore = smoke.routePayload(plugin);
  const completed = [];
  try {
    const filename = path.join(plugin, 'scripts/role-artifact.cjs'), validation = new Module(filename, module);
    validation.filename = filename; validation.paths = Module._nodeModulePaths(path.dirname(filename));
    validation._compile(fs.readFileSync(filename, 'utf8')
      + '\nmodule.exports = { assertSemanticSnapshot, semanticRequiredView };', filename);
    const h = setup('unit/phase53-codex-integration.test.cjs', "test('ordinary Codex caller",
      'publicIntegrationFixture, semanticFixture, supportedPartitionCaller, captureOriginals, write, commit');
    const claude = runtime === 'claude' ? setup('unit/phase53-claude-review.test.cjs',
      "for (const role of ['integrator'", 'nativeFixture', undefined, source => {
        const call = 'runtime.createClaudeRuntimeHost({ ...input, uuid: () => session,';
        assert.equal(source.split(call).length, 2, 'one physical Claude fixture host');
        return source.replace(call, 'runtime.createClaudeRuntimeHost({ ...input, ...controls.clock(session), uuid: () => session,');
      }) : null;
    const preamble = require('./codex-preamble-helpers.cjs');
    const { registered, template } = require('./code-review-native-driver.cjs');
    const captured = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
    const api = name => require(path.join(plugin, 'scripts', name + '.cjs'));
    const variants = expectedVariants(runtime, kind);
    for (const variant of variants) {
      const variantStarted = Date.now();
      process.stderr.write(JSON.stringify({ runtime, variant, stage: 'start' }) + '\n');
      await h.publicIntegrationFixture(async f => {
        h.write(f.worktree, 'other/unrelated.cjs', 'exports.unrelated = true;\n');
        require('node:child_process').execFileSync('git', ['-C', f.worktree, 'add', '--', 'other/unrelated.cjs']);
        h.commit(f, 'fixture: separate unrelated component');
        let prepared;
        const controls = { onLaunch(launch) {
          scoped(launch.payload, snapshots.get(launch.payload.snapshot_sha256), validation.exports);
        }, result(result, payload) {
          finding(result);
          if (variant === 'unread-support' && payload.stage === 'worker') {
            result.unread = [payload.assignment.support_obligation_ids[0]];
            result.required_context = ['Required support remains unread.'];
          }
          if (variant === 'blocker' && payload.stage === 'worker') {
            result.completeness = 'blocked'; result.outcome = 'needs-fix'; result.blocking_count = 1;
            result.findings.push({ id: 'Z16-B1', type: 'violation', blocking: true,
              summary: 'Retained actual blocker.', evidence: 'src/provider.cjs:1', ticket: null });
          }
          if (variant === 'unresolved-seam' && payload.stage === 'final') {
            result.seams[0].disposition = 'unresolved'; result.required_context = ['Cross-worker seam unresolved.'];
          }
        } };
        if (runtime === 'codex') {
          preamble.installInstructions(f);
          const generated = smoke.generateFixture(path.join(f.root, 'combined-instructions'), plugin);
          const selection = api('model-policy').resolveDispatch({ runtime, role: 'integrator', signals: { risk: 'high', checkpoint: true } });
          const manifest = structuredClone(generated.manifest);
          manifest.agent_files = [selection.agent_file, ...manifest.agent_files.filter(file => file !== selection.agent_file)];
          fs.writeFileSync(path.join(generated.out, 'manifest.json'), JSON.stringify(manifest) + '\n');
          require(path.join(ROOT, 'scripts/gen-codex-shipyard.cjs')).validateCodexBundle(generated.out, generated.options);
          f.agents.integrator = { dir: path.join(generated.out, 'agents'), manifest: path.join(generated.out, 'manifest.json'),
            selection, capabilities: generated.options.capabilities,
            text: fs.readFileSync(path.join(generated.out, 'agents', selection.agent_file), 'utf8') };
          controls.native = (rows, payload) => {
            for (const row of rows) if (row.type === 'turn_context') {
              delete row.payload.workspace_roots;
              row.payload.sandbox_policy.type = /^sandbox_mode = "(.+)"$/m.exec(f.agents.integrator.text)[1];
            }
            const initial = template(captured, row => row.payload?.role === 'user');
            const launch = prepared.launches.find(item => item.payload === payload);
            assert.ok(launch, 'initialization belongs to the exact physical launch');
            const content = preamble.initialization(f.worktree, undefined, launch.runtime_args);
            if (/^sandbox_mode = "workspace-write"$/m.test(f.agents.integrator.text)) {
              const writes = '<entry access="write"><special>:slash_tmp</special></entry>'
                + '<entry access="write"><special>:tmpdir</special></entry>'
                + '<entry access="write"><path>' + f.worktree.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
                  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') + '</path></entry>';
              content.payload.content[1].text = content.payload.content[1].text.replace(
                '<entry access="read"><special>:root</special></entry>',
                '<entry access="read"><special>:root</special></entry>' + writes);
            }
            initial.payload.content = content.payload.content;
            initial.payload.internal_chat_message_metadata_passthrough = content.payload.internal_chat_message_metadata_passthrough;
            if (variant === 'initialization') initial.payload.content[0].text += '\nSubstituted instruction.';
            rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0, initial);
            const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
            const record = (command, result) => {
              const call = template(captured, row => row.payload?.type === 'function_call');
              const response = template(captured, row => row.payload?.type === 'function_call_output');
              const callId = 'combined-' + rows.length;
              Object.assign(call.payload, { name: 'exec_command', call_id: callId,
                arguments: JSON.stringify({ cmd: command }), internal_chat_message_metadata_passthrough: { turn_id: turn } });
              delete call.payload.input;
              Object.assign(response.payload, { call_id: callId, output: JSON.stringify(result),
                internal_chat_message_metadata_passthrough: { turn_id: turn } });
              rows.splice(rows.findIndex(row => row.payload?.phase === 'final_answer'), 0, call, response);
            };
            for (const source of payload.material) {
              const bytes = fs.readFileSync(path.resolve(f.worktree, source.read_path));
              assert.equal(hash(bytes), source.sha256);
              record('cat ' + JSON.stringify(source.read_path), { exit_code: 0, output: bytes.toString() });
            }
            const query = spawnSync('rg', ['-n', 'SHIPYARD_Z16_ABSENT_SYMBOL', 'src/provider.cjs'],
              { cwd: f.worktree, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()) });
            assert.equal(query.status, 1, query.stderr); assert.equal(query.stdout, ''); assert.equal(query.stderr, '');
            record('rg -n SHIPYARD_Z16_ABSENT_SYMBOL src/provider.cjs', { exit_code: query.status, output: query.stdout });
            if (variant === 'missing-material' && payload.stage === 'final')
              record('cat src/missing-required.cjs', { exit_code: 1, output: 'cat: src/missing-required.cjs: No such file or directory\n' });
          };
          prepared = h.semanticFixture(f, controls);
        } else {
          controls.native = (rows, payload) => {
            const tool = rows.find(row => row.message?.content?.[0]?.type === 'tool_use');
            const response = rows.find(row => row.message?.content?.[0]?.type === 'tool_result');
            assert.ok(tool && response);
            for (const [index, source] of payload.material.entries()) {
              const read = structuredClone(tool), output = structuredClone(response);
              const bytes = fs.readFileSync(path.resolve(f.worktree, source.read_path));
              assert.equal(hash(bytes), source.sha256);
              const id = 'combined-material-' + index;
              read.message.content[0].id = id;
              read.message.content[0].input.file_path = source.read_path;
              output.message.content[0].tool_use_id = id;
              output.message.content[0].content = bytes.toString();
              rows.splice(rows.length - 1, 0, read, output);
            }
          };
          controls.clock = session => {
            let elapsed = 0, wakes = 0;
            return { now: () => elapsed, sleep: async ms => {
              assert.ok(elapsed < 5000); assert.ok(ms > 0 && ms <= 5000 - elapsed);
              wakes++;
              elapsed = 5000;
              if (variant === 'changed-terminal') {
                const launch = prepared.launches.find(item => item.session === session);
                assert.ok(launch?.nativePath); fs.appendFileSync(launch.nativePath, '\n');
              }
              assert.equal(wakes, 1);
            } };
          };
          prepared = claude.nativeFixture(f, 'integrator', controls);
        }
        const command = fs.readFileSync(path.join(plugin, 'commands/deliver.md'), 'utf8');
        const section = command.slice(command.indexOf('**Fresh final integration contract.**'));
        const snippet = section.match(/```javascript\n([\s\S]*?)\n\s*```/)[1];
        const invoke = new (Object.getPrototypeOf(async function() {}).constructor)(
          'require', 'CLAUDE_PLUGIN_ROOT', 'options', 'worktree', 'phase', 'run_id', 'runtime', snippet + '\nreturn result;');
        const run = () => invoke(require, plugin, prepared.options, f.worktree, 49, 'combined-' + ++f.count, runtime);
        {
          if (variant !== 'complete') {
            await assert.rejects(run(), error => {
              const allowed = variant === 'changed-terminal' || variant === 'initialization'
                ? ['RUNTIME_EVIDENCE_MISSING', 'RUNTIME_EVIDENCE_INVALID', 'RUNTIME_EVIDENCE_MISMATCH', 'SEMANTIC_REVIEW_INCOMPATIBLE']
                : ['SEMANTIC_REVIEW_INCOMPLETE', 'SEMANTIC_REVIEW_INCOMPATIBLE'];
              assert.ok(allowed.includes(error.code), variant + ': unexpected refusal ' + error.stack);
              return true;
            });
            assert.equal(cold(f, plugin, deadline).authenticated, false);
            if (['missing-material', 'unread-support', 'blocker', 'unresolved-seam'].includes(variant)) {
              for (const launch of prepared.launches.filter(item => item.payload.stage === 'worker')) {
                const original = api('role-artifact').readSemanticOriginal({ worktreePath: f.worktree,
                  snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
                assert.ok(original.result.findings.some(item => item.id === 'Z16-INFO'));
                assert.equal(original.original_text, launch.text || launch.originalText);
                if (variant === 'unread-support') assert.ok(original.result.unread.length);
                if (variant === 'blocker') assert.equal(original.result.blocking_count, 1);
              }
            }
          } else {
            const result = await run();
            assert.equal(result.result.outcome, 'passed');
            assert.equal(prepared.launches.length, 3);
            assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
            assert.deepEqual(prepared.completed, ['consumer-acceptance', 'producer-contract', 'final']);
            const final = prepared.launches[2].payload;
            const primaries = prepared.launches.slice(0, 2).flatMap(item => item.payload.assignment.primary_obligation_ids);
            assert.equal(new Set(primaries).size, primaries.length);
            assert.deepEqual([...primaries].sort(), [...final.obligation_ids].sort());
            assert.equal(final.originals.length, 2);
            for (const original of final.originals) {
              assert.ok(original.result.findings.some(item => item.id === 'Z16-INFO'));
              assert.deepEqual(api('role-artifact').readSemanticOriginal({ worktreePath: f.worktree,
                snapshot_sha256: final.snapshot_sha256, assignment_id: original.reference.assignment_id }), original);
              if (runtime === 'codex') {
                assert.equal(original.native.reads.negative_queries.length, 1);
                assert.deepEqual(original.native.reads.incomplete, []);
                assert.equal(original.native.reads.semantic_credit, false);
                const launch = prepared.launches.find(item => item.payload.assignment?.id === original.reference.assignment_id);
                const pin = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id).receipt.runtime_evidence.initial_context;
                assert.equal(pin.launch.binding.input_sha256, hash(launch.input));
                assert.equal(pin.native_sha256, original.native.native_pin.sha256);
                assert.equal(pin.launch.sources.length, 2);
              } else assert.equal(original.native.accounting.status, 'unknown');
            }
            assert.equal(cold(f, plugin, deadline).authenticated, true);
            const restarted = await run();
            assert.deepEqual(restarted.receipt, result.receipt); assert.equal(prepared.launches.length, 3);
            const files = [path.join(f.worktree, 'src/provider.cjs'), path.join(f.worktree, f.rows['T-49-01'].plan),
              ...final.originals.flatMap(item => [item.native.native_pin.path, item.native.output_pin.path])];
            if (runtime === 'codex') files.push(path.join(prepared.options.agentDir,
              JSON.parse(fs.readFileSync(prepared.options.agentManifest)).agent_files[0]));
            for (const file of files) {
              const bytes = fs.readFileSync(file);
              try { fs.appendFileSync(file, '\n'); assert.equal(cold(f, plugin, deadline).authenticated, false, file); }
              finally { fs.writeFileSync(file, bytes); }
            }
            assert.equal(cold(f, plugin, deadline).authenticated, true);
            const base = f.pr.baseRefOid;
            try { f.pr.baseRefOid = f.head; assert.equal(cold(f, plugin, deadline).authenticated, false); }
            finally { f.pr.baseRefOid = base; }
          }
          completed.push(variant);
          process.stderr.write(JSON.stringify({ runtime, variant, stage: 'complete', elapsed_ms: Date.now() - variantStarted }) + '\n');
        }
      });
    }
    for (const name of [runtime === 'codex' ? 'codex-delivery-host' : 'claude-role-host', runtime + '-runtime-host', 'role-artifact'])
      assert.ok(require.cache[path.join(plugin, 'scripts', name + '.cjs')], 'selected payload module: ' + name);
    return completed;
  } finally { restore(); }
}

async function ciSeam(plugin) {
  const smoke = setup('smoke/phase53-review-acceptance.cjs', 'async function observeRetirement', 'routePayload');
  const restore = smoke.routePayload(plugin), cleanup = [];
  try {
    const h = setup('unit/phase53-z11-ci-check-identity.test.cjs', "test('independent Apps", 'fixture, pendingBoard, run, publish, wait, ci, HEAD', plugin);
    const checks = require(path.join(plugin, 'scripts/check-state.cjs'));
    for (const independent of [true, false]) {
      const f = h.fixture({ after(fn) { cleanup.push(fn); } });
      const raw = [h.run('build', 'failure', independent ? { app: { id: 400, slug: 'external-a' }, html_url: '' } : {}),
        h.run('build', 'success', { id: 2, started_at: '2026-10-02T00:00:00Z',
          ...(independent ? { app: { id: 401, slug: 'external-b' }, html_url: '' } : {}) })];
      const data = { checkPages: [{ total_count: 2, check_runs: raw }] };
      h.pendingBoard(f); f.update(data);
      const observation = h.ci(h.publish(f));
      assert.equal(observation.complete, true);
      assert.equal(checks.classify(observation.rows).failing, independent ? 1 : 0);
      assert.equal(observation.rows.length, independent ? 2 : 1);
      h.pendingBoard(f); f.update(data);
      const consumed = h.wait(f).watched[0].checks;
      assert.equal(consumed.failing, independent ? 1 : 0);
      assert.equal(consumed.rows.length, independent ? 2 : 1);
      assert.equal(checks.compatibleCiObservation(observation, { head: h.HEAD }), true);
    }
  } finally { for (const fn of cleanup.reverse()) fn(); restore(); }
}

function bounded(args, env) {
  const deadline = Number(args.at(-1));
  assert.ok(Number.isFinite(deadline) && deadline > Date.now());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] }; let size = 0, failure;
    const stop = message => { failure ||= new Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('combined child exceeded 180000ms'), Math.max(1, deadline - Date.now()));
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', bytes => {
      size += bytes.length;
      if (size > OUTPUT) stop('combined child exceeded 8MiB'); else chunks[channel].push(bytes);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => {
      clearTimeout(timer);
      if (failure) {
        failure.message += '\n' + Buffer.concat(chunks.stderr).toString();
        return reject(failure);
      }
      const stdout = Buffer.concat(chunks.stdout).toString(), stderr = Buffer.concat(chunks.stderr).toString();
      if (status !== 0) return reject(new Error(stderr + stdout));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}


function expectedVariants(runtime, kind) {
  assert.ok(['positive', 'negative'].includes(kind));
  return kind === 'positive' ? ['complete'] : runtime === 'codex'
    ? ['missing-material', 'unread-support', 'blocker', 'unresolved-seam', 'initialization']
    : ['changed-terminal', 'unread-support'];
}

// @contract: Imports register no tests; suites explicitly invoke this entrypoint.
async function runShard(t, kind) {
    expectedVariants('codex', kind);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z16-combined-')));
    try {
      const candidate = require(path.join(ROOT, 'scripts/package-shipyard-codex.cjs')).build(path.join(directory, 'candidate'));
      if (kind === 'positive') parity(candidate);
      const denominator = kind === 'positive' ? shards() : undefined;
      const { fixtureEnvironment } = require('../../smoke/phase53-review-acceptance.cjs');
      const jobs = [SOURCE, path.join(candidate, 'host/plugins/delivery-pipeline')]
        .flatMap((plugin, index) => ['codex', 'claude'].map(runtime => ({ plugin, runtime,
          identity: index === 0 ? 'source-fixture' : 'staged-package-fixture' })));
      let next = 0;
      const results = await Promise.allSettled(Array.from({ length: 2 }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          const observed = await bounded([__filename, '--combined', job.plugin, job.runtime, job.identity, kind, String(Date.now() + LIMIT)],
            fixtureEnvironment(path.join(directory, job.identity + '-' + job.runtime)));
          assert.equal(observed.runtime, job.runtime); assert.equal(observed.identity, job.identity);
          assert.equal(observed.payload_root, job.plugin);
          assert.deepEqual(observed.completed, [...expectedVariants(job.runtime, kind),
            ...(kind === 'positive' && job.runtime === 'codex' ? ['ci-independent-app', 'ci-proven-rerun'] : [])]);
          assert.equal(observed.installed_native_acceptance, false);
          assert.equal(observed.production_resource_fit, 'unknown'); assert.equal(observed.R8, 'INCOMPLETE');
          t.diagnostic(JSON.stringify(observed));
        }
      }));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.stack).join('\n'));
      if (kind === 'positive') parity(candidate);
      if (kind === 'positive') t.diagnostic(JSON.stringify({ actual_selector_denominator: denominator,
        normal_ci_obligation: 'node --test tests/unit/phase53-shipping.test.cjs', ordinary_role_checks: 12,
        historical_failed_evidence: 'preserved; fixture results confer no native acceptance' }));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { runShard };

if (require.main === module && process.argv[2] === '--cold') {
  const [, , , plugin, raw, pr, fixtureHome] = process.argv;
  // @contract: The cold reader uses the same fixture authority home before importing consumers.
  assert.ok(path.isAbsolute(fixtureHome));
  os.homedir = () => fixtureHome;
  const input = JSON.parse(raw), current = require(path.join(plugin, 'scripts/role-artifact.cjs')).currentIntegrationVerdict(input);
  const gate = require(path.join(plugin, 'scripts/gate-trailer.cjs')).verifyCurrentReviews({ ...input, getPullRequest: () => JSON.parse(pr) });
  assert.deepEqual(gate.integration, current);
  process.stdout.write(JSON.stringify({ authenticated: current?.authenticated === true }));
} else if (require.main === module && process.argv[2] === '--combined') {
  const [, , , plugin, runtime, identity, kind, rawDeadline] = process.argv, started = Date.now();
  assert.ok(path.isAbsolute(plugin));
  assert.ok(Number.isFinite(Number(rawDeadline)));
  combined(plugin, runtime, Number(rawDeadline), kind).then(async completed => {
    if (kind === 'positive' && runtime === 'codex') { await ciSeam(plugin); completed.push('ci-independent-app', 'ci-proven-rerun'); }
    process.stdout.write(JSON.stringify({ runtime, identity, payload_root: plugin, completed, elapsed_ms: Date.now() - started,
      installed_native_acceptance: false, production_resource_fit: 'unknown', R8: 'INCOMPLETE', semantic_credit: 0,
      native_reviews_owed: ['code-review', 'integration', 'architecture'] }));
  }).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
