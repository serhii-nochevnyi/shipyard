'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { scrub, provenanceLine } = require('../../scripts/capture-boundary-fixtures.cjs');

const ROOT = path.resolve(__dirname, '../..');
const BOUNDARIES_DIR = path.join(ROOT, 'tests/fixtures/captured/boundaries');
const UNIT_DIR = path.join(ROOT, 'tests/unit');
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
const THREAD_STARTED_SHAPE = String.raw`["']?type["']?\s*:\s*["']thread\.started["']`;
const TURN_COMPLETED_SHAPE = String.raw`["']?type["']?\s*:\s*["']turn\.completed["']`;

function loadBoundaries() {
  return fs.readdirSync(BOUNDARIES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      entry: JSON.parse(fs.readFileSync(path.join(BOUNDARIES_DIR, name), 'utf8')),
    }));
}

function checkRegistryShape(name, entry) {
  const violations = [];
  for (const field of ['boundary', 'producer', 'cli', 'cli_version']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) violations.push(`${name}: missing ${field}`);
  }
  if (!Array.isArray(entry.fixtures) || !entry.fixtures.length) violations.push(`${name}: fixtures must be a non-empty array`);
  for (const rel of entry.fixtures || []) {
    if (!fs.existsSync(path.join(ROOT, rel))) violations.push(`${name}: fixture does not exist: ${rel}`);
  }
  for (const key of ['consumers', 'migrating', 'inline_shapes', 'legacy']) {
    if (entry[key] !== undefined && !Array.isArray(entry[key])) violations.push(`${name}: ${key} must be an array`);
  }
  return violations;
}

function checkFixtureScrub(entry) {
  const violations = [];
  const legacy = new Set(entry.legacy || []);
  for (const rel of entry.fixtures || []) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
    catch (error) { violations.push(`${rel}: fixture file missing (${error.message})`); continue; }
    if (legacy.has(rel)) {
      console.log(`[boundary-fixtures] legacy: ${rel}`);
    } else {
      if (content.includes('/Users/')) violations.push(`${rel}: contains /Users/`);
      if (content.includes('/home/')) violations.push(`${rel}: contains /home/`);
      if (content.includes('/var/folders/')) violations.push(`${rel}: contains /var/folders/`);
      if (UUID_RE.test(content)) violations.push(`${rel}: contains an unplaceholdered UUID`);
    }
    if (/\bsk-[A-Za-z0-9_-]{10,}\b/.test(content) || /\bghp_[A-Za-z0-9]{20,}\b/.test(content)
        || /Bearer\s+[^\s"']+/i.test(content)) {
      violations.push(`${rel}: contains a token-shaped string`);
    }
  }
  return violations;
}

function firstMatchLine(content, patterns) {
  const lines = content.split('\n');
  for (const regex of patterns) {
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) return i + 1;
    }
  }
  return 0;
}

const SELF = path.basename(__filename);

function scanInlineShapes(entry, unitDir, keyPrefix) {
  const patterns = (entry.inline_shapes || []).map((source) => new RegExp(source));
  const migrating = new Set(entry.migrating || []);
  const consumers = new Set(entry.consumers || []);
  const names = fs.readdirSync(unitDir).filter((name) => name.endsWith('.test.cjs') && name !== SELF);
  const seen = new Set(names.map((name) => `${keyPrefix}/${name}`));
  const violations = [];
  for (const name of names) {
    const key = `${keyPrefix}/${name}`;
    const content = fs.readFileSync(path.join(unitDir, name), 'utf8');
    const line = firstMatchLine(content, patterns);
    if (consumers.has(key)) {
      const readsFixture = (entry.fixtures || []).some((rel) => content.includes(rel));
      if (!readsFixture) violations.push(`${key}: registered consumer does not read a registered fixture path`);
      if (line) violations.push(`${key}:${line}: registered consumer still matches an inline shape`);
      continue;
    }
    if (migrating.has(key)) {
      if (!line) violations.push(`${key}: listed under migrating but no longer matches any inline shape`);
      continue;
    }
    if (line) violations.push(`${key}:${line}: fabricates a registered producer shape inline; add it to migrating or load the registered fixture`);
  }
  for (const key of migrating) {
    if (!seen.has(key)) violations.push(`${key}: listed under migrating but was not found under ${unitDir}`);
  }
  return violations;
}

function warnVersionMismatch(entry) {
  try {
    if (entry.cli === 'codex') {
      const host = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
      const probe = host.probeCodexRuntime({ capabilities: { supportedModels: ['gpt-6-luna'], supportedEfforts: ['low'] } });
      if (probe.status === 'available' && probe.runtime_version && !probe.runtime_version.includes(entry.cli_version)) {
        console.warn(`[boundary-fixtures] warning: installed codex --version (${probe.runtime_version}) differs from registered cli_version ${entry.cli_version}`);
      }
    } else if (entry.cli === 'claude') {
      const host = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
      const probe = host.probeClaudeRuntime({ checkAuth: false });
      if (probe.status === 'available' && probe.runtime_version && !probe.runtime_version.includes(entry.cli_version)) {
        console.warn(`[boundary-fixtures] warning: installed claude --version (${probe.runtime_version}) differs from registered cli_version ${entry.cli_version}`);
      }
    }
  } catch (error) {
    console.warn(`[boundary-fixtures] warning: version probe failed: ${error.message}`);
  }
}

function withTempUnitDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-fixtures-scan-'));
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

suite('boundary-fixtures — registry contract');

const boundaries = loadBoundaries();

test('at least one boundary is registered', () => {
  assert.ok(boundaries.length > 0);
});

for (const { name, entry } of boundaries) {
  test(`${name}: registry shape is valid and fixtures exist`, () => {
    assert.deepEqual(checkRegistryShape(name, entry), []);
  });

  test(`${name}: fixtures are scrubbed`, () => {
    assert.deepEqual(checkFixtureScrub(entry), []);
  });

  test(`${name}: consumers and migrating files match the registered inline shapes truthfully`, () => {
    for (const key of entry.migrating || []) console.log(`[boundary-fixtures] migrating: ${key}`);
    assert.deepEqual(scanInlineShapes(entry, UNIT_DIR, 'tests/unit'), []);
  });

  test(`${name}: an installed CLI version mismatch warns and never fails`, () => {
    warnVersionMismatch(entry);
  });
}

suite('boundary-fixtures — inline-shape scan (synthetic, scan root injected)');

test('a synthetic file matching an inline shape and absent from migrating fails the scan', () => {
  withTempUnitDir({ 'decoy.test.cjs': "const record = { type: 'turn.completed' };\n" }, (dir) => {
    const entry = { migrating: [], consumers: [], inline_shapes: [TURN_COMPLETED_SHAPE], fixtures: [] };
    const violations = scanInlineShapes(entry, dir, 'tests/unit');
    assert.equal(violations.length, 1);
    assert.match(violations[0], /decoy\.test\.cjs:1:/);
  });
});

test('removing a still-fabricating file from migrating fails the scan', () => {
  withTempUnitDir({
    'a.test.cjs': "const record = { type: 'turn.completed' };\n",
    'b.test.cjs': "const record = { type: 'thread.started' };\n",
  }, (dir) => {
    const entry = {
      migrating: ['tests/unit/a.test.cjs'],
      consumers: [],
      inline_shapes: [TURN_COMPLETED_SHAPE, THREAD_STARTED_SHAPE],
      fixtures: [],
    };
    const violations = scanInlineShapes(entry, dir, 'tests/unit');
    assert.equal(violations.length, 1);
    assert.match(violations[0], /b\.test\.cjs:1:/);
  });
});

test('a migrating entry that no longer matches any inline shape fails the scan', () => {
  withTempUnitDir({ 'fixed.test.cjs': "const raw = loadFixture('codex-agent-parent-0.155.1.jsonl');\n" }, (dir) => {
    const entry = { migrating: ['tests/unit/fixed.test.cjs'], consumers: [], inline_shapes: [TURN_COMPLETED_SHAPE], fixtures: [] };
    const violations = scanInlineShapes(entry, dir, 'tests/unit');
    assert.equal(violations.length, 1);
    assert.match(violations[0], /fixed\.test\.cjs: listed under migrating but no longer matches/);
  });
});

test('a registered consumer must read a registered fixture and stop fabricating inline', () => {
  withTempUnitDir({ 'consumer.test.cjs': "const record = { type: 'turn.completed' };\n" }, (dir) => {
    const entry = {
      migrating: [], consumers: ['tests/unit/consumer.test.cjs'],
      inline_shapes: [TURN_COMPLETED_SHAPE], fixtures: ['tests/fixtures/codex-agent-parent-0.155.1.jsonl'],
    };
    assert.equal(scanInlineShapes(entry, dir, 'tests/unit').length, 2);
  });
  withTempUnitDir({ 'consumer.test.cjs': "const raw = fs.readFileSync('tests/fixtures/codex-agent-parent-0.155.1.jsonl');\n" }, (dir) => {
    const entry = {
      migrating: [], consumers: ['tests/unit/consumer.test.cjs'],
      inline_shapes: [TURN_COMPLETED_SHAPE], fixtures: ['tests/fixtures/codex-agent-parent-0.155.1.jsonl'],
    };
    assert.deepEqual(scanInlineShapes(entry, dir, 'tests/unit'), []);
  });
});

suite('boundary-fixtures — scrub() and provenanceLine()');

test('scrub replaces a home path prefix while preserving the remainder', () => {
  const out = scrub('cwd=/Users/alice/project/file.txt', {});
  assert.ok(!out.includes('/Users/'));
  assert.ok(out.includes('<HOME>/project/file.txt'));
});

test('scrub replaces token-shaped strings', () => {
  const out = scrub('Authorization: Bearer sk-abcdefghijklmnop', {});
  assert.ok(!/sk-[A-Za-z0-9_-]{10,}/.test(out));
  assert.ok(out.includes('<TOKEN>'));
});

test('scrub renames a repeated session id to the same placeholder', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const out = scrub(`a:${id} b:${id}`, {});
  const placeholder = out.match(/<SESSION-\d+>/)[0];
  assert.equal(out, `a:${placeholder} b:${placeholder}`);
});

test('scrub assigns distinct placeholders to distinct session ids', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const out = scrub(`a:${a} b:${b}`, {});
  assert.ok(out.includes('<SESSION-1>'));
  assert.ok(out.includes('<SESSION-2>'));
});

test('provenanceLine emits the required shape', () => {
  const line = JSON.parse(provenanceLine({
    boundary: 'codex-agent-stream', cli: 'codex', cli_version: '0.155.1', captured_at: '2026-01-01T00:00:00.000Z',
  }));
  assert.deepEqual(line, {
    shipyard_fixture: {
      boundary: 'codex-agent-stream', cli: 'codex', cli_version: '0.155.1',
      captured_at: '2026-01-01T00:00:00.000Z', scrubbed: true,
    },
  });
});

suite('boundary-fixtures — capture CLI dry-run');

test('dry-run scrubs a given input and writes a provenance line with no network access', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-fixtures-dry-run-'));
  const input = path.join(tmp, 'input.jsonl');
  fs.writeFileSync(input, `${JSON.stringify({ type: 'response_item', payload: { cwd: '/Users/example/project' } })}\n`);
  const outDir = path.join(tmp, 'out');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/capture-boundary-fixtures.cjs'),
    '--boundary', 'codex-agent-stream', '--dry-run', '--input', input, '--out-dir', outDir,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(path.join(outDir, 'codex-agent-stream.jsonl'), 'utf8');
  const lines = written.split('\n').filter(Boolean);
  const provenance = JSON.parse(lines[0]);
  assert.equal(provenance.shipyard_fixture.boundary, 'codex-agent-stream');
  assert.equal(provenance.shipyard_fixture.scrubbed, true);
  assert.ok(!written.includes('/Users/'));
});

done();
