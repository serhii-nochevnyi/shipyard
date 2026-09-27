'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs');
const EPIC = 'epic/90-diamond';
const B = (n) => `ticket/T-90-0${n}-t`;

function pr(n, ticket, state, base) {
  return {
    number: n, state, isDraft: false, headRefName: B(ticket), headRefOid: String(n).repeat(40).slice(0, 40),
    baseRefName: base, mergedAt: state === 'MERGED' ? '2026-01-01T00:00:00Z' : null,
    createdAt: '2026-01-01T00:00:00Z', url: `https://example/${n}`, title: `T-90-0${ticket}: t`,
    reviewDecision: null, body: '', mergeStateStatus: 'CLEAN',
  };
}

function stubGh(dir, prs, branches) {
  fs.writeFileSync(path.join(dir, 'prs.json'), JSON.stringify(prs));
  fs.writeFileSync(path.join(dir, 'branches.txt'), branches.join('\n') + '\n');
  const script = [
    '#!/bin/sh',
    `d='${dir}'`,
    'argv="$*"',
    'case "$argv" in',
    '  "pr list"*) cat "$d/prs.json" ;;',
    '  "pr checks"*) printf "[]" ;;',
    '  "repo view"*) printf "main\\n" ;;',
    '  "api repos/"*"/branches"*|"api repos/{owner}/{repo}/branches"*) cat "$d/branches.txt" ;;',
    '  "api "*"/compare/"*) printf "1\\n" ;;',
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
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  env.GIT_CONFIG_GLOBAL = gitconfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function row(n, deps, extra = {}) {
  return {
    phase: '90', branch: B(n), title: 't', depends_on: deps, risk: 'low', epic: EPIC,
    files: [`f${n}.txt`], ...extra,
  };
}

function fixture({ mode = 'epic-stacked', crossRepo = false } = {}) {
  const tickets = {
    'T-90-01': row(1, []),
    'T-90-02': row(2, []),
    'T-90-03': row(3, ['T-90-01', 'T-90-02'], { primary_parent: 'T-90-01' }),
    'T-90-04': row(4, []),
  };
  if (crossRepo) tickets['T-90-02'].repo = 'other/repo';
  return {
    epics: { 90: { branch: EPIC } },
    tickets,
    mode,
  };
}

function run(fx, prs, branches) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-diamond-ready-'));
  const root = path.join(workspace, 'project');
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ epics: fx.epics, tickets: fx.tickets }));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({
    git: { base_branch: 'main' },
    delivery_pipeline: { gsd_sync: false, integration_mode: fx.mode },
  }));
  const bin = path.join(workspace, 'bin');
  fs.mkdirSync(bin);
  stubGh(bin, prs, ['main', EPIC, ...branches]);
  const env = testEnv(root);
  env.PATH = bin + path.delimiter + env.PATH;
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(graph, 'delivery-state.json'), 'utf8'));
  return { r, state };
}

suite('state-sync — a diamond child waits for its non-primary parents to land in the epic');

test('(a) both parents branched: blocked on T-90-02 with a reason naming it, T-90-01 and the epic', () => {
  const { r, state } = run(fixture(), [], [B(1), B(2)]);
  const s = state['T-90-03'];
  assert.equal(s.ready, false);
  assert.deepEqual(s.blocked_by, ['T-90-02']);
  const why = s.blocked_reasons['T-90-02'];
  assert.match(why, /T-90-02/);
  assert.match(why, /T-90-01/);
  assert.ok(why.includes(EPIC), why);
  assert.ok(r.stdout.includes(`T-90-03 ← awaiting T-90-02 (${why})`), r.stdout);
});

test('(b) T-90-02 merged into the epic: ready, base is T-90-01\'s branch, base_merge is the epic', () => {
  const { state } = run(fixture(), [pr(2, 2, 'MERGED', EPIC)], [B(1)]);
  const s = state['T-90-03'];
  assert.equal(state['T-90-02'].merged_into, EPIC);
  assert.equal(s.ready, true, JSON.stringify(s));
  assert.equal(s.base, B(1));
  assert.equal(s.base_merge, EPIC);
  assert.match(s.base_reason, /merges epic\/90-diamond in for non-primary parent\(s\) T-90-02/);
});

test('(c) T-90-02 merged into T-90-04\'s open branch waits; ready once T-90-04 lands in the epic', () => {
  const open = run(fixture(), [pr(2, 2, 'MERGED', B(4)), pr(4, 4, 'OPEN', EPIC)], [B(1), B(4)]);
  assert.equal(open.state['T-90-03'].ready, false);
  assert.deepEqual(open.state['T-90-03'].blocked_by, ['T-90-02']);
  const landed = run(fixture(), [pr(2, 2, 'MERGED', B(4)), pr(4, 4, 'MERGED', EPIC)], [B(1)]);
  assert.equal(landed.state['T-90-03'].ready, true, JSON.stringify(landed.state['T-90-03']));
});

test('(d) T-90-01 pending keeps the existing no-branch blocker', () => {
  const { state } = run(fixture(), [pr(2, 2, 'MERGED', EPIC)], []);
  const s = state['T-90-03'];
  assert.equal(s.ready, false);
  assert.deepEqual(s.blocked_by, ['T-90-01']);
  assert.equal(s.blocked_reasons['T-90-01'], 'parent has no branch yet (nothing to cascade from)');
});

test('(e) direct-to-main is unchanged', () => {
  const { state } = run(fixture({ mode: 'direct-to-main' }), [], [B(1), B(2)]);
  const s = state['T-90-03'];
  assert.deepEqual(s.blocked_by, ['T-90-01', 'T-90-02']);
  assert.equal(s.blocked_reasons['T-90-02'], 'parent not merged (direct-to-main waits for the merge)');
  assert.equal(s.base_merge, undefined);
});

test('(f) the child\'s own merged PR reads merged and is complete', () => {
  const { state } = run(fixture(), [pr(3, 3, 'MERGED', B(1))], [B(1), B(2)]);
  assert.equal(state['T-90-03'].status, 'merged');
  assert.equal(state['T-90-03'].ready, undefined);
});

test('(g) a second parent in another repository is not a diamond: the cross-repo rule decides', () => {
  const { state } = run(fixture({ crossRepo: true }), [], [B(1), B(2)]);
  const s = state['T-90-03'];
  assert.ok(s.blocked_by.includes('T-90-02'));
  assert.match(s.blocked_reasons['T-90-02'], /^cross-repo parent in other\/repo must be MERGED first/);
  assert.ok(!/non-primary/.test(s.blocked_reasons['T-90-02']));
});

done();
