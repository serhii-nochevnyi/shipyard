'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  MAX_REFERENCE_BYTES, MAX_TOTAL_BYTES, assertCanonicalGraph, deliverPlan,
} = require('../../plugins/delivery-pipeline/scripts/plan-delivery.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function code(fn) {
  try { fn(); } catch (error) { return error.code; }
  throw new assert.AssertionError({ message: 'expected a throw' });
}

suite('plan-delivery — assertCanonicalGraph');

test('a plain directory outside every git worktree is canonical (test fixtures)', () => {
  const root = tempDir('shipyard-plan-delivery-plain-');
  try {
    const graphDir = path.join(root, 'graph');
    fs.mkdirSync(graphDir);
    assertCanonicalGraph({ graphDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the existing host-test shape (graph unrelated to any git worktree) passes', () => {
  const root = tempDir('shipyard-plan-delivery-host-shape-');
  try {
    const worktree = path.join(root, 'repo');
    const graphDir = path.join(root, 'graph');
    fs.mkdirSync(worktree);
    fs.mkdirSync(graphDir);
    execFileSync('git', ['-C', worktree, 'init', '-q', '-b', 'ticket/T-99-01'], { stdio: 'ignore' });
    assertCanonicalGraph({ graphDir, worktree });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function twoWorktreeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Plan Delivery Test');
  git(repo, 'config', 'user.email', 'plan-delivery@example.test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'root\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  return repo;
}

test('the main worktree is canonical even with an untracked graph copy', () => {
  const root = tempDir('shipyard-plan-delivery-main-');
  try {
    const repo = twoWorktreeRepo(root);
    const graphDir = path.join(repo, '.planning', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{}');
    assertCanonicalGraph({ graphDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an untracked graph copy inside a second worktree refuses GRAPH_NOT_CANONICAL, naming the source', () => {
  const root = tempDir('shipyard-plan-delivery-copy-');
  try {
    const repo = twoWorktreeRepo(root);
    git(repo, 'branch', 'ticket/other');
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', linked, 'ticket/other');
    const graphDir = path.join(linked, '.planning', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{}');
    let thrown;
    try { assertCanonicalGraph({ graphDir, worktree: linked, source: 'env' }); } catch (error) { thrown = error; }
    assert.ok(thrown, 'expected a refusal');
    assert.equal(thrown.code, 'GRAPH_NOT_CANONICAL');
    assert.match(thrown.message, /SHIPYARD_GRAPH_DIR/);
    assert.ok(thrown.message.includes(fs.realpathSync(graphDir)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a graph tracked at HEAD of a ticket (non-main) worktree is canonical — the Shipyard case', () => {
  const root = tempDir('shipyard-plan-delivery-tracked-');
  try {
    const repo = twoWorktreeRepo(root);
    git(repo, 'branch', 'ticket/T-40-28');
    const linked = path.join(root, 'ticket-worktree');
    git(repo, 'worktree', 'add', '-q', linked, 'ticket/T-40-28');
    const graphDir = path.join(linked, '.planning', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{"tickets":{}}');
    git(linked, 'add', '.planning/graph/tickets.json');
    git(linked, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tracked graph');
    assertCanonicalGraph({ graphDir, worktree: linked });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an index-only tickets.json (staged, not committed) in a second worktree does not count as tracked', () => {
  const root = tempDir('shipyard-plan-delivery-staged-');
  try {
    const repo = twoWorktreeRepo(root);
    git(repo, 'branch', 'ticket/staged-only');
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', linked, 'ticket/staged-only');
    const graphDir = path.join(linked, '.planning', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{}');
    git(linked, 'add', '.planning/graph/tickets.json');
    assert.equal(code(() => assertCanonicalGraph({ graphDir })), 'GRAPH_NOT_CANONICAL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('plan-delivery — deliverPlan');

function projectFixture(root) {
  const projectRoot = path.join(root, 'project');
  const graphDir = path.join(projectRoot, '.planning', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{"tickets":{}}');
  return { projectRoot, graphDir };
}

const FIXTURE_CONTEXT_LINES = [
  '- `plugins/delivery-pipeline/scripts/front.cjs` `computeFront`: the actionable tickets.',
  '- `.planning/graph/tickets.json` rows: `branch` (the one producer is `validate-graph.cjs:174`), `plan`, `type`, `risk`, `human_checkpoint`.',
  '- `plugins/delivery-pipeline/scripts/model-policy-internal.cjs:421-441` (anchor A4): the accepted signals. `workflows/executors.mjs` args: the exact `args.tickets[]` field names (40-RESEARCH assumption A-8; read before writing the builder).',
  '- `.planning/architecture/ADR-019-pipeline-subscription-efficiency.md:29-48`; `41-RESEARCH.md:203-246` and P41-A in `CONTEXT.md`.',
  '- Placeholder shape (illustrative only, from another ticket): `.planning/phases/<phase-dir>/<NN>-RESEARCH.md`.',
  '- A missing optional reference: `.planning/phases/fixture-phase/NOPE.md`.',
].join('\n');

function fixturePlan(projectRoot, { extraLines = [] } = {}) {
  const phaseDir = path.join(projectRoot, '.planning', 'phases', 'fixture-phase');
  fs.mkdirSync(phaseDir, { recursive: true });
  const planRel = '.planning/phases/fixture-phase/FIXTURE-PLAN.md';
  const text = [
    '---',
    'phase: 99',
    'plan: 1',
    '---',
    '',
    '## Goal',
    '',
    'Fixture plan for plan-delivery unit tests.',
    '',
    '## Context (Reads)',
    '',
    FIXTURE_CONTEXT_LINES,
    ...extraLines,
    '',
    '## Scope',
    '',
    'Fixture body.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projectRoot, planRel), text);
  fs.mkdirSync(path.join(projectRoot, '.planning', 'architecture'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.planning', 'architecture', 'ADR-019-pipeline-subscription-efficiency.md'), 'adr content\n',
  );
  fs.writeFileSync(path.join(phaseDir, '40-RESEARCH.md'), 'research 40 content\n');
  fs.writeFileSync(path.join(phaseDir, '41-RESEARCH.md'), 'research 41 content\n');
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), 'context content\n');
  return { planRel, phaseDir };
}

test('delivers the ADR and bare phase files from 40-15/41-01 Context lines; reports the graph as machine-state', () => {
  const root = tempDir('shipyard-plan-delivery-fixture-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const { planRel } = fixturePlan(projectRoot);
    const outsideWorktree = path.join(root, 'unrelated-ticket-worktree');
    const result = deliverPlan({ graphDir, row: { plan: planRel }, worktree: outsideWorktree });
    assert.equal(result.mode, 'delivered');
    assert.equal(result.plan.path, planRel);
    assert.equal(result.plan.sha256, crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(projectRoot, planRel))).digest('hex'));
    const delivered = result.files.map((f) => f.path);
    assert.deepEqual(delivered, [
      '.planning/phases/fixture-phase/40-RESEARCH.md',
      '.planning/architecture/ADR-019-pipeline-subscription-efficiency.md',
      '.planning/phases/fixture-phase/41-RESEARCH.md',
      '.planning/phases/fixture-phase/CONTEXT.md',
    ]);
    for (const file of result.files) {
      assert.equal(file.sha256, crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(projectRoot, file.path))).digest('hex'));
    }
    const reasons = Object.fromEntries(result.not_delivered.map((n) => [n.path, n.reason]));
    assert.equal(reasons['.planning/graph/tickets.json'], 'machine-state');
    assert.equal(reasons['.planning/phases/fixture-phase/NOPE.md'], 'missing');
    assert.equal(reasons['.planning/phases/<phase-dir>/<NN>-RESEARCH.md'], 'placeholder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an oversized optional file and a total-budget overflow both land in not_delivered, never refusing the launch', () => {
  const root = tempDir('shipyard-plan-delivery-budget-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const phaseDir = path.join(projectRoot, '.planning', 'phases', 'budget-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    const planRel = '.planning/phases/budget-phase/FIXTURE-PLAN.md';
    fs.writeFileSync(path.join(phaseDir, 'BIG.md'), 'x'.repeat(MAX_REFERENCE_BYTES + 1));
    const chunk = 60000;
    assert.ok(chunk < MAX_REFERENCE_BYTES && chunk * 5 > MAX_TOTAL_BYTES && chunk * 4 <= MAX_TOTAL_BYTES);
    const names = ['A.md', 'B.md', 'C.md', 'D.md', 'E.md'];
    for (const name of names) fs.writeFileSync(path.join(phaseDir, name), 'a'.repeat(chunk));
    fs.writeFileSync(path.join(projectRoot, planRel), [
      '## Context (Reads)',
      '',
      '- `.planning/phases/budget-phase/BIG.md`.',
      ...names.map((name) => `- \`.planning/phases/budget-phase/${name}\`.`),
      '',
      '## Scope',
      'body',
      '',
    ].join('\n'));
    const result = deliverPlan({ graphDir, row: { plan: planRel }, worktree: path.join(root, 'unrelated') });
    assert.equal(result.mode, 'delivered');
    const reasons = Object.fromEntries(result.not_delivered.map((n) => [n.path, n.reason]));
    assert.equal(reasons['.planning/phases/budget-phase/BIG.md'], 'too-large');
    assert.equal(reasons['.planning/phases/budget-phase/E.md'], 'budget-exceeded');
    assert.ok(result.files.some((f) => f.path === '.planning/phases/budget-phase/A.md'));
    assert.ok(result.files.some((f) => f.path === '.planning/phases/budget-phase/D.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing plan refuses PLAN_UNDELIVERABLE', () => {
  const root = tempDir('shipyard-plan-delivery-missing-plan-');
  try {
    const { graphDir } = projectFixture(root);
    assert.equal(code(() => deliverPlan({
      graphDir, row: { plan: '.planning/phases/x/MISSING-PLAN.md' }, worktree: path.join(root, 'unrelated'),
    })), 'PLAN_UNDELIVERABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty plan refuses PLAN_UNDELIVERABLE', () => {
  const root = tempDir('shipyard-plan-delivery-empty-plan-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const planRel = '.planning/phases/x/EMPTY-PLAN.md';
    fs.mkdirSync(path.dirname(path.join(projectRoot, planRel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, planRel), '   \n');
    assert.equal(code(() => deliverPlan({ graphDir, row: { plan: planRel }, worktree: path.join(root, 'unrelated') })),
      'PLAN_UNDELIVERABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an oversized plan refuses PLAN_UNDELIVERABLE', () => {
  const root = tempDir('shipyard-plan-delivery-big-plan-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const planRel = '.planning/phases/x/BIG-PLAN.md';
    fs.mkdirSync(path.dirname(path.join(projectRoot, planRel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, planRel), 'x'.repeat(MAX_REFERENCE_BYTES + 1));
    assert.equal(code(() => deliverPlan({ graphDir, row: { plan: planRel }, worktree: path.join(root, 'unrelated') })),
      'PLAN_UNDELIVERABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-UTF-8 plan refuses PLAN_UNDELIVERABLE', () => {
  const root = tempDir('shipyard-plan-delivery-binary-plan-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const planRel = '.planning/phases/x/BINARY-PLAN.md';
    fs.mkdirSync(path.dirname(path.join(projectRoot, planRel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, planRel), Buffer.from([0xff, 0xfe, 0x00, 0xff]));
    assert.equal(code(() => deliverPlan({ graphDir, row: { plan: planRel }, worktree: path.join(root, 'unrelated') })),
      'PLAN_UNDELIVERABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a wrong expected digest refuses PLAN_DIGEST_MISMATCH', () => {
  const root = tempDir('shipyard-plan-delivery-mismatch-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const { planRel } = fixturePlan(projectRoot);
    assert.equal(code(() => deliverPlan({
      graphDir, row: { plan: planRel }, worktree: path.join(root, 'unrelated'), expectedSha256: '0'.repeat(64),
    })), 'PLAN_DIGEST_MISMATCH');
    const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(projectRoot, planRel))).digest('hex');
    const result = deliverPlan({
      graphDir, row: { plan: planRel }, worktree: path.join(root, 'unrelated'), expectedSha256: real,
    });
    assert.equal(result.mode, 'delivered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plan inside the worktree returns in-worktree and changes nothing', () => {
  const root = tempDir('shipyard-plan-delivery-inworktree-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const { planRel } = fixturePlan(projectRoot);
    const result = deliverPlan({ graphDir, row: { plan: planRel }, worktree: projectRoot });
    assert.deepEqual(result, { mode: 'in-worktree' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no worktree argument always reads and delivers the plan', () => {
  const root = tempDir('shipyard-plan-delivery-noworktree-');
  try {
    const { projectRoot, graphDir } = projectFixture(root);
    const { planRel } = fixturePlan(projectRoot);
    const result = deliverPlan({ graphDir, row: { plan: planRel } });
    assert.equal(result.mode, 'delivered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an absolute or traversing plan path refuses PLAN_UNDELIVERABLE before any read', () => {
  const root = tempDir('shipyard-plan-delivery-badpath-');
  try {
    const { graphDir } = projectFixture(root);
    assert.equal(code(() => deliverPlan({ graphDir, row: { plan: '/etc/passwd' } })), 'PLAN_UNDELIVERABLE');
    assert.equal(code(() => deliverPlan({ graphDir, row: { plan: '../outside/PLAN.md' } })), 'PLAN_UNDELIVERABLE');
    assert.equal(code(() => deliverPlan({ graphDir, row: {} })), 'PLAN_UNDELIVERABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done();
