'use strict';
const { test: registerTest } = require('node:test');
const partition = process.env.SHIPYARD_OBSERVATION_TEST_PART;
if (partition === undefined) {
  registerTest('two isolated observation groups execute the complete disjoint case inventory', async () => {
    const assert = require('node:assert/strict');
    const { spawn } = require('node:child_process');
    const marker = 'OBSERVATION_PARTITION_INVENTORY ';
    const reports = await Promise.all([1, 2].map(part => new Promise(resolve => {
      const env = { ...process.env, SHIPYARD_OBSERVATION_TEST_PART: String(part) };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', __filename], { env });
      let stdout = '', stderr = '', error = null;
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', failure => { error = failure; });
      const timer = setTimeout(() => { error = new Error('observation group timed out'); child.kill('SIGTERM'); }, 1800000);
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        resolve({ part, status, signal, stdout, stderr, error });
      });
    })));
    for (const report of reports) {
      process.stdout.write(report.stdout);
      process.stderr.write(report.stderr);
      assert.equal(report.error, null);
      assert.equal(report.signal, null);
      assert.equal(report.status, 0, 'group ' + report.part + ' must pass');
    }
    const inventories = reports.map(report => {
      const lines = report.stdout.split('\n').filter(line => line.includes(marker));
      assert.equal(lines.length, 1);
      const inventory = JSON.parse(lines[0].slice(lines[0].indexOf(marker) + marker.length));
      assert.equal(inventory.part, report.part);
      assert.equal(inventory.all.length, 30);
      assert.equal(new Set(inventory.all).size, inventory.all.length);
      assert.ok(inventory.selected.length > 0);
      for (const field of ['tests', 'pass']) {
        const count = new RegExp('^# ' + field + ' (\\d+)$', 'm').exec(report.stdout);
        assert.ok(count, field + ' summary');
        assert.equal(Number(count[1]), inventory.selected.length);
      }
      assert.match(report.stdout, /^# fail 0$/m);
      assert.match(report.stdout, /^# skipped 0$/m);
      return inventory;
    });
    assert.deepEqual(inventories[0].all, inventories[1].all);
    const selected = inventories.flatMap(inventory => inventory.selected);
    assert.deepEqual([...selected].sort(), [...inventories[0].all].sort());
    assert.equal(new Set(selected).size, selected.length);
  });
} else {
  if (!/^[12]$/.test(partition)) throw new Error('invalid observation test partition');
  const inventory = { part: Number(partition), all: [], selected: [] };
  function test(name, ...args) {
    inventory.all.push(name);
    if ((inventory.all.length - 1) % 2 + 1 !== inventory.part) return;
    inventory.selected.push(name);
    return registerTest(name, ...args);
  }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner; loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
  };
  loaded._compile(fs.readFileSync(owner, 'utf8') + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, originalPartitionSessions };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller,
  originalPartitionSessions } = loaded.exports;

function observation(rows, stream, final) {
  const assistant = rows.find(row => row.type === 'assistant');
  const counters = { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 100, output_tokens: 100 };
  assistant.message.stop_reason = 'tool_use';
  assistant.message.usage = { ...counters, output_tokens_details: { thinking_tokens: 40 },
    iterations: [{ type: 'message', ...counters, output_tokens_details: { thinking_tokens: 40 } }] };
  const second = structuredClone(assistant);
  second.message.id += '-second'; second.request_id += '-second';
  delete second.message.usage.iterations;
  rows.push(second, structuredClone(assistant));
  const chunks = [assistant, second].flatMap(row => [1, 20].map(output => {
    const chunk = structuredClone(row);
    chunk.message.stop_reason = null;
    chunk.message.usage = { ...counters, output_tokens: output, output_tokens_details: { thinking_tokens: 1 } };
    return chunk;
  }));
  stream.splice(1, stream.length - 2, ...chunks, structuredClone(second));
  final.usage = Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value * 2]));
  Object.assign(Object.values(final.modelUsage)[0], { contextWindow: 1100,
    inputTokens: 200, cacheReadInputTokens: 1400, cacheCreationInputTokens: 200, outputTokens: 200 });
}

test('partial Claude ledger seals units and final', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = publicPartitionFixture(f, 'claude', { observed: true, observation });
    const result = await supportedPartitionCaller(f, 'claude', prepared.options);
    assert.equal(result.result.outcome, 'passed');
  });
});

const negatives = {
  'missing ID': (_rows, stream) => stream.splice(1, 2),
  'extra ID': (_rows, stream) => { const row = structuredClone(stream[1]); row.message.id += '-foreign'; stream.splice(1, 0, row); },
  'early input': (_rows, stream) => stream[1].message.usage.input_tokens++,
  'early cache': (_rows, stream) => stream[1].message.usage.cache_read_input_tokens++,
  'output exceeds final': (_rows, stream) => stream[1].message.usage.output_tokens = 101,
  'completed mismatch': (_rows, stream) => stream[1].message.stop_reason = 'end_turn',
  'single iteration mismatch': rows => rows[1].message.usage.iterations[0].input_tokens++,
  'ambiguous iterations': rows => rows[1].message.usage.iterations.push(structuredClone(rows[1].message.usage.iterations[0])),
  'terminal mismatch': (_rows, _stream, final) => final.usage.input_tokens++,
  'model mismatch': (_rows, _stream, final) => Object.values(final.modelUsage)[0].outputTokens++,
  'missing model usage counter': (_rows, _stream, final) => delete Object.values(final.modelUsage)[0].inputTokens,
  'native overflow': rows => { for (const row of rows.filter(row => row.type === 'assistant')) { row.message.usage.input_tokens = 2000; if (row.message.usage.iterations) row.message.usage.iterations[0].input_tokens = 2000; } },
  'unsupported stop': rows => rows[1].message.stop_reason = 'max_tokens',
  'missing terminal usage': (_rows, _stream, final) => delete final.usage,
  'unsafe output': (_rows, stream) => stream[1].message.usage.output_tokens = Number.MAX_SAFE_INTEGER + 1,
  'negative cache': (_rows, stream) => stream[1].message.usage.cache_creation_input_tokens = -1,
  'thinking exceeds output': (_rows, stream) => stream[1].message.usage.output_tokens_details.thinking_tokens = 2,
  'foreign session': (_rows, stream) => stream[1].session_id = 'foreign',
  'foreign request': (_rows, stream) => stream[1].request_id = 'foreign',
  'compaction': (_rows, stream) => stream.splice(1, 0, { type: 'context_compacted' }),
  'context edits': (_rows, stream) => stream[1].message.context_management = { applied_edits: [{}] },
  'truncation': (_rows, stream) => stream[1].truncated = true,
  'reroute': (_rows, stream) => stream.splice(1, 0, { type: 'model_rerouted' }),
};
for (const [name, mutate] of Object.entries(negatives)) test('partial ledger refuses ' + name, async () => {
  await publicIntegrationFixture(async f => {
    const prepared = publicPartitionFixture(f, 'claude', { observed: true,
      observation(rows, stream, final) { observation(rows, stream, final); mutate(rows, stream, final); } });
    await assert.rejects(supportedPartitionCaller(f, 'claude', prepared.options), error =>
      error.code === (name === 'native overflow' ? 'INTEGRATION_INPUT_OVER_BOUND'
        : name === 'foreign session' ? 'RUNTIME_EVIDENCE_INVALID' : 'INTEGRATION_PARTITION_INVALID'));
  });
});

test('root-only phase coverage arrays still refuse sealing', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = publicPartitionFixture(f, 'claude', { observed: true, observation,
      result(result) {
        if (result.kind !== 'phase') return;
        for (const key of ['seam_dispositions', 'limitations']) {
          result[key] = result.coverage[key]; delete result.coverage[key];
        }
      } });
    await assert.rejects(supportedPartitionCaller(f, 'claude', prepared.options), error =>
      error.code === 'INTEGRATION_PARTITION_INVALID');
  });
});

for (const mode of ['complete', 'complete-updates', 'complete-multi', 'complete-mismatch']) test('legacy Claude ' + mode, async () => {
  await publicIntegrationFixture(async f => {
    const prepared = publicPartitionFixture(f, 'claude', { observed: true,
      observation(rows, stream, final) {
        const assistant = rows.find(row => row.type === 'assistant');
        if (mode === 'complete-multi') {
          const counters = { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 100, output_tokens: 100 };
          assistant.message.usage = { input_tokens: 200, cache_read_input_tokens: 1400, cache_creation_input_tokens: 200, output_tokens: 200,
            iterations: [0, 1].map(() => ({ type: 'message', ...counters })) };
          Object.values(final.modelUsage)[0].contextWindow = 1100;
        }
        if (mode === 'complete-updates') {
          const earlier = structuredClone(assistant);
          earlier.message.stop_reason = null; earlier.message.usage.output_tokens = 1;
          if (earlier.message.usage.output_tokens_details) earlier.message.usage.output_tokens_details.thinking_tokens = 1;
          rows.splice(rows.indexOf(assistant), 0, earlier);
          stream.splice(1, stream.length - 2, ...rows.filter(row => row.type === 'assistant').map(row => structuredClone(row)));
        } else stream.splice(1, stream.length - 2, structuredClone(assistant));
        if (mode === 'complete-mismatch') stream[1].message.usage.output_tokens++;
      } });
    if (mode === 'complete-mismatch') {
      await assert.rejects(supportedPartitionCaller(f, 'claude', prepared.options), error =>
      error.code === 'INTEGRATION_PARTITION_INVALID');
    } else {
      assert.equal((await supportedPartitionCaller(f, 'claude', prepared.options)).result.outcome, 'passed');
    }
  });
  if (mode === 'complete-updates') await publicIntegrationFixture(async f => {
    const prepared = publicPartitionFixture(f, 'claude', { observed: true,
      observation(rows, stream) {
        const assistant = rows.find(row => row.type === 'assistant');
        assistant.message.stop_reason = null;
        stream.splice(1, stream.length - 2, structuredClone(assistant));
      } });
    await assert.rejects(supportedPartitionCaller(f, 'claude', prepared.options), error =>
      error.code === 'INTEGRATION_PARTITION_INVALID');
  });
});

function assertNestedInstructions(text) {
  assert.ok(text.includes('coverage.seam_dispositions'));
  assert.ok(text.includes('coverage.limitations'));
  const template = text.slice(text.indexOf('The following shape is scoped to the v3 phase final')).match(/```json\n(\{[\s\S]*?\})\n```/);
  assert.ok(template, 'explicit v3 template');
  const result = JSON.parse(template[1]);
  assert.equal(result.review_contract, 'shipyard.integration-review.v3');
  for (const key of ['schema', 'plan_sha256', 'coverage_sha256', 'unit_artifacts',
    'primary_segment_ids', 'primary_obligation_ids', 'seam_dispositions', 'limitations'])
    assert.ok(Object.hasOwn(result.coverage, key), key);
  assert.equal(Object.hasOwn(result, 'seam_dispositions'), false);
  assert.equal(Object.hasOwn(result, 'limitations'), false);
}

test('Claude loader and all generated Codex integrator rungs carry the nested v3 contract', () => {
  const root = path.resolve(__dirname, '../..');
  const plugin = path.join(root, 'plugins/delivery-pipeline');
  const loader = require(path.join(plugin, 'scripts/claude-reference-content.cjs'));
  const canonical = fs.readFileSync(path.join(plugin, 'references/integrator.md'), 'utf8');
  assert.equal(loader.loadClaudeReferenceContent('integrator'), canonical);
  assertNestedInstructions(canonical);
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't38-instructions-'));
  try {
    const codexHome = path.join(dir, 'codex');
    const converter = path.join(codexHome, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs');
    fs.mkdirSync(path.dirname(converter), { recursive: true });
    fs.writeFileSync(converter, 'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n');
    const policy = require(path.join(plugin, 'scripts/model-policy.cjs'));
    const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat().map(rung => ({
      model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort }));
    const capabilities = path.join(dir, 'capabilities.json');
    fs.writeFileSync(capabilities, JSON.stringify({ supportedModels: [...new Set(selections.map(s => s.model))],
      supportedEfforts: [...new Set(selections.map(s => s.effort))], supportedSelections: selections }));
    const out = path.join(dir, 'out'), project = path.join(dir, 'project');
    fs.mkdirSync(project);
    const generated = spawnSync(process.execPath, [path.join(root, 'scripts/gen-codex-shipyard.cjs'),
      '--plugin', plugin, '--out', out, '--codex-home', codexHome, '--phase', '2',
      '--project-dir', project, '--capabilities', capabilities], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: dir, GSD_HOME: dir, CODEX_HOME: codexHome, SHIPYARD_GSD_AUTO_INSTALL: '0' },
    });
    assert.equal(generated.status, 0, generated.stderr);
    const files = fs.readdirSync(path.join(out, 'agents')).filter(name => name.includes('integrator'));
    const variants = require(path.join(root, 'scripts/gen-codex-shipyard.cjs')).codexStaticVariants(2);
    assert.deepEqual(files.sort(), variants.filter(v => v.reference === 'integrator').map(v => v.file).sort());
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = fs.readFileSync(path.join(out, 'agents', file), 'utf8');
      const body = text.slice(text.indexOf('developer_instructions = ')).replace(/\\"/g, '"');
      assertNestedInstructions(body);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('OBSERVATION_PARTITION_INVENTORY ' + JSON.stringify(inventory));
}
