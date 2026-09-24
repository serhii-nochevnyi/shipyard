'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'adr-bootstrap.cjs');
const GSD_TUNE = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gsd-tune.cjs');

const FLAT_ADR = `# ADR-900 — bootstrap flat decisions

## Status

Accepted

## Decision

- **D1 — Keep the list:** the parser already reads this shape.
- **D2 — Refuse empty projects:** an ADR with no decisions must stop bootstrap.
`;

const NESTED_ADR = `# ADR-901 — bootstrap nested decisions

## Status

Accepted

## Decision

### 1. Keep the source format readable

The source ADR may use a heading per decision.

### 2. Refuse empty decisions

An accepted ADR without decisions must stop ingestion.
`;

const NO_DECISIONS_ADR = `# ADR-902 — nothing decided

## Status

Accepted
`;

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-adr-bootstrap-'));
}

function writeAdr(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function run(dir, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

suite('adr-bootstrap — an empty project');

test('gets all three files, with REQ ids matching the ADR bullets in order', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-900.md', FLAT_ADR);
  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual([...report.created].sort(), [
    path.join('.planning', 'REQUIREMENTS.md'),
    path.join('.planning', 'ROADMAP.md'),
    path.join('.planning', 'config.json'),
  ]);
  assert.deepStrictEqual(report.skipped_existing, []);
  assert.deepStrictEqual(report.requirements.map((entry) => entry.id), ['REQ-01', 'REQ-02']);
  assert.deepStrictEqual(report.requirements.map((entry) => entry.decision), [
    '**D1 — Keep the list:** the parser already reads this shape.',
    '**D2 — Refuse empty projects:** an ADR with no decisions must stop bootstrap.',
  ]);

  assert.strictEqual(
    fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'),
    '{"git":{"branching_strategy":"none"}}\n',
  );

  const roadmap = fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');
  assert.ok(roadmap.includes('### Phase 1: bootstrap flat decisions'), roadmap);
  assert.ok(roadmap.includes('**Status**: planned (ADR-900)'), roadmap);
  assert.ok(roadmap.includes('**Requirements**: REQ-01, REQ-02'), roadmap);

  const requirements = fs.readFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), 'utf8');
  assert.ok(requirements.includes('- [ ] **REQ-01**: **D1 — Keep the list:** the parser already reads this shape.'), requirements);
  assert.ok(requirements.includes('- [ ] **REQ-02**: **D2 — Refuse empty projects:** an ADR with no decisions must stop bootstrap.'), requirements);
  assert.ok(requirements.includes('| REQ-01 | Phase 1 | Pending |'), requirements);
  assert.ok(requirements.includes('| REQ-02 | Phase 1 | Pending |'), requirements);
});

test('--phase defaults to 1 and an explicit --phase is honoured', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-901.md', NESTED_ADR);
  const result = run(dir, ['--adr', adr, '--phase', '3', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.requirements.map((entry) => entry.id), ['REQ-01', 'REQ-02']);
  const roadmap = fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');
  assert.ok(roadmap.includes('### Phase 3: bootstrap nested decisions'), roadmap);
  const requirements = fs.readFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), 'utf8');
  assert.ok(requirements.includes('| REQ-01 | Phase 3 | Pending |'), requirements);
});

suite('adr-bootstrap — a partial project');

test('a pre-existing ROADMAP.md stays byte-identical and is reported under skipped_existing', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-900.md', FLAT_ADR);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const existing = '# A hand-written roadmap\n';
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), existing);

  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.skipped_existing, [path.join('.planning', 'ROADMAP.md')]);
  assert.deepStrictEqual([...report.created].sort(), [
    path.join('.planning', 'REQUIREMENTS.md'),
    path.join('.planning', 'config.json'),
  ]);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8'), existing);
  assert.ok(fs.existsSync(path.join(dir, '.planning', 'config.json')));
  assert.ok(fs.existsSync(path.join(dir, '.planning', 'REQUIREMENTS.md')));
});

suite('adr-bootstrap — an ADR without decisions');

test('exits 1 with the plain-language refusal and writes nothing', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-902.md', NO_DECISIONS_ADR);
  const result = run(dir, ['--adr', adr]);
  assert.strictEqual(result.status, 1);
  assert.ok(
    result.stderr.includes(`${adr} has no bullets under ## Decision; add one bullet per locked decision (see templates/adr/ADR.md) and re-run`),
    result.stderr,
  );
  assert.ok(!/\.cjs:\d+:\d+/.test(result.stderr), `no stack trace expected: ${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(dir, '.planning')), 'nothing should be written');
});

suite('adr-bootstrap — a nested ADR');

test('yields one requirement per ### decision', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-901.md', NESTED_ADR);
  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.requirements.length, 2);
  assert.deepStrictEqual(report.requirements.map((entry) => entry.decision), [
    '**1. Keep the source format readable**: The source ADR may use a heading per decision.',
    '**2. Refuse empty decisions**: An accepted ADR without decisions must stop ingestion.',
  ]);
});

suite('adr-bootstrap — writes only missing files');

test('an EEXIST race on a target file is reported as skipped, not raised', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-900.md', FLAT_ADR);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{"pre-existing":true}\n');
  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.skipped_existing.includes(path.join('.planning', 'config.json')), JSON.stringify(report));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'), '{"pre-existing":true}\n');
});

suite('adr-bootstrap — non-JSON output');

test('prints one line per created file, skipped file and requirement', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-900.md', FLAT_ADR);
  const result = run(dir, ['--adr', adr]);
  assert.strictEqual(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.strictEqual(lines.filter((line) => line.startsWith('created: ')).length, 3);
  assert.strictEqual(lines.filter((line) => line.startsWith('requirement: ')).length, 2);
});

suite('adr-bootstrap — reuses the ADR decision parser');

test('requires ./adr-ingest.cjs and does not reimplement decision parsing', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(/require\(['"]\.\/adr-ingest\.cjs['"]\)/.test(source), source);
});

suite('adr-bootstrap — the generated config satisfies the conveyor REQUIRED setting');

test('gsd-tune --check --runtime claude --json reports no REQUIRED drift for git.branching_strategy', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-900.md', FLAT_ADR);
  const bootstrapRun = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(bootstrapRun.status, 0, bootstrapRun.stderr);

  const tuneRun = spawnSync(process.execPath, [GSD_TUNE, '--check', '--runtime', 'claude', '--json'], {
    cwd: dir, encoding: 'utf8',
  });
  const tuneReport = JSON.parse(tuneRun.stdout);
  const drift = tuneReport.drift.find((entry) => entry.key === 'git.branching_strategy');
  assert.strictEqual(drift, undefined, JSON.stringify(tuneReport.drift));
});

done();
