'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test, describe, after } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const SELF = 'tests/unit/phase53-z35-code-review-material-accounting.test.cjs';
const OWNERS = ['plugins/delivery-pipeline/scripts/codex-code-review-context.cjs',
  'plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-code-review-context.cjs',
  'plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/.codex-plugin/plugin.json', 'plugins/shipyard/package-build.json', SELF,
  'tests/unit/phase53-z30-semantic-material-retention.test.cjs'];
const PHASES = ['package setup', 'fixture setup', 'producer', 'current consumer', 'original reader',
  'cold producer current', 'cold producer originals', 'cold shipped current', 'cold shipped originals',
  'staged package', 'cold staged current', 'cold staged originals', 'unchanged recovery', 'purpose assertions',
  'immutable custody refusals', 'governing drift refusals'];
const git = (root, ...args) => cp.execFileSync('git', ['-C', root, ...args],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 }).trim();
function api(plugin = path.dirname(h.SCRIPTS)) {
  const file = path.join(plugin, 'scripts/role-artifact.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { ...module.exports, partitionInventory, assertSemanticSnapshot, semanticResponsibilities, semanticRecord, semanticInputFiles, semanticBuildLaunch, semanticEnvelope, writePartitionEnvelope, semanticPreflight, semanticWireBound };', file);
  return loaded.exports;
}
function definitions() {
  return h.setup('phase53-z30-semantic-material-retention.test.cjs', '\nfunction runShard(',
    'canonicalPublic30, configure30, profiles, evidence, cases, completePackage, setPhase(run) { phase30 = run; }');
}
function configure(f, followup, defs) {
  defs.configure30(f, false, false);
  const write = (relative, content) => {
    const file = path.join(f.worktree, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  };
  const setup = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'commit');
  const aliases = ['src/generated-t35-source.txt', ...[1, 2, 3].map(n => 'src/generated-t35-alias-' + n + '.txt')];
  const content = 'A' + 'lossless-body;'.repeat(353847) + '\n';
  for (const file of aliases) write(file, content);
  setup.commit(f, 'fixture complete old generated sources');
  f.base = f.head; f.pr.baseRefOid = f.base;
  git(f.worktree, 'update-ref', 'refs/heads/main', f.base);
  git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  f.t35Change = () => {
    write(aliases[0], 'B' + content.slice(1));
    setup.commit(f, 'fixture exact oversized diff at ordinary code-review boundary');
    f.memberHead = f.head;
  };
  f.rows['T-49-01'].files.push(...aliases);
  if (followup) {
    const id = 'T-49-35', row = { ...f.rows['T-49-30'], title: 'Complete aggregate material accounting',
      files: OWNERS, depends_on: ['T-49-30'], wave: 31, branch: 'ticket/' + id,
      plan: '.planning/phases/' + f.phase + '/49-35-PLAN.md' };
    f.rows[id] = row; f.state[id] = { status: 'merged', pr: 135, branch: row.branch };
    for (const file of OWNERS) write(file, fs.readFileSync(path.join(h.ROOT, file)));
    write(row.plan, '---\nfiles_modified: ' + JSON.stringify(OWNERS) + '\n---\n'
      + '## Acceptance criteria\n- Retain complete aggregate source aliases, exact blob identities and all governing obligations.\n'
      + 'R8 INCOMPLETE; zero semantic credit; final epic native code-review, integration and architecture remain owed.\n');
  }
  write('.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows,
    epics: { '049': { branch: f.pr.headRefName, phaseDir: f.phase, repos: [null] } } }));
  write('.planning/graph/delivery-state.json', JSON.stringify(f.state));
  if (followup) git(f.worktree, 'add', '--', ...OWNERS);
  setup.commit(f, 'fixture complete aggregate material and declared aliases');
  f.memberHead = f.head;
  const binding = h.setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'phaseBinding').phaseBinding(f);
  const inventoryPath = path.join(f.root, 't35-roster.json'); fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
  require(path.join(h.SCRIPTS, 'role-artifact.cjs')).registerPhaseArchiveRoster({ worktreePath: f.worktree,
    graphDir: f.graphDir, binding, inventoryPath, expectedInventoryDigest: h.hash(fs.readFileSync(inventoryPath)) });
}
async function lifecycle(runtime, followup, phase) {
  const defs = definitions(); let fixture, launchCount = 0;
  const load = Module._load, facades = new Map();
  Module._load = function(request, parent, ...args) {
    const exported = load.call(this, request, parent, ...args);
    const filename = Module._resolveFilename(request, parent);
    if (runtime !== 'claude' || typeof filename !== 'string' || !filename.startsWith(path.join(process.env.HOME, 'producer-'))
        || !filename.endsWith('/scripts/context-packet.cjs')) return exported;
    if (!facades.has(filename)) facades.set(filename, { ...exported, encodeUniqueContent(packet, ...parameters) {
      const encoded = exported.encodeUniqueContent(packet, ...parameters);
      if (packet.role === 'code-review' && !packet.product_source_format && packet.role_context?.exact_diff) {
        fs.writeFileSync(path.join(workerData.evidenceRoot, 'claude-packet.json'), JSON.stringify(packet));
        fs.writeFileSync(path.join(workerData.evidenceRoot, 'claude-encoded.json'), JSON.stringify(encoded));
      }
      return encoded;
    } });
    return facades.get(filename);
  };
  defs.setPhase((name, run) => phase(name, async () => {
    if (name === 'producer') {
      fixture.t35Change();
      const collector = require(path.join(h.SCRIPTS, 'codex-code-review-context.cjs'));
      const binding = h.setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'phaseBinding').phaseBinding(fixture);
      const scope = { worktree: fixture.worktree, ticket: binding.subject, phase: 49 };
      const options = { graphDir: fixture.graphDir, defaultBranch: 'main', refreshGit: false,
        getPullRequest: () => fixture.pr, inflightDispatchId: 'canonicalfixture29-' + runtime + '-review' };
      assert.throws(() => collector.prepare(scope, { role: 'code-review' }, options),
        error => error.code === 'CONTEXT_PACKET_OVER_BOUND');
      const context = collector.prepareSemantic(scope, { role: 'code-review' }, options);
      const { digest, ...packet } = context.prepared.packet;
      const raw = Buffer.byteLength(JSON.stringify(packet));
      const encoded = Buffer.byteLength(JSON.stringify(require(path.join(h.SCRIPTS, 'context-packet.cjs')).encodeUniqueContent(packet)));
      const diff = Buffer.byteLength(packet.role_context.exact_diff.content);
      assert.ok(raw <= 16777216 && encoded <= 16777216 && encoded + diff > 16777216);
      parentPort.postMessage({ measurements: { collector: { raw, encoded, diff, legacy_physical: encoded + diff } } });
    }
    return run();
  }));
  try { await defs.canonicalPublic30(runtime, {
    phasedInspect: true,
    configureFixture(f) { fixture = f; configure(f, followup, defs); },
    result(result) { for (const seam of result.seams) seam.rationale = 'Checked complete producer and consumer.'; },
    onLaunch(launch, launches) {
      launchCount++;
      if (launch.payload.stage === 'worker' && launches.length === 2)
        assert.equal(launches[0].text || launches[0].originalText, undefined);
      if (launch.payload.stage === 'final') assert.ok(launches.slice(0, 2).every(row => row.text || row.originalText));
    },
    async inspect(context) {
      await phase('purpose assertions', () => {
      const { snapshot, record } = defs.evidence(context);
      assert.equal(snapshot.identity.ticket_set.length, followup ? 35 : 34);
      const packet = snapshot.code_review_packet;
      assert.equal(packet.product_source_format, 'unique-content-references.v1');
      const contents = new Map(packet.product_source_contents.map(row => [row.sha256, row.content]));
      const expanded = { ...packet, product_sources: packet.product_sources.map(({ content_ref, blob_oid, ...row }) =>
        ({ ...row, content: contents.get(content_ref) })) };
      delete expanded.product_source_format; delete expanded.product_source_contents;
      assert.ok(Buffer.byteLength(JSON.stringify(expanded)) > 33554432, 'complete old inline inventory exceeds raw bound');
      for (const [index, row] of packet.product_sources.entries()) {
        const content = cp.execFileSync('git', ['-C', context.f.worktree, 'show', row.revision + ':' + row.path],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
        assert.equal(contents.get(row.content_ref), content);
        assert.equal(row.blob_oid, git(context.f.worktree, 'rev-parse', row.revision + ':' + row.path));
        const material = snapshot.material.find(item => item.sha256 === row.sha256);
        assert.ok(material.aliases.some(alias => alias.pointer === '/product_sources/' + index + '/content'
          && alias.path === row.path && alias.revision === row.revision && alias.blob_oid === row.blob_oid));
        assert.ok(snapshot.obligations.some(item => item.pointer === '/product_sources/' + index + '/content' && item.mandatory));
      }
      const packets = require(path.join(h.SCRIPTS, 'context-packet.cjs'));
      const encoded = packets.encodeUniqueContent(packet, 33554432);
      const decoded = packets.decodeUniqueContent(encoded, 33554432);
      assert.deepEqual(decoded.product_sources, packet.product_sources);
      assert.deepEqual(decoded.product_source_contents, packet.product_source_contents);
      assert.deepEqual(packets.encodeUniqueContent(decoded, 33554432), encoded);
      for (const ref of packet.required_refs) assert.ok(decoded.required_refs.some(row => h.stable(row) === h.stable(ref)));
      const inputs = api(context.plugin).semanticInputFiles(record);
      const measurements = { runtime, members: snapshot.identity.ticket_set.length,
        raw: Buffer.byteLength(JSON.stringify(packet)), encoded: Buffer.byteLength(JSON.stringify(encoded)),
        unique: snapshot.material.reduce((n, row) => n + row.bytes, 0), logical: packet.product_sources.reduce((n, row) => n + row.bytes, 0),
        source_records: packet.product_sources.length, unique_sources: contents.size, catalog: inputs.catalog.bytes,
        material: inputs.material.map(row => ({ sha256: row.sha256, bytes: row.bytes })),
        worker: defs.evidence(context).launches.slice(0, 2).map(row => Buffer.byteLength(row.input)),
        final: Buffer.byteLength(defs.evidence(context).launches[2].input) };
      assert.equal(context.prepared.launches.length, 3); assert.equal(context.originals.length, 2);
      assert.ok(context.originals.every(row => row.result.findings.some(item => item.severity === 'INFO')));
      assert.equal(context.current.authenticated, true);
      parentPort.postMessage({ measurements });
      });
      for (const boundary of ['immutable custody refusals', 'governing drift refusals']) await phase(boundary, () => {
        const { snapshot, record } = defs.evidence(context), inputs = api(context.plugin).semanticInputFiles(record);
        const before = context.prepared.launches.length;
        const worker = () => context.api.prepareSemanticWorker({ prepared: snapshot, assignment_id: snapshot.assignments[0].id });
        const paths = boundary === 'immutable custody refusals' ? [inputs.material[0].read_path, inputs.catalog.read_path]
          : [path.join(context.f.worktree, 'src/provider.cjs'), ...[
            snapshot.pins.find(pin => pin.path.endsWith('-PLAN.md')),
            snapshot.pins.find(pin => pin.sha256 === snapshot.agent_sha256),
            snapshot.pins.find(pin => pin.path === 'code-review.md'),
          ].map(pin => path.join(pin.root, pin.path))];
        for (const file of paths) {
          const original = fs.readFileSync(file);
          try {
            fs.appendFileSync(file, '\nT35 stale exact material\n');
            assert.throws(worker);
            assert.equal(context.api.currentCodeReviewVerdict(h.inputFor(context.f)), null);
            assert.equal(h.cold(context.f, 'code-review', context.staged), null);
          } finally { fs.writeFileSync(file, original); assert.equal(h.hash(fs.readFileSync(file)), h.hash(original)); }
        }
        if (boundary === 'governing drift refusals') for (const ref of ['HEAD', snapshot.identity.base_ref]) {
          const original = git(context.f.worktree, 'rev-parse', ref);
          const replacement = ref === 'HEAD' ? snapshot.identity.base : snapshot.identity.head;
          try {
            git(context.f.worktree, 'update-ref', ref, replacement);
            assert.throws(worker);
            assert.equal(context.api.currentCodeReviewVerdict(h.inputFor(context.f)), null);
            assert.equal(h.cold(context.f, 'code-review', context.staged), null);
          } finally { git(context.f.worktree, 'update-ref', ref, original); }
        }
        assert.equal(context.prepared.launches.length, before);
        worker();
        assert.deepEqual(context.api.currentCodeReviewVerdict(h.inputFor(context.f)), context.current);
        assert.deepEqual(h.cold(context.f, 'code-review', context.staged), context.current);
      });
    },
  }); } catch (error) { error.t35_native_launches = launchCount; throw error; } finally { Module._load = load; }
}
function environment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  return { ...env, HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: home, TMP: home, TEMP: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_GLOBAL: os.devNull, GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'maintenance.autoDetach', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'gc.autoDetach', GIT_CONFIG_VALUE_1: 'false' };
}
if (!isMainThread) {
  os.homedir = () => fs.realpathSync(process.env.HOME);
  let ordinal = 0;
  lifecycle(workerData.runtime, workerData.followup, async (name, run) => {
    assert.equal(name, PHASES[ordinal++]);
    parentPort.postMessage({ ready: name });
    const command = await new Promise(resolve => parentPort.once('message', resolve)); assert.equal(command, name);
    await run(); parentPort.postMessage({ completed: name });
  }).then(() => { assert.equal(ordinal, PHASES.length); parentPort.postMessage({ finished: true }); parentPort.close(); })
    .catch(error => {
      fs.writeFileSync(path.join(workerData.evidenceRoot, 'refusal.json'), JSON.stringify({ code: error.code,
        message: error.message, refusal: error.refusal, details: error.details, native_launches: error.t35_native_launches, stack: error.stack }, null, 2));
      parentPort.postMessage({ evidence: workerData.evidenceRoot });
      setImmediate(() => { throw error; });
    });
} else {
  for (const [runtime, followup] of [['codex', false], ['codex', true], ['claude', false], ['claude', true]]) {
    const group = runtime === 'codex' && !followup ? 'T35-tracer' : 'T35-expansion';
    describe(group + ' ' + runtime + ' complete ' + (followup ? 'followup35' : 'current34'), { concurrency: false }, () => {
      let home, evidenceRoot, worker, failure, finished = false, waiting;
      const messages = new Map();
      function receive(key) {
        if (failure) return Promise.reject(failure);
        if (messages.has(key)) { const value = messages.get(key); messages.delete(key); return Promise.resolve(value); }
        return new Promise((resolve, reject) => { waiting = { key, resolve, reject }; });
      }
      function signal(key, value) {
        if (waiting?.key === key) { const held = waiting; waiting = null; held.resolve(value); }
        else messages.set(key, value);
      }
      after(async () => { await worker?.terminate(); if (home) fs.rmSync(home, { recursive: true, force: true }); });
      test(group + ' physical setup', { timeout: 180000 }, async () => {
        home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-t35-')));
        const env = environment(home), fixture = h.setup('phase53-z24-historical-producer-reference.test.cjs',
          '\nif (isMainThread) {', 'squashCandidate');
        const candidate = fixture.squashCandidate(home, env);
        evidenceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't35-evidence-')));
        worker = new Worker(path.join(candidate, SELF), { env, workerData: { runtime, followup, index: -1, evidenceRoot } });
        worker.on('message', message => {
          if (message.ready) signal('ready:' + message.ready, message.ready);
          if (message.completed) signal('completed:' + message.completed, message.completed);
          if (message.finished) finished = true;
          if (message.evidence) process.stdout.write('T35 retained refusal ' + message.evidence + '\n');
          if (message.measurements) { fs.appendFileSync(path.join(evidenceRoot, 'measurements.jsonl'), JSON.stringify(message.measurements) + '\n'); process.stdout.write('T35 measurements ' + JSON.stringify(message.measurements) + '\n'); }
        });
        const fail = error => { failure ||= error; if (waiting) { waiting.reject(failure); waiting = null; } };
        worker.once('error', fail);
        worker.once('exit', code => { if (code || !finished) fail(Error('incomplete fixture worker exit ' + code)); signal('exit', code); });
        await receive('ready:' + PHASES[0]);
      });
      for (const [index, name] of PHASES.entries()) test(group + ' ' + name, { timeout: 180000 }, async t => {
        if (failure) throw Error('prerequisite failed: ' + failure.message, { cause: failure });
        const stop = () => { failure = Error('phase timed out: ' + name); worker.terminate(); };
        t.signal.addEventListener('abort', stop, { once: true });
        try {
          if (index) await receive('ready:' + name);
          worker.postMessage(name); await receive('completed:' + name);
          if (index === PHASES.length - 1) { assert.equal(await receive('exit'), 0); assert.equal(finished, true); }
        } finally { t.signal.removeEventListener('abort', stop); }
      });
    });
  }
}

function compact(content = 'exports.value = 35;\n') {
  const sha256 = h.hash(content), bytes = Buffer.byteLength(content);
  const row = { path: 'src/provider.cjs', revision: 'a'.repeat(40),
    blob_oid: require('node:crypto').createHash('sha1').update('blob ' + bytes + '\0').update(content).digest('hex'),
    bytes, sha256, content_ref: sha256 };
  return { role: 'code-review', subject: 'phase=53;pr=35', source_revision: row.revision,
    product_source_format: 'unique-content-references.v1', product_sources: [row, { ...row, path: 'src/mirror.cjs' }],
    product_source_contents: [{ sha256, bytes, content }], governing: { acceptance: ['Read every logical alias.'] } };
}
function snapshotFor(packet, consumer) {
  const inventory = consumer.partitionInventory(packet);
  const tickets = [{ id: 'T-53-01', row: { files: ['src/provider.cjs'], depends_on: [] } },
    { id: 'T-53-35', row: { files: ['src/mirror.cjs'], depends_on: ['T-53-01'] } }];
  const snapshot = { schema: 'shipyard.semantic-review-snapshot.v1', review_contract: 'shipyard.semantic-review.v1',
    role: 'code-review', stage: 'snapshot', runtime: 'codex', subject: packet.subject,
    identity: { head: packet.source_revision, merge_base: 'b'.repeat(40) }, code_review_packet: packet,
    original_packet_sha256: h.hash(h.stable(packet)), ...inventory,
    ...consumer.semanticResponsibilities(inventory, tickets, 'code-review') };
  snapshot.snapshot_sha256 = h.hash(h.stable(snapshot)); return snapshot;
}
function reseal(snapshot) {
  delete snapshot.snapshot_sha256; snapshot.snapshot_sha256 = h.hash(h.stable(snapshot)); return snapshot;
}
function proveSelections(selected, actual) { assert.deepEqual(selected, actual.shards); }
function proveRoster(actual, expected, files, directory) {
  const s = require('./shard-files.cjs');
  assert.deepEqual(actual.shards, expected);
  const tasks = s.unitTasks(files);
  assert.deepEqual([...actual.shards.flat()].sort(), tasks);
  assert.equal(new Set(actual.shards.flat()).size, tasks.length);
  const rows = ['shards', ...actual.shards.map((_, i) => 'unit (shard ' + (i + 1) + '/' + actual.shards.length + ')'),
    'gates and smoke', 'test-fast'];
  assert.equal(new Set(rows).size, actual.shards.length + 3);
  const selected = actual.shards.map((_, i) => s.selectTaskShard((i + 1) + '/' + actual.shards.length, directory));
  proveSelections(selected, actual);
  return rows;
}
if (isMainThread) {
  const canonical = path.dirname(h.SCRIPTS), shipped = path.join(h.ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline');
  for (const [name, plugin] of [['canonical', canonical], ['generated', shipped]]) {
    for (const [label, mutate] of [
      ['unknown format', p => { p.product_source_format = 'unknown.v2'; }],
      ['missing discriminator', p => { delete p.product_source_format; }],
      ['missing table', p => { delete p.product_source_contents; }],
      ['missing body', p => { p.product_source_contents.length = 0; }],
      ['duplicate body', p => { p.product_source_contents.push(h.clone(p.product_source_contents[0])); }],
      ['extra body', p => { const q = compact('unreferenced'); p.product_source_contents.push(q.product_source_contents[0]); p.product_source_contents.sort((a, b) => a.sha256.localeCompare(b.sha256)); }],
      ['corrupt body', p => { p.product_source_contents[0].content += 'x'; }],
      ['undersized body', p => { p.product_source_contents[0].bytes--; }],
      ['oversized declared body', p => { p.product_source_contents[0].bytes = Number.MAX_SAFE_INTEGER + 1; }],
      ['table metadata', p => { p.product_source_contents[0].provenance = []; }],
      ['dangling reference', p => { p.product_sources[0].content_ref = 'f'.repeat(64); }],
      ['cyclic reference', p => { p.product_sources[0].content_ref = { content_ref: p.product_sources[0].sha256 }; }],
      ['mixed inline', p => { p.product_sources[0].content = 'exports.value = 35;\n'; }],
      ['duplicate logical identity', p => { p.product_sources.push(h.clone(p.product_sources[0])); }],
      ['conflicting blob', p => { p.product_sources[0].blob_oid = 'f'.repeat(40); }],
      ['conflicting bytes', p => { p.product_sources[0].bytes++; }],
      ['unsafe bytes', p => { p.product_sources[0].bytes = Number.MAX_SAFE_INTEGER + 1; }],
      ['unsafe path', p => { p.product_sources[0].path = '../provider.cjs'; }],
      ['development alias', p => { p.product_sources[0].path = '.planning/source.cjs'; }],
      ['unknown source metadata', p => { p.product_sources[0].provenance = ['forged']; }],
    ]) test('T35-expansion ' + name + ' refuses ' + label, { timeout: 180000 }, () => {
      const packet = compact(); mutate(packet); let dispatches = 0;
      assert.throws(() => { api(plugin).partitionInventory(packet); dispatches++; });
      assert.equal(dispatches, 0);
    });
    test('T35-expansion ' + name + ' lossless inventory and resealed independent snapshot tampering', { timeout: 180000 }, () => {
      const consumer = api(plugin), packet = compact(), snapshot = snapshotFor(packet, consumer);
      consumer.assertSemanticSnapshot(snapshot);
      assert.equal(snapshot.material.length, 1); assert.equal(snapshot.material[0].aliases.length, 2);
      assert.equal(snapshot.obligations.filter(row => row.kind === 'logical-completion').length, 2);
      assert.ok(snapshot.material[0].aliases.every(row => row.pointer.startsWith('/product_sources/')));
      for (const mutate of [
        p => { p.material[0].aliases[0].provenance = ['forged']; },
        p => { p.material[0].aliases.pop(); },
        p => { p.material[0].aliases.push(h.clone(p.material[0].aliases[0])); },
        p => { p.obligations.find(row => row.mandatory).mandatory = false; },
        p => { p.obligations.find(row => row.mandatory).provenance = ['forged']; },
        p => { p.obligations.pop(); },
        p => { p.code_review_packet.product_sources[0].revision = 'c'.repeat(40); p.original_packet_sha256 = h.hash(h.stable(p.code_review_packet)); },
        p => { delete p.code_review_packet.product_source_format; delete p.code_review_packet.product_source_contents; p.original_packet_sha256 = h.hash(h.stable(p.code_review_packet)); },
      ]) {
        const changed = h.clone(snapshot); mutate(changed); reseal(changed);
        assert.throws(() => consumer.assertSemanticSnapshot(changed));
      }
      const legacy = { role: 'code-review', source_revision: packet.source_revision, product_sources:
        packet.product_sources.map(({ content_ref, blob_oid, ...row }) => ({ ...row, content: packet.product_source_contents[0].content })) };
      const codec = require(path.join(plugin, 'scripts/context-packet.cjs'));
      assert.deepEqual(codec.decodeUniqueContent(codec.encodeUniqueContent(legacy, 33554432), 33554432), legacy);
      const inventory = consumer.partitionInventory(legacy);
      assert.equal(inventory.material.length, 1); assert.equal(inventory.material[0].aliases.length, 2);
      assert.equal(inventory.obligations.length, 2);
    });
    test('T35-expansion ' + name + ' original inline and compact exact raw boundaries', { timeout: 180000 }, () => {
      const consumer = api(plugin);
      for (const referenced of [false, true]) {
        const packet = compact('x'.repeat(65536)); packet.duplicate = { content: packet.product_source_contents[0].content };
        if (!referenced) {
          packet.product_sources = packet.product_sources.map(({ content_ref, blob_oid, ...row }) => ({ ...row, content: packet.product_source_contents[0].content }));
          delete packet.product_source_format; delete packet.product_source_contents;
        }
        packet.metadata = ''; packet.metadata = 'm'.repeat(33554432 - Buffer.byteLength(JSON.stringify(packet)));
        assert.equal(Buffer.byteLength(JSON.stringify(packet)), 33554432);
        consumer.partitionInventory(packet);
        packet.metadata += 'm'; assert.throws(() => consumer.partitionInventory(packet));
      }
    });
    test('T35-expansion ' + name + ' compact exact encoded boundary and metadata overflow', { timeout: 180000 }, () => {
      const consumer = api(plugin), codec = require(path.join(plugin, 'scripts/context-packet.cjs')), packet = compact('');
      packet.metadata = '';
      const overhead = Buffer.byteLength(JSON.stringify(codec.encodeUniqueContent(packet, 33554432)));
      packet.metadata = 'm'.repeat(33554432 - overhead);
      assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 33554432);
      assert.equal(Buffer.byteLength(JSON.stringify(codec.encodeUniqueContent(packet, 33554432))), 33554432);
      consumer.partitionInventory(packet);
      packet.metadata += 'm'; assert.throws(() => consumer.partitionInventory(packet));
    });
  }
  test('T35-expansion complete package inventory, modes, bytes and both identities', { timeout: 180000 }, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't35-package-')));
    try {
      const target = require('../../scripts/package-shipyard-codex.cjs').build(path.join(root, 'package'));
      h.packageParity(target); const defs = definitions(); defs.completePackage(target);
      for (const relative of ['.codex-plugin/plugin.json', 'package-build.json',
        'host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
        'host/plugins/delivery-pipeline/scripts/codex-code-review-context.cjs']) {
        const file = path.join(target, relative), before = fs.readFileSync(file);
        try { fs.appendFileSync(file, '\n'); assert.throws(() => defs.completePackage(target)); }
        finally { fs.writeFileSync(file, before); }
      }
      const sourceFile = path.join(target, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs');
      const mode = fs.statSync(sourceFile).mode & 0o777;
      try { fs.chmodSync(sourceFile, mode ^ 0o100); assert.throws(() => defs.completePackage(target)); }
      finally { fs.chmodSync(sourceFile, mode); }
      defs.completePackage(target);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('T35-expansion exact73 prefix complete actual74/77 future75/78 selectors and inventory purpose', { timeout: 180000 }, () => {
    const s = require('./shard-files.cjs'), files = s.unitFiles(), manifest = s.readManifest(), self = path.basename(SELF);
    const before = s.appendShard(manifest, s.unitTasks(files.filter(file => file !== self)));
    assert.equal(before.shards.length, 73); assert.equal(before.shards.length + 3, 76);
    assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
    const actual = s.appendShard(manifest, s.unitTasks(files));
    assert.equal(actual.shards.length, 74); assert.equal(proveRoster(actual, [...before.shards, [self]], files).length, 77);
    assert.throws(() => proveSelections(actual.shards.slice(0, -1), actual));
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't35-discovery-')));
    try {
      for (const file of files) fs.writeFileSync(path.join(directory, file), '');
      const future = 'zz-genuine-future-t35.test.cjs'; fs.writeFileSync(path.join(directory, future), '');
      const nextFiles = s.unitFiles(directory), next = s.appendShard(manifest, s.unitTasks(nextFiles));
      assert.equal(next.shards.length, 75); assert.equal(proveRoster(next, [...actual.shards, [future]], nextFiles, directory).length, 78);
      for (const mutate of [rows => rows.pop(), rows => rows.push([self]), rows => { rows[0][0] += '-changed'; }, rows => { rows[1] = rows[0]; }]) {
        const changed = h.clone(actual); mutate(changed.shards);
        assert.throws(() => proveRoster(changed, [...before.shards, [self]], files));
      }
      const home = process.env.HOME, privateHome = path.join(directory, 'inventory-home'); fs.mkdirSync(privateHome);
      try { process.env.HOME = privateHome; definitions().cases[47].run(); }
      finally { process.env.HOME = home; }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

if (isMainThread) {
  for (const [name, plugin] of [['canonical', path.dirname(h.SCRIPTS)],
    ['generated', path.join(h.ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline')]]) {
    test('T35-expansion ' + name + ' excessive aliases refuse the unchanged catalog bound', { timeout: 180000 }, () => {
      const packet = compact(), template = packet.product_sources[0];
      packet.product_sources = Array.from({ length: 7000 }, (_, i) => ({ ...template, path: 'src/alias-' + i + '.cjs' }));
      assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 33554432);
      assert.throws(() => api(plugin).partitionInventory(packet), /catalog metadata exceeds/);
    });
    test('T35-expansion ' + name + ' exact unique material and plus-one remain physical bounds', { timeout: 180000 }, () => {
      const lifecycle = require('./helpers/phase53-role-artifact-fixture.cjs').createRoleArtifactLifecycle(); lifecycle.start();
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't35-storage-')));
      try {
        const worktree = path.join(root, 'repo'); fs.mkdirSync(worktree); git(worktree, 'init', '--quiet');
        const consumer = api(plugin);
        for (const count of [16777216, 16777217]) {
          const content = 'x'.repeat(count), sha256 = h.hash(content);
          const source = { source_id: 's-' + sha256, bytes: count, sha256, content,
            aliases: [{ path: 'src/complete.txt', pointer: '/product_sources/0/content' }] };
          const record = { input_root: path.join(root, 'inputs-' + count), snapshot: { role: 'code-review',
            identity: { worktree }, material: [source] } };
          if (count === 16777216) {
            const result = consumer.semanticInputFiles(record, [], true);
            assert.equal(result.material[0].bytes, count);
            assert.equal(h.hash(fs.readFileSync(result.material[0].read_path)), sha256);
          } else assert.throws(() => consumer.semanticInputFiles(record, [], true), /exceeds/);
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); lifecycle.cleanup(); }
    });
    for (const runtime of ['codex', 'claude']) test('T35-expansion ' + name + ' ' + runtime + ' exact native input and result bounds', { timeout: 180000 }, () => {
      const consumer = api(plugin), snapshot = h.currentSized('code-review', runtime), sizing = h.sizingRecord(snapshot);
      try {
        const record = sizing.record, assignment = record.snapshot.assignments[0].id;
        record.snapshot.identity.boundary_metadata = '';
        let launch = consumer.semanticBuildLaunch(record, 'worker', assignment, [], true);
        const measured = consumer.semanticPreflight(record.snapshot, launch);
        record.snapshot.identity.boundary_metadata = 'x'.repeat((1048576 - measured.input_bytes) / (runtime === 'claude' ? 2 : 1));
        launch = consumer.semanticBuildLaunch(record, 'worker', assignment, [], true);
        assert.equal(consumer.semanticPreflight(record.snapshot, launch).input_bytes, 1048576);
        const oneOver = { ...launch, input: ' ' + launch.input };
        oneOver.input_sha256 = h.hash(oneOver.input);
        assert.throws(() => consumer.semanticPreflight(record.snapshot, oneOver),
          error => error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND' && error.details.input_bytes === 1048577);
        record.snapshot.identity.boundary_metadata += 'x';
        assert.throws(() => consumer.semanticBuildLaunch(record, 'worker', assignment, [], true),
          error => error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND');
        const result = { evidence_markdown: '' };
        result.evidence_markdown = 'x'.repeat(131072 - Buffer.byteLength(JSON.stringify(result)));
        assert.equal(Buffer.byteLength(JSON.stringify(result)), 131072);
        consumer.semanticWireBound({ result, text: JSON.stringify(result) });
        result.evidence_markdown += 'x';
        assert.throws(() => consumer.semanticWireBound({ result, text: JSON.stringify(result) }),
          error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND');
      } finally { sizing.close(); }
    });
  }
}
