'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'adr-bootstrap.cjs');
const GSD_TUNE = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gsd-tune.cjs');
const GSD_SYNC = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gsd-sync.cjs');
const VALIDATE_GRAPH = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'validate-graph.cjs');

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

const THREE_DECISION_ADR = `# ADR-903 — bootstrap gsd projection

## Status

Accepted

## Decision

- **D1 — Keep it deterministic:** the bootstrap creates a project gsd-sync accepts.
- **D2 — Preserve decision text:** every decision reaches REQUIREMENTS.md.
- **D3 — Own the marker truthfully:** the marker never claims a fingerprint that matches no source.
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

function testEnv(root) {
  const env = { ...process.env, HOME: path.join(root, 'home') };
  for (const key of Object.keys(env)) {
    if (/^(?:SHIPYARD_|GSD_|CLAUDE_|CODEX_)/.test(key)
        || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  fs.mkdirSync(env.HOME, { recursive: true });
  return env;
}

function runGsdSync(dir, env, args = []) {
  return spawnSync(process.execPath, [GSD_SYNC, '--json', ...args], { cwd: dir, encoding: 'utf8', env });
}

function bootstrapDeliveryProject(adrContent) {
  const dir = project();
  const env = testEnv(dir);
  const adr = writeAdr(dir, 'ADR-903.md', adrContent);
  const bootstrapResult = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(bootstrapResult.status, 0, bootstrapResult.stderr);

  const phaseDir = path.join(dir, '.planning', 'phases', '01-bootstrap-gsd-projection');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'example.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
    '---', 'phase: 1', 'plan: 1', 'title: "Projection"',
    'files_modified: [src/example.js]', 'requirements: [REQ-01]',
    'delivery:', '  ticket: T-01-01', '  risk: low', '---', '',
    '## Goal', '', 'Wire the bootstrapped project into gsd-sync.',
  ].join('\n'));

  const graphResult = spawnSync(process.execPath, [VALIDATE_GRAPH], { cwd: dir, encoding: 'utf8', env });
  assert.strictEqual(graphResult.status, 0, graphResult.stdout + graphResult.stderr);

  fs.writeFileSync(
    path.join(dir, '.planning', 'graph', 'delivery-state.json'),
    JSON.stringify({ 'T-01-01': { status: 'pending' } }),
  );

  return { dir, env, bootstrapReport: JSON.parse(bootstrapResult.stdout) };
}

suite('adr-bootstrap — an empty project');

test('gets all three files, with REQ ids matching the ADR bullets in order', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-900.md', FLAT_ADR);
  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual([...report.created].sort(), [
    path.join('.planning', 'PROJECT.md'),
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
    path.join('.planning', 'PROJECT.md'),
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
  assert.strictEqual(lines.filter((line) => line.startsWith('created: ')).length, 4);
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

suite('adr-bootstrap — the bootstrapped project satisfies the gsd-sync projection');

test('a bootstrapped project passes gsd-sync publication and --check', () => {
  const { dir, env } = bootstrapDeliveryProject(THREE_DECISION_ADR);

  const publish = runGsdSync(dir, env);
  assert.strictEqual(publish.status, 0, publish.stdout + publish.stderr);
  const publishResult = JSON.parse(publish.stdout);
  assert.strictEqual(publishResult.ok, true, publish.stdout);

  const check = runGsdSync(dir, env, ['--check']);
  assert.strictEqual(check.status, 0, check.stdout + check.stderr);
  const checkResult = JSON.parse(check.stdout);
  assert.strictEqual(checkResult.ok, true, check.stdout);
  assert.deepStrictEqual(checkResult.blockers, []);

  for (const output of [publish.stdout, check.stdout]) {
    assert.ok(!output.includes('not owned by'), output);
    assert.ok(!output.includes('PROJECT.md is missing'), output);
    assert.ok(!output.includes('has no ### Phase'), output);
  }
});

test('the published REQUIREMENTS.md keeps every ADR decision text', () => {
  const { dir, env, bootstrapReport } = bootstrapDeliveryProject(THREE_DECISION_ADR);
  const publish = runGsdSync(dir, env);
  assert.strictEqual(publish.status, 0, publish.stdout + publish.stderr);

  const requirements = fs.readFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), 'utf8');
  for (const entry of bootstrapReport.requirements) {
    const decision = entry.decision.replace(/\s+/g, ' ').trim();
    assert.ok(requirements.includes(`- [ ] **${entry.id}**: ${decision}`), requirements);
    assert.ok(requirements.includes(`| ${entry.id} | Phase 1 | `), requirements);
  }
});

test('before publication gsd-sync --check reports stale files, not an unowned REQUIREMENTS.md', () => {
  const { dir, env } = bootstrapDeliveryProject(THREE_DECISION_ADR);
  const check = runGsdSync(dir, env, ['--check']);
  assert.strictEqual(check.status, 1, check.stdout + check.stderr);
  const result = JSON.parse(check.stdout);
  assert.ok(result.blockers.length > 0, check.stdout);
  for (const blocker of result.blockers) {
    assert.ok(/ is missing or stale$/.test(blocker), blocker);
  }
});

suite('adr-bootstrap — bootstrap output satisfies the gsd-sync projection contract');

test('creates PROJECT.md with a Core Value section and marks REQUIREMENTS.md as projection-owned', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-903.md', THREE_DECISION_ADR);
  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.created, [
    path.join('.planning', 'config.json'),
    path.join('.planning', 'ROADMAP.md'),
    path.join('.planning', 'REQUIREMENTS.md'),
    path.join('.planning', 'PROJECT.md'),
  ]);

  const requirements = fs.readFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), 'utf8');
  const markerLine = /^(?:#\s+)?(?:<!--\s*)?shipyard:gsd-sync generated;\s*sync-version:\s*\d+;\s*source fingerprint:\s*[0-9a-f]+\s*(?:-->)?\s*$/;
  assert.ok(markerLine.test(requirements.split(/\r?\n/)[2]), requirements);

  const roadmap = fs.readFileSync(path.join(dir, '.planning', 'ROADMAP.md'), 'utf8');
  for (const entry of report.requirements) {
    assert.ok(roadmap.includes(`- **${entry.id}** — `), roadmap);
  }

  const projectMd = fs.readFileSync(path.join(dir, '.planning', 'PROJECT.md'), 'utf8');
  assert.ok(projectMd.includes('## Core Value'), projectMd);
  assert.ok(projectMd.includes('Implement ADR-903: bootstrap gsd projection.'), projectMd);
});

test('a pre-existing PROJECT.md stays byte-identical', () => {
  const dir = project();
  const adr = writeAdr(dir, 'ADR-903.md', THREE_DECISION_ADR);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const existing = '# Hand-written project\n\n## Core Value\nWritten by a human.\n';
  fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), existing);

  const result = run(dir, ['--adr', adr, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.skipped_existing, [path.join('.planning', 'PROJECT.md')]);
  assert.deepStrictEqual([...report.created].sort(), [
    path.join('.planning', 'REQUIREMENTS.md'),
    path.join('.planning', 'ROADMAP.md'),
    path.join('.planning', 'config.json'),
  ]);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.planning', 'PROJECT.md'), 'utf8'), existing);
});

done();
