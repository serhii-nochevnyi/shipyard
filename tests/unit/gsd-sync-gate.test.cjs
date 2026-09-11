'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const GATE = path.join(ROOT, 'capabilities', 'delivery-pipeline', 'checks', 'gsd-sync-gate.cjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
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

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-gate-'));
  write(path.join(root, '.planning', 'PROJECT.md'), '# Project\n');
  write(path.join(root, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Foundation\n**Requirements**: SYNC-01\n');
  write(path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md'), [
    '---', 'phase: 1', 'plan: 1', 'title: Foundation',
    'files_modified: [src/a.js]', 'requirements: [SYNC-01]',
    'delivery:', '  ticket: T-01-01', '  risk: low', '---',
  ].join('\n'));
  write(path.join(root, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {
    'T-01-01': { phase: '1' },
  } }));
  write(path.join(root, '.planning', 'graph', 'delivery-state.json'), JSON.stringify({
    'T-01-01': { status: 'merged', since: '2026-09-10T10:00:00Z' },
  }));
  return root;
}

function run(root, mode) {
  return spawnSync(process.execPath, [GATE, mode], {
    cwd: root,
    encoding: 'utf8',
    env: testEnv(root),
  });
}

suite('gsd-sync-gate — lifecycle applicability');

test('writes and then checks a conveyor project', () => {
  const root = project();
  const writeResult = run(root, 'write');
  assert.equal(writeResult.status, 0, writeResult.stderr);
  assert.match(writeResult.stdout, /projection published/);
  const checkResult = run(root, 'check');
  assert.equal(checkResult.status, 0, checkResult.stderr);
  assert.match(checkResult.stdout, /projection is synchronized/);
});

test('refuses to adopt native GSD artifacts during a lifecycle write', () => {
  const root = project();
  const native = '# native GSD state\n';
  write(path.join(root, '.planning', 'STATE.md'), native);
  const result = run(root, 'write');
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /not owned/);
  assert.equal(fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8'), native);
});

test('blocks check mode when the projection is stale', () => {
  const root = project();
  assert.equal(run(root, 'write').status, 0);
  fs.appendFileSync(path.join(root, '.planning', 'ROADMAP.md'), '\nchanged\n');
  const result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blocked/);
});

test('is inert for ordinary GSD projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-nonconveyor-'));
  const result = run(root, 'check');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /not applicable/);
});

test('ignores malformed config while determining applicability', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-malformed-config-'));
  write(path.join(root, '.planning', 'config.json'), '{broken');
  const result = run(root, 'check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not applicable/);
});

test('blocks a malformed delivery marker that the synchronizer cannot project', () => {
  const root = project();
  const plan = path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md');
  write(plan, '---\nphase: 1\nplan: 1\ntitle: Foundation\ndelivery:\n---\n');
  const result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not applicable|blocked/);
});

test('keeps a truncated delivery plan applicable so malformed source blocks', () => {
  const root = project();
  const plan = path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md');
  write(plan, '---\nphase: 1\nplan: 1\ntitle: Foundation\ndelivery:\n  ticket: T-01-01\n  risk: low\n');
  const result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /not applicable/);
  assert.match(result.stderr, /malformed frontmatter|blocked/);
});

test('honors the declared opt-out without touching artifacts', () => {
  const root = project();
  write(path.join(root, '.planning', 'config.json'), JSON.stringify({ delivery_pipeline: { gsd_sync: false } }));
  const result = run(root, 'check');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /gsd_sync is false/);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'STATE.md')), false);
});

test('selects complete bundles and preserves synchronizer exit codes', () => {
  const source = fs.readFileSync(GATE, 'utf8');
  assert.match(source, /requiredSiblings = \['frontmatter\.cjs', 'lock\.cjs'\]/);
  assert.doesNotMatch(source, /const args = \[script, '--json', '--adopt-native'\]/);
  assert.match(source, /fail\(`\$\{mode\} blocked: \$\{blockers\}`, childExit\)/);
});

done();
