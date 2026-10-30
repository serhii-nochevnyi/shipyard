'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PHASE, TICKET, git, write, setupRepository, livePr, hostOptions, cleanupFixture, request, packetFromPrompt,
  integratorFixture, commit, withPrs, manyTicketFixture, stackedFixture } = require('./helpers/claude-role-fixtures.cjs');
const { createClaudeRoleHost, parseRequest, prepareIntegratorContext, revalidateIntegrator, REQUEST_SCHEMA } = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');

const SPLIT_PATHS = [['src/a/one.txt', 'src/b/two.txt'], ['src/c/three.txt', 'src/role.txt']];

async function runIntegrator(fixture, extra = {}, partBudget) {
  const options = { ...hostOptions(fixture, extra), ...(partBudget ? { partBudget } : {}) };
  const factory = options.createRuntimeHost;
  options.createRuntimeHost = input => { const runtime = factory(input); fixture.lastRecorder = runtime.recorder; return runtime; };
  return createClaudeRoleHost(options).run(request(fixture));
}

test('integrator reads the diff through git in one session and the host writes the evidence', async () => {
  const fixture = integratorFixture();
  const launches = [];
  try {
    const result = await runIntegrator(fixture, { onLaunch(prompt, selection) { launches.push({ prompt, selection }); } });
    assert.equal(launches.length, 1);
    const context = packetFromPrompt(launches[0].prompt).role_context;
    
    assert.equal(context.combined_diff.content, undefined);
    assert.deepEqual(context.change_metadata.changes.map(change => change.paths).flat(), ['src/role.txt']);
    assert.match(launches[0].prompt, /git diff [0-9a-f]{40}\.\.\.[0-9a-f]{40} -- <path>/);
    assert.equal(result.artifact.outcome, 'passed');
    assert.equal(result.parts, undefined);
    assert.equal(fs.readFileSync(path.join(fixture.root, `.planning/phases/${PHASE}/INTEGRATION.md`), 'utf8'), `Integration check at ${fixture.head}.\n`);
    assert.deepEqual(context.ticket_set.map(item => item.id), [TICKET]);
  } finally { cleanupFixture(fixture); }
});

const FILES = ['src/a/one.txt', 'src/b/two.txt', 'src/c/three.txt'];

test('integrator splits a large diff into path-group parts and a fresh final owns the verdict', async () => {
  const fixture = integratorFixture({ files: FILES });
  const contexts = [];
  try {
    const result = await runIntegrator(fixture, { onLaunch(prompt) { contexts.push(packetFromPrompt(prompt).role_context); } }, 5);
    assert.equal(contexts.length, 3);
    assert.deepEqual(contexts.slice(0, 2).map(context => context.part.paths), SPLIT_PATHS);
    assert.ok(contexts.slice(0, 2).every(context => context.parts === undefined && context.combined_diff.content === undefined));
    const final = contexts[2];
    assert.equal(final.part, undefined);
    assert.deepEqual(final.parts.map(part => part.paths), SPLIT_PATHS);
    const ids = final.parts.map(part => part.dispatch_id);
    assert.ok(new Set(ids).size === 2 && !ids.includes(result.dispatch.receipt.dispatch_id), 'the final is its own launch');
    assert.deepEqual(result.parts.map(part => part.dispatch_id), ids);
    assert.equal(result.artifact.outcome, 'passed');
    assert.equal(fs.readFileSync(path.join(fixture.root, `.planning/phases/${PHASE}/INTEGRATION.md`), 'utf8'), `Integration check at ${fixture.head}.\n`);
  } finally { cleanupFixture(fixture); }
});

test('integrator cannot pass over an incomplete part', async () => {
  const fixture = integratorFixture({ files: FILES });
  try {
    await assert.rejects(runIntegrator(fixture, { mutateResult(result, packet) {
      if (packet.role_context.part?.ordinal === 2) Object.assign(result, { review_completeness: 'incomplete', limitations: ['src/c/three.txt was unreadable'] });
    } }, 5), { code: 'INVALID_RESULT' });
  } finally { cleanupFixture(fixture); }
});

const BLOCKER = { id: 'F-1', type: 'fix-ticket', blocking: true, summary: 'The seam loses an update.',
  fix_ticket: { title: 'Keep updates', scope: 'Persist first.', files: ['src/a/one.txt'] } };

function blockerScenario(final) {
  return { mutateResult(result, packet) {
    const context = packet.role_context;
    if (context.part?.ordinal === 1) result.findings = [BLOCKER];
    if (!context.part) final(result, context.parts[0].findings[0].ref);
  } };
}

test('a part blocker needs one justified disposition from the final', async () => {
  const fixture = integratorFixture({ files: FILES });
  try {
    await assert.rejects(runIntegrator(fixture, blockerScenario(() => {}), 5), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  } finally { cleanupFixture(fixture); }
});

test('a justified resolved disposition lets the final pass; an unresolved one needs a blocking finding', async () => {
  const fixture = integratorFixture({ files: FILES });
  try {
    const result = await runIntegrator(fixture, blockerScenario((final, ref) => {
      final.dispositions = [{ ref, disposition: 'resolved', justification: 'git show confirms the update is persisted first' }];
    }), 5);
    assert.equal(result.artifact.outcome, 'passed');
  } finally { cleanupFixture(fixture); }
  const other = integratorFixture({ files: FILES });
  try {
    await assert.rejects(runIntegrator(other, blockerScenario((final, ref) => {
      final.dispositions = [{ ref, disposition: 'unresolved', justification: 'still racy' }];
    }), 5), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  } finally { cleanupFixture(other); }
  const third = integratorFixture({ files: FILES });
  try {
    const result = await runIntegrator(third, blockerScenario((final, ref) => {
      Object.assign(final, { outcome: 'needs-fix', blocking_count: 1, findings: [BLOCKER],
        dispositions: [{ ref, disposition: 'unresolved', justification: 'still racy' }] });
    }), 5);
    assert.equal(result.artifact.outcome, 'needs-fix');
  } finally { cleanupFixture(third); }
});

async function runWith(fixture, prs, extra = {}, partBudget) {
  const options = withPrs({ ...hostOptions(fixture, extra), ...(partBudget ? { partBudget } : {}) }, prs);
  return createClaudeRoleHost(options).run(request(fixture));
}

test('a stacked ticket merged into its parent branch counts as included through the parent', async () => {
  const { fixture, prs } = stackedFixture();
  try {
    assert.equal((await runWith(fixture, prs)).artifact.outcome, 'passed');
  } finally { cleanupFixture(fixture); }
});

test('a merge commit that no head contains is refused before any launch', async () => {
  for (const build of [stackedFixture, () => manyTicketFixture(2)]) {
    const { fixture, prs } = build();
    let launches = 0;
    try {
      const tree = git(fixture.root, ['rev-parse', 'HEAD^{tree}']);
      const orphan = git(fixture.root, ['commit-tree', tree, '-m', 'unreachable']);
      prs.at(-1).mergeCommit = { oid: orphan };
      await assert.rejects(runWith(fixture, prs, { onLaunch() { launches++; } }), /merged PR \d+ is not included/);
      assert.equal(launches, 0);
    } finally { cleanupFixture(fixture); }
  }
});

test('37 tickets with a large path inventory fit one session; past the bound the host refuses with zero launches', async () => {
  const fits = manyTicketFixture(37, 1500);
  let launched;
  try {
    const result = await runWith(fits.fixture, fits.prs, { onLaunch(prompt) { launched = packetFromPrompt(prompt).role_context; } });
    assert.equal(result.artifact.outcome, 'passed');
    assert.equal(launched.ticket_set.length, 37);
    assert.equal(launched.change_metadata.changes.length, 36 + 1500 + 1);
  } finally { cleanupFixture(fits.fixture); }
  const over = manyTicketFixture(37, 16500);
  let launches = 0;
  try {
    await assert.rejects(runWith(over.fixture, over.prs, { onLaunch() { launches++; } }), { code: 'CONTEXT_PACKET_OVER_BOUND' });
    assert.equal(launches, 0);
  } finally { cleanupFixture(over.fixture); }
});

test('a final that would not fit after the parts refuses before any part launches', async () => {
  const { fixture, prs } = manyTicketFixture(37, 12000);
  let launches = 0;
  try {
    await assert.rejects(runWith(fixture, prs, { onLaunch() { launches++; } }, 4000), { code: 'CONTEXT_PACKET_OVER_BOUND' });
    assert.equal(launches, 0);
  } finally { cleanupFixture(fixture); }
});

function lowRiskFixture(sourceContent) {
  const fixture = setupRepository('integrator', { sourceContent });
  const file = path.join(fixture.root, '.planning/graph/tickets.json'), graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(graph.tickets[TICKET], { risk: 'low', human_checkpoint: false, critical: false });
  write(fixture.root, '.planning/graph/tickets.json', JSON.stringify(graph));
  fixture.head = commit(fixture, 'chore: low risk row');
  git(fixture.root, ['update-ref', `refs/remotes/origin/${fixture.branch}`, fixture.head]);
  return fixture;
}

test('the diff size the integrator reads through git still reaches the measured-window rung', async () => {
  const bulk = Array.from({ length: 14000 }, (_, index) => `${String(index).padStart(8, '0')} ${'x'.repeat(70)}\n`).join('');
  const selections = [];
  for (const source of ['small\n', bulk]) {
    const fixture = lowRiskFixture(source);
    try {
      await createClaudeRoleHost(hostOptions(fixture, { onLaunch(prompt, selection) { selections.push({ prompt, selection }); } })).run(request(fixture));
    } finally { cleanupFixture(fixture); }
  }
  assert.deepEqual(selections.map(item => [item.selection.model, item.selection.effort]),
    [['claude-sonnet-5-5', 'xhigh'], ['claude-opus-5-5', 'high']]);
  assert.ok(Buffer.byteLength(selections[1].prompt) < 400000, 'the prompt still carries no diff');
});

test('a phase with no product change against the default branch is refused as empty', async () => {
  const fixture = setupRepository('integrator', { sourceContent: 'base\n', planningBytes: 10 });
  let launches = 0;
  try {
    await assert.rejects(createClaudeRoleHost(hostOptions(fixture, { onLaunch() { launches++; } })).run(request(fixture)), { code: 'INTEGRATION_EMPTY' });
    assert.equal(launches, 0);
  } finally { cleanupFixture(fixture); }
});

test('the integrator launch is sandboxed to read git: no write into the worktree or the common dir, no evidence file', async (t) => {
  const fixture = integratorFixture({ files: FILES });
  const spawns = [], launched = [];
  try {
    t.mock.method(require('node:child_process'), 'spawn', (_executable, args) => { launched.push(args); return {}; });
    const options = withPrs(hostOptions(fixture), [livePr(fixture)]);
    options.partBudget = 5;
    const factory = options.createRuntimeHost;
    options.createRuntimeHost = input => { spawns.push(input.spawn); return factory(input); };
    await createClaudeRoleHost(options).run(request(fixture));
    const original = { sandbox: { filesystem: { allowWrite: [fixture.root], denyRead: ['/authority'], denyWrite: ['/authority'] } },
      permissions: { allow: [] } };
    for (const spawn of spawns)
      spawn('claude-fixture', ['--tools', 'Bash,Read,Edit,Write,Glob,Grep', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep',
        '--settings', JSON.stringify(original)], {});
    assert.equal(launched.length, 3);
    for (const args of launched) {
      const value = flag => args[args.indexOf(flag) + 1], settings = JSON.parse(value('--settings'));
      assert.deepEqual(settings.sandbox.filesystem.allowWrite, []);
      assert.deepEqual(settings.permissions.allow, []);
      assert.deepEqual(settings.sandbox.filesystem.denyWrite, ['/authority', fixture.root, require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(fixture.root)]);
      assert.equal(value('--allowedTools'), 'Bash,Read,Glob,Grep');
    }
  } finally { cleanupFixture(fixture); }
});

test('the integrator request carries no review_contract selector', () => {
  const base = { schema: REQUEST_SCHEMA, role: 'integrator', worktree: process.cwd(), phase: PHASE };
  for (const value of ['shipyard.integration-review.v1', 'shipyard.integration-review.v3'])
    assert.throws(() => parseRequest({ ...base, review_contract: value }), /request field review_contract is not permitted/);
});

test('an integrator part that writes an untracked file is refused and no further session launches', async () => {
  const fixture = integratorFixture({ files: FILES });
  let launches = 0;
  try {
    await assert.rejects(runIntegrator(fixture, { onLaunch() { launches++; write(fixture.root, 'src/rogue.txt', 'x\n'); } }, 5), { code: 'WORKTREE_MUTATED' });
    assert.equal(launches, 1);
  } finally { cleanupFixture(fixture); }
});

test('an integrator head that moves while its parts run is refused and launches no final', async () => {
  const fixture = integratorFixture({ files: FILES });
  let launches = 0;
  try {
    await assert.rejects(runIntegrator(fixture, { onLaunch() {
      if (++launches === 2) { write(fixture.root, 'src/b/two.txt', 'moved\n'); commit(fixture, 'feat: moved head'); }
    } }, 5), { code: 'STALE_CONTEXT' });
    assert.equal(launches, 2);
  } finally { cleanupFixture(fixture); }
});

test('a part finding without a boolean blocking flag is refused', async () => {
  const fixture = integratorFixture({ files: FILES });
  try {
    await assert.rejects(runIntegrator(fixture, { mutateResult(result, packet) {
      if (packet.role_context.part?.ordinal === 1) result.findings = [{ id: 'F-1', type: 'fix-ticket', severity: 'BLOCKER', summary: 'unflagged blocker' }];
    } }, 5), { code: 'INVALID_RESULT' });
  } finally { cleanupFixture(fixture); }
});

test('the shared integrator freshness check refuses a moved head, default base, merged PR and membership', () => {
  const fixture = integratorFixture();
  try {
    const options = hostOptions(fixture), prepared = prepareIntegratorContext(options, { worktree: fixture.root, phase: PHASE });
    revalidateIntegrator(options, prepared);
    const merged = livePr(fixture), drifted = { ...merged, mergedAt: '2026-09-24T12:00:00Z' };
    assert.throws(() => revalidateIntegrator({ ...options, getPullRequest: () => drifted }, prepared), { code: 'STALE_CONTEXT' });
    revalidateIntegrator({ ...options, getPullRequest: () => drifted }, prepared, false);
    const graphFile = path.join(fixture.root, '.planning/graph/tickets.json'), graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    fs.writeFileSync(graphFile, JSON.stringify({ tickets: { ...graph.tickets, 'T-38-09-extra': { ...graph.tickets[TICKET] } } }));
    assert.throws(() => revalidateIntegrator(options, prepared, false), { code: 'STALE_CONTEXT' });
    fs.writeFileSync(graphFile, JSON.stringify(graph));
    git(fixture.root, ['update-ref', 'refs/remotes/origin/main', fixture.head]);
    assert.throws(() => revalidateIntegrator(options, prepared), { code: 'STALE_CONTEXT' });
    git(fixture.root, ['update-ref', 'refs/remotes/origin/main', fixture.base]);
    write(fixture.root, 'src/role.txt', 'moved\n');
    commit(fixture, 'feat: moved head');
    assert.throws(() => revalidateIntegrator(options, prepared, false), { code: 'STALE_CONTEXT' });
  } finally { cleanupFixture(fixture); }
});
