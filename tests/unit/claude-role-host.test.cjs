'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createClaudeRoleHost, parseCli, parseRequest, REQUEST_SCHEMA } = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');

const POLICY_MD = '# ADR-014 test\nExplicit model and effort are required.\n';
const PHASE = '38-role-host-test';
const TICKET = 'T-38-01-role-host';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function planText() {
  return [
    '---', 'phase: 38', 'plan: 01', `title: ${JSON.stringify('Test role host')}`, '---', '',
    '## Acceptance criteria', '- host authenticates each role result', '',
    '## Verification commands', '- node --test tests/unit/claude-role-host.test.cjs', '',
  ].join('\n');
}

function setupRepository(kind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-role-')));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-role-state-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Shipyard Test']);
  git(root, ['config', 'user.email', 'shipyard-test@example.invalid']);
  const planPath = `.planning/phases/${PHASE}/38-01-PLAN.md`;
  const branch = kind === 'arch-review' ? `ticket/${TICKET}` : `epic/${PHASE}`;
  const ticketBranch = `ticket/${TICKET}`;
  const row = {
    title: 'Test role host', plan: planPath, phase: '38', repo: null, wave: 1,
    depends_on: [], cross_phase_deps: [], cross_repo_deps: [], files: ['src/role.txt'],
    risk: 'high', type: 'implementation', human_checkpoint: true, branch,
    pr_base: kind === 'integrator' ? branch : 'main', epic: kind === 'integrator' ? branch : null,
  };
  if (kind === 'integrator') row.branch = ticketBranch;
  write(root, '.planning/architecture/ADR-014-test.md', POLICY_MD);
  write(root, planPath, planText());
  write(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
  write(root, '.planning/graph/tickets.json', JSON.stringify({ tickets: { [TICKET]: row } }));
  write(root, '.planning/graph/delivery-state.json', JSON.stringify({
    [TICKET]: { status: kind === 'integrator' ? 'merged' : 'pr-open', pr: 101, branch, base: kind === 'integrator' ? branch : 'main' },
  }));
  write(root, 'src/role.txt', 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'chore: seed test repository']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  git(root, ['checkout', '-b', branch]);
  write(root, 'src/role.txt', 'reviewed change\n');
  git(root, ['add', 'src/role.txt']);
  git(root, ['commit', '-m', 'feat: change role source']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const headTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (kind === 'integrator') {
    git(root, ['branch', ticketBranch, head]);
    git(root, ['update-ref', `refs/remotes/origin/${ticketBranch}`, head]);
  } else {
    git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  }
  if (kind === 'integrator') git(root, ['update-ref', `refs/remotes/origin/${branch}`, head]);
  const mergeBase = kind === 'arch-review' ? base : git(root, ['merge-base', 'main', head]);
  const mergeBaseTree = git(root, ['rev-parse', `${mergeBase}^{tree}`]);
  return { root, storageRoot, branch, base, baseTree, head, headTree, mergeBase, mergeBaseTree, planPath, kind };
}

function livePr(fixture) {
  return {
    number: 101,
    state: fixture.kind === 'integrator' ? 'MERGED' : 'OPEN',
    isDraft: false,
    headRefName: fixture.kind === 'integrator' ? `ticket/${TICKET}` : fixture.branch,
    headRefOid: fixture.head,
    baseRefName: fixture.kind === 'integrator' ? fixture.branch : 'main',
    baseRefOid: fixture.kind === 'integrator' ? fixture.head : fixture.base,
    mergedAt: fixture.kind === 'integrator' ? '2026-09-23T12:00:00Z' : null,
    mergeCommit: fixture.kind === 'integrator' ? { oid: fixture.head } : null,
    reviewDecision: null,
  };
}

function packetFromPrompt(prompt) {
  const startTag = '<AUTHENTICATED_CONTEXT_PACKET>\n\n';
  const endTag = '\n\n</AUTHENTICATED_CONTEXT_PACKET>';
  const start = prompt.indexOf(startTag);
  const end = prompt.indexOf(endTag, start + startTag.length);
  assert.ok(start >= 0 && end > start);
  return JSON.parse(prompt.slice(start + startTag.length, end));
}

function fakeEvidence(model, effort) {
  const sessionId = `session-${crypto.randomUUID()}`;
  const transcript = { path: path.join(os.tmpdir(), `${sessionId}.jsonl`), bytes: 64, sha256: 'a'.repeat(64) };
  return {
    launch_id: `claude-${sessionId}`,
    session_id: sessionId,
    process_id: process.pid,
    runtime_version: '2.1.280',
    applied_model: model,
    applied_effort: effort,
    observed_model: model,
    observed_effort: effort,
    selection_evidence: { source: 'claude-session-assistant-transcript', session_id: sessionId,
      assistant_records: 1, model, effort, transcript },
    stream_evidence: { format: 'stream-json', records: 1, assistant_messages: 1 },
    transcript,
  };
}

function fakeRuntimeFactory(fixture, options = {}) {
  const live = livePr(fixture);
  return ({ scope, controller, recorderDir }) => {
    const recorder = createDurableRecorder(recorderDir);
    const runtime = {
      scope: { worktree: scope.worktree.path },
      controller,
      recorder,
      capabilities: {
        supportedModels: ['claude-opus-5-5', 'claude-fable-5'],
        supportedEfforts: ['low', 'medium', 'high', 'max'],
        observedModel: true,
        observedEffort: true,
      },
      async agent(prompt, selection) {
        options.onLaunch?.(prompt, selection);
        const packet = packetFromPrompt(prompt);
        const context = packet.role_context;
        let result;
        let evidencePath;
        if (packet.role === 'arch-review') {
          result = { id: TICKET, pr: live.number, verdict: 'conform', head: fixture.head,
            base_tree: fixture.mergeBaseTree, blocking_count: 0, summary: 'No architecture conflict.', findings: [] };
          evidencePath = path.join(fixture.root, '.shipyard-arch-review-evidence.md');
          fs.writeFileSync(evidencePath, `Reviewed ${fixture.head}; base tree ${fixture.mergeBaseTree}.\n`);
        } else {
          const ticketSet = context.ticket_set;
          const defaultTree = context.integration_base.tree;
          result = { outcome: 'passed', phase: context.phase, head: fixture.head, head_tree: fixture.headTree,
            base: context.integration_base.ref, base_tree: defaultTree,
            ticket_set: ticketSet, ticket_set_digest: context.ticket_set_digest,
            blocking_count: 0, summary: 'Phase is coherent.', findings: [] };
          evidencePath = path.join(fixture.root, `.planning/phases/${context.phase}/INTEGRATION.md`);
          fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
          fs.writeFileSync(evidencePath, `Integration check at ${fixture.head}.\n`);
        }
        const applicationEvidence = options.badEvidence ? fakeEvidence(selection.model, 'low') : fakeEvidence(selection.model, selection.effort);
        return { output: result, applicationEvidence };
      },
      applicationEvidence({ result }) { return result.applicationEvidence; },
    };
    return runtime;
  };
}

function hostOptions(fixture, extra = {}) {
  const pr = livePr(fixture);
  return {
    storageRoot: fixture.storageRoot,
    refreshGit: false,
    defaultBranch: 'main',
    listPullRequests({ branch, state }) {
      if (fixture.kind === 'arch-review') return state === 'open' && branch === fixture.branch ? [pr] : [];
    return state === 'closed' && branch === `ticket/${TICKET}` ? [pr] : [];
    },
    getPullRequest() { return pr; },
    createRuntimeHost: fakeRuntimeFactory(fixture, extra),
  };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.storageRoot, { recursive: true, force: true });
}

function request(fixture) {
  return fixture.kind === 'arch-review'
    ? { schema: REQUEST_SCHEMA, role: 'arch-review', worktree: fixture.root, ticket: TICKET, pr: 101 }
    : { schema: REQUEST_SCHEMA, role: 'integrator', worktree: fixture.root, phase: PHASE };
}

test('request contract accepts only host-owned role selectors and capability probe arguments', async () => {
  const fixture = setupRepository('arch-review');
  try {
    assert.equal(parseRequest(request(fixture)).role, 'arch-review');
    assert.throws(() => parseRequest({ ...request(fixture), model: 'claude-opus-5-5' }), /field model is not permitted/);
    assert.throws(() => parseRequest({ ...request(fixture), promptPath: '/tmp/prompt.md' }), /field promptPath is not permitted/);
    assert.throws(() => parseRequest({ ...request(fixture), signals: { inputTokens: 1 } }), /host-derived or unsupported/);
    await assert.rejects(createClaudeRoleHost(hostOptions(fixture)).run({ ...request(fixture), signals: { checkpoint: false } }), /differs from authenticated/);
    assert.throws(() => parseCli(['--args-file', 'args.json', '--capability-only']), /either --capability-only or --args-file/);
  } finally {
    cleanupFixture(fixture);
  }
});

test('arch-review launches through ADR-014 and seals only the matching PR judgment', async () => {
  const fixture = setupRepository('arch-review');
  let launched;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched.prompt);
    assert.equal(launched.selection.model, 'claude-opus-5-5');
    assert.equal(launched.selection.effort, 'max');
    assert.equal(packet.role_context.exact_diff.head, fixture.head);
    assert.equal(packet.role_context.exact_diff.base_tree, fixture.mergeBaseTree);
    assert.ok(packet.required_refs.some((ref) => ref.path === '.planning/architecture/ADR-014-test.md' && ref.content === POLICY_MD));
    assert.equal(launched.prompt.includes(path.resolve(__dirname, '../../plugins/delivery-pipeline')), false);
    assert.equal(result.dispatch.trace.at(-1).stage, 'receipt');
    assert.equal(result.artifact.outcome, 'conform');
    assert.equal(fs.existsSync(result.artifact.ref), true);
    const manifest = JSON.parse(fs.readFileSync(result.artifact.ref, 'utf8'));
    assert.equal(manifest.role, 'arch-review');
    assert.equal(manifest.producer_dispatch, result.dispatch.receipt.dispatch_id);
  } finally {
    cleanupFixture(fixture);
  }
});

test('integrator authenticates the merged ticket set and seals phase evidence', async () => {
  const fixture = setupRepository('integrator');
  let launched;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched.prompt);
    assert.equal(launched.selection.model, 'claude-opus-5-5');
    assert.equal(launched.selection.effort, 'high');
    assert.equal(packet.role_context.phase, PHASE);
    assert.deepEqual(packet.role_context.ticket_set.map((item) => item.id), [TICKET]);
    assert.equal(packet.role_context.combined_diff.head, fixture.head);
    assert.equal(result.artifact.outcome, 'passed');
    assert.equal(result.ticket_set_digest, packet.role_context.ticket_set_digest);
    assert.equal(fs.existsSync(path.join(fixture.root, `.planning/phases/${PHASE}/INTEGRATION.md`)), true);
  } finally {
    cleanupFixture(fixture);
  }
});

test('missing or contradictory application evidence refuses before artifact acceptance', async () => {
  const fixture = setupRepository('arch-review');
  try {
    await assert.rejects(createClaudeRoleHost(hostOptions(fixture, { badEvidence: true })).run(request(fixture)), /observed_effort|effort/);
    assert.equal(fs.existsSync(path.join(fixture.root, '.shipyard-role-artifacts')), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('integrator refuses a merged ticket PR absent from the combined worktree', async () => {
  const fixture = setupRepository('integrator');
  try {
    const options = hostOptions(fixture);
    const original = options.getPullRequest;
    options.getPullRequest = () => ({ ...original(), mergeCommit: { oid: 'f'.repeat(40) } });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), /not included in the integrator worktree/);
  } finally {
    cleanupFixture(fixture);
  }
});

test('integrator refuses a stale local base when refreshing origin fails', async () => {
  const fixture = setupRepository('integrator');
  try {
    git(fixture.root, ['remote', 'add', 'origin', path.join(fixture.root, 'missing-remote.git')]);
    const options = hostOptions(fixture);
    options.refreshGit = true;
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), /cannot refresh live base branch/);
  } finally {
    cleanupFixture(fixture);
  }
});

test('arch-review refuses an out-of-scope filename with leading whitespace', async () => {
  const fixture = setupRepository('arch-review');
  try {
    const options = hostOptions(fixture, {
      onLaunch() { fs.writeFileSync(path.join(fixture.root, ' .shipyard-arch-review-evidence.md'), 'out of scope\n'); },
    });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), /changed paths outside its evidence file/);
  } finally {
    cleanupFixture(fixture);
  }
});
