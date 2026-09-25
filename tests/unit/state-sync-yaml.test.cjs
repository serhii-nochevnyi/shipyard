'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs');

const TICKET_ID = 'T-01-01';
const BRANCH = 'ticket/T-01-01-demo';
const PR_ROW = {
  number: 1,
  state: 'MERGED',
  isDraft: false,
  headRefName: BRANCH,
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  mergedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  url: 'https://example/1',
  title: `${TICKET_ID}: demo`,
};

function stubGh(dir) {
  const script = [
    '#!/bin/sh',
    'argv="$*"',
    'case "$argv" in',
    '  "pr list --state all"*)',
    `    printf '%s' '${JSON.stringify([PR_ROW])}' ;;`,
    '  "api repos/"*"/branches"*) printf "main\\n" ;;',
    '  *) echo "stub gh: unhandled call: $argv" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
}

function testEnv(root) {
  const env = { ...process.env, HOME: path.join(root, 'home') };
  for (const key of Object.keys(env)) {
    if (/^(?:SHIPYARD_|GSD_|CLAUDE_|CODEX_|GH_|GITHUB_)/.test(key)
        || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  fs.mkdirSync(env.HOME, { recursive: true });
  return env;
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-state-sync-yaml-'));
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({
    epics: {},
    tickets: {
      [TICKET_ID]: { phase: '1', branch: BRANCH, title: 'demo', depends_on: [], risk: 'low' },
    },
  }));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({
    git: { base_branch: 'main' },
    delivery_pipeline: { gsd_sync: false },
  }));
  return root;
}

function run(root) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-state-sync-yaml-bin-'));
  stubGh(bin);
  const env = testEnv(root);
  env.PATH = bin + path.delimiter + env.PATH;
  return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
}

function yamlOf(root) {
  return fs.readFileSync(path.join(root, '.planning', 'graph', 'delivery-state.yaml'), 'utf8');
}

suite('state-sync — delivery-state.yaml is header-free and deterministic');

test('carries no comment line and is byte-identical across two independent cold syncs', () => {
  const rootA = project();
  const a = run(rootA);
  assert.equal(a.status, 0, a.stderr);
  const yamlA = yamlOf(rootA);
  assert.ok(!/^#/m.test(yamlA), `expected no comment line, got:\n${yamlA}`);

  const rootB = project();
  const b = run(rootB);
  assert.equal(b.status, 0, b.stderr);
  const yamlB = yamlOf(rootB);

  assert.equal(yamlA, yamlB, 'two independent syncs over identical GitHub state must produce identical bytes');

  assert.ok(!/^\s*since:/m.test(yamlA), 'since is a per-run clock and must not appear in the YAML');
  assert.ok(!/^\s*mergeable_since:/m.test(yamlA), 'mergeable_since is a per-run clock and must not appear in the YAML');

  assert.match(a.stdout, /snapshot generation \d+/, 'stdout must still report the snapshot generation');

  const meta = JSON.parse(fs.readFileSync(path.join(rootA, '.planning', 'graph', 'delivery-state-meta.json'), 'utf8'));
  assert.equal(meta.generation, 1);
});

test('emits each ticket block with its keys sorted deterministically', () => {
  const root = project();
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  const lines = yamlOf(root).split('\n');
  const header = `${JSON.stringify(TICKET_ID)}:`;
  const start = lines.findIndex((l) => l === header);
  assert.ok(start !== -1, `expected to find ${header} in the YAML`);
  const keys = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([a-z_]+):/);
    if (!m) break;
    keys.push(m[1]);
  }
  assert.ok(keys.length > 0, 'expected at least one field under the ticket');
  assert.deepEqual(keys, [...keys].sort(), `expected keys in sorted order, got: ${keys.join(', ')}`);
});

done();
