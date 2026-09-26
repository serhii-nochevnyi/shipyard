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
const { activeDispatches } = require('../../plugins/delivery-pipeline/scripts/dispatch-record.cjs');
const { agentsInFlight } = require('../../plugins/delivery-pipeline/scripts/front.cjs');
const { loadClaudeReferenceContent } = require('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs');

const POLICY_MD = '# ADR-014 test\nExplicit model and effort are required.\n';
const PHASE = '38-role-host-test';
const TICKET = 'T-38-01-role-host';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fileSha(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', '..', relative))).digest('hex');
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function planText(extra = []) {
  return [
    '---', 'phase: 38', 'plan: 01', `title: ${JSON.stringify('Test role host')}`, '---', '',
    '## Context', '- Follows ADR-014.', ...extra, '',
    '## Acceptance criteria', '- host authenticates each role result', '',
    '## Verification commands', '- node --test tests/unit/claude-role-host.test.cjs', '',
  ].join('\n');
}

function writeCorpus(root, { adrs = [], backlogFiles = [], investigations = [] } = {}) {
  for (const adr of adrs) write(root, `.planning/architecture/${adr.name}`, adr.content);
  for (const item of backlogFiles) write(root, `.planning/backlog/${item.name}`, item.content);
  for (const item of investigations) write(root, item.path, item.content);
}

function setupRepository(kind, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-role-')));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-role-state-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Shipyard Test']);
  git(root, ['config', 'user.email', 'shipyard-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
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
  write(root, planPath, planText(options.planExtra));
  write(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
  write(root, '.planning/graph/tickets.json', JSON.stringify({ tickets: { [TICKET]: row } }));
  write(root, '.planning/graph/delivery-state.json', JSON.stringify({
    [TICKET]: { status: kind === 'integrator' ? 'merged' : 'pr-open', pr: 101,
      branch: kind === 'integrator' ? ticketBranch : branch, base: kind === 'integrator' ? branch : 'main' },
  }));
  write(root, 'src/role.txt', 'base\n');
  if (options.corpus) writeCorpus(root, options.corpus);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'chore: seed test repository']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  git(root, ['checkout', '-b', branch]);
  write(root, 'src/role.txt', 'reviewed change\n');
  git(root, ['add', 'src/role.txt']);
  if (options.planningBytes) {
    write(root, `.planning/phases/${PHASE}/PROJECTION.md`, 'p'.repeat(options.planningBytes));
    git(root, ['add', '.planning']);
  }
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
  return { root, storageRoot, branch, ticketBranch, prBranch: ticketBranch, base, baseTree, head, headTree, mergeBase, mergeBaseTree, planPath, kind };
}

function livePr(fixture) {
  return {
    number: 101,
    state: fixture.kind === 'integrator' ? 'MERGED' : 'OPEN',
    isDraft: false,
    title: `feat(${TICKET}): change role source`,
    body: `Implements ${TICKET}.`,
    headRefName: fixture.kind === 'integrator' ? fixture.prBranch : fixture.branch,
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

function fakeEvidence(model, effort, usage) {
  const sessionId = `session-${crypto.randomUUID()}`;
  const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
  let transcript;
  if (usage) {
    const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`);
    const line = JSON.stringify({ type: 'assistant', sessionId,
      message: { role: 'assistant', id: 'm1', model: observedModel, usage, stop_reason: 'end_turn' } });
    fs.writeFileSync(transcriptPath, `${line}\n`);
    const buffer = fs.readFileSync(transcriptPath);
    transcript = { path: transcriptPath, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  } else {
    transcript = { path: path.join(os.tmpdir(), `${sessionId}.jsonl`), bytes: 64, sha256: 'a'.repeat(64) };
  }
  return {
    launch_id: `claude-${sessionId}`,
    session_id: sessionId,
    process_id: process.pid,
    runtime_version: '2.1.280',
    applied_model: model,
    applied_effort: effort,
    observed_model: observedModel,
    observed_effort: effort,
    selection_evidence: { source: 'claude-session-assistant-transcript', session_id: sessionId,
      assistant_records: 1, model: observedModel, effort, transcript },
    stream_evidence: { format: 'stream-json', records: 1, assistant_messages: 1 },
    transcript,
  };
}

function fakeEvidenceLines(model, effort, lines) {
  const sessionId = `session-${crypto.randomUUID()}`;
  const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
  const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`);
  const text = `${lines.map((line) => JSON.stringify({ sessionId, ...line })).join('\n')}\n`;
  fs.writeFileSync(transcriptPath, text);
  const buffer = fs.readFileSync(transcriptPath);
  const transcript = { path: transcriptPath, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  return {
    launch_id: `claude-${sessionId}`,
    session_id: sessionId,
    process_id: process.pid,
    runtime_version: '2.1.280',
    applied_model: model,
    applied_effort: effort,
    observed_model: observedModel,
    observed_effort: effort,
    selection_evidence: { source: 'claude-session-assistant-transcript', session_id: sessionId,
      assistant_records: lines.length, model: observedModel, effort, transcript },
    stream_evidence: { format: 'stream-json', records: lines.length, assistant_messages: lines.length },
    transcript,
  };
}

function fakeRuntimeFactory(fixture, options = {}) {
  const live = fixture.kind === 'pr-sentinel' ? null : livePr(fixture);
  return ({ scope, controller, recorderDir }) => {
    const recorder = createDurableRecorder(recorderDir);
    const runtime = {
      scope: { worktree: scope.worktree.path },
      controller,
      recorder,
      capabilities: {
        supportedModels: ['claude-opus-5-5', 'claude-fable-5', 'sonnet'],
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
        } else if (packet.role === 'pr-sentinel') {
          const ticketSet = context.ticket_set;
          const readOnlySmoke = selection.readOnly === true;
          result = {
            outcome: readOnlySmoke ? 'awaiting-human' : 'clear',
            ticket_set: ticketSet,
            ticket_set_digest: context.ticket_set_digest,
            head: fixture.head,
            head_tree: fixture.headTree,
            performed: readOnlySmoke ? [] : ticketSet.map((entry) => ({ ticket: entry.id, duty: 'check-current-front', status: 'complete' })),
            refused: readOnlySmoke ? ticketSet.map((entry) => ({ ticket: entry.id, duty: 'read-only-smoke',
              status: 'refused', reason: 'Read-only runtime smoke.' })) : [],
            blocking_count: readOnlySmoke ? ticketSet.length : 0,
            summary: readOnlySmoke ? 'Read-only runtime smoke; no PR duties were attempted.' : 'All guarded PRs are clear.',
          };
          evidencePath = path.join(fixture.root, '.shipyard-sentinel-evidence.md');
          fs.writeFileSync(evidencePath, `Checked ${ticketSet.length} guarded PRs for this round.\n`);
        } else {
          const ticketSet = context.ticket_set;
          const defaultTree = context.integration_base.tree;
          result = { outcome: 'passed', phase: context.phase, head: context.combined_diff.head,
            head_tree: context.combined_diff.head_tree,
            base: context.integration_base.ref, base_tree: defaultTree,
            ticket_set: ticketSet, ticket_set_digest: context.ticket_set_digest,
            blocking_count: 0, summary: 'Phase is coherent.', findings: [] };
          evidencePath = path.join(fixture.root, `.planning/phases/${context.phase}/INTEGRATION.md`);
          fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
          fs.writeFileSync(evidencePath, `Integration check at ${context.combined_diff.head}.\n`);
        }
        options.mutateResult?.(result, packet);
        const applicationEvidence = options.badEvidence ? fakeEvidence(selection.model, 'low')
          : options.firstResponseLines ? fakeEvidenceLines(selection.model, selection.effort, options.firstResponseLines)
          : fakeEvidence(selection.model, selection.effort, options.firstResponseUsage);
        if (options.corruptDigest && applicationEvidence.transcript) applicationEvidence.transcript.sha256 = 'b'.repeat(64);
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
      if (fixture.kind === 'pr-sentinel') {
        return state === 'open' ? fixture.sentinelPrs.filter((item) => item.headRefName === branch) : [];
      }
      if (fixture.kind === 'arch-review') return state === 'open' && branch === fixture.branch ? [pr] : [];
      return state === 'closed' && branch === fixture.prBranch ? [pr] : [];
    },
    getPullRequest(input = {}) {
      const number = input.pr;
      if (fixture.kind === 'pr-sentinel') return fixture.sentinelPrs.find((item) => item.number === number);
      return pr;
    },
    preflightRound({ projectWorktree, prs }) {
      const repos = [...new Set(prs.map((item) => item.repo || null))]
        .map((repo) => ({ repo, root: projectWorktree, base: null, base_oid: null }));
      return { repos, synced: true, committed: null };
    },
    createRuntimeHost: fakeRuntimeFactory(fixture, extra),
  };
}

function setupSentinelRepository(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-sentinel-')));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-sentinel-state-'));
  const phase = '38-sentinel-role-test';
  const ids = ['T-38-11-sentinel-a', 'T-38-12-sentinel-b'];
  const branches = ids.map((id) => `ticket/${id.toLowerCase()}`);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Shipyard Test']);
  git(root, ['config', 'user.email', 'shipyard-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  write(root, '.planning/architecture/ADR-014-test.md', POLICY_MD);
  write(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
  if (options.corpus) writeCorpus(root, options.corpus);
  const tickets = {};
  const state = {};
  const sentinelPrs = [];
  ids.forEach((id, index) => {
    const plan = `.planning/phases/${phase}/${id.slice(4, 6)}-PLAN.md`;
    write(root, plan, planText(options.planExtra));
    write(root, `src/${id}.txt`, `source ${index}\n`);
    const branch = branches[index];
    tickets[id] = { title: id, plan, phase: '38', repo: null, wave: 1, depends_on: [],
      files: [`src/${id}.txt`], risk: 'high', type: 'implementation', human_checkpoint: true, branch };
    const head = String(index + 1).repeat(40);
    state[id] = { status: 'pr-open', pr: 201 + index, branch, pr_base: 'main', head_sha: head };
    sentinelPrs.push({ number: 201 + index, state: 'OPEN', isDraft: false, headRefName: branch,
      headRefOid: head, baseRefName: 'main', baseRefOid: null, mergedAt: null, mergeCommit: null,
      reviewDecision: null });
  });
  write(root, '.planning/graph/tickets.json', JSON.stringify({ tickets }));
  write(root, '.planning/graph/delivery-state.json', JSON.stringify(state));
  write(root, 'src/role.txt', 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'chore: seed sentinel host repository']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  for (const pr of sentinelPrs) pr.baseRefOid = base;
  return { root, storageRoot, kind: 'pr-sentinel', phase, ids, branches,
    sentinelPrs, base, baseTree, head: base, headTree: baseTree };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.storageRoot, { recursive: true, force: true });
}

function request(fixture) {
  return fixture.kind === 'arch-review'
    ? { schema: REQUEST_SCHEMA, role: 'arch-review', worktree: fixture.root, ticket: TICKET, pr: 101 }
    : fixture.kind === 'pr-sentinel'
      ? { schema: REQUEST_SCHEMA, role: 'pr-sentinel', worktree: fixture.root, phase: fixture.phase }
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
    assert.equal(launched.selection.effort, 'high');
    assert.equal(launched.selection.schema.type, 'object');
    assert.deepEqual(launched.selection.schema.properties.pr, { type: 'integer', minimum: 1 });
    assert.deepEqual(launched.selection.schema.properties.blocking_count, { type: 'integer', minimum: 0 });
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

test('pr-sentinel derives and records one authenticated round for all live phase PRs', async () => {
  const fixture = setupSentinelRepository();
  let launched;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) {
        launched = { prompt, selection };
        const active = activeDispatches(fixture.root);
        assert.deepStrictEqual(Object.keys(active).sort(), fixture.ids);
        assert.equal(agentsInFlight(active), 1);
      },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched.prompt);
    assert.equal(launched.selection.model, 'sonnet');
    assert.equal(launched.selection.effort, 'high');
    assert.equal(packet.role_context.ticket_set.length, 2);
    assert.equal(result.subject, `round:${packet.role_context.ticket_set_digest}`);
    assert.equal(result.dispatch.trace.at(-1).stage, 'receipt');
    assert.equal(result.artifact.outcome, 'clear');
    assert.equal(result.round.agent_id, result.dispatch.receipt.launch_id);
    assert.deepStrictEqual(result.round.tickets, fixture.ids);
    const active = activeDispatches(fixture.root);
    assert.deepStrictEqual(Object.keys(active).sort(), fixture.ids);
    assert.equal(active[fixture.ids[0]].round_id, result.round.dispatch_id);
    assert.equal(active[fixture.ids[0]].agent_id, active[fixture.ids[1]].agent_id);
    assert.equal(agentsInFlight(active), 1);
    const store = JSON.parse(fs.readFileSync(path.join(fixture.root, '.planning/graph/dispatches.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(store.tickets || {}), []);
    assert.deepStrictEqual(Object.keys(store.rounds), [result.round.dispatch_id]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('pr-sentinel launch schema declares its identity fields', async () => {
  const fixture = setupSentinelRepository();
  let launched;
  try {
    await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const schema = launched.selection.schema;
    assert.ok(schema.required.includes('outcome'));
    assert.ok(schema.required.includes('head'));
    assert.ok(schema.required.includes('head_tree'));
    assert.deepEqual(schema.properties.ticket_set.items.required, ['id', 'pr', 'head', 'base', 'branch']);
    assert.equal(schema.properties.ticket_set.items.additionalProperties, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('a sentinel result echoing ticket_set as a string is refused with the named remedy', async () => {
  const fixture = setupSentinelRepository();
  try {
    const options = hostOptions(fixture, {
      mutateResult(result) { result.ticket_set = fixture.ids.join(' '); },
    });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), (error) =>
      error.code === 'INVALID_RESULT' && error.message.includes('ticket_set')
      && error.message.includes('remedy: copy role_context.ticket_set verbatim')
      && !error.message.includes('identity differs'));
  } finally {
    cleanupFixture(fixture);
  }
});

test('pr-sentinel expires a changed member while retaining the rest of the round', async () => {
  const fixture = setupSentinelRepository();
  try {
    const options = hostOptions(fixture, {
      onLaunch() { fixture.sentinelPrs[0].headRefOid = 'f'.repeat(40); },
    });
    const result = await createClaudeRoleHost(options).run(request(fixture));
    assert.deepStrictEqual(result.round.tickets, fixture.ids);
    const active = activeDispatches(fixture.root);
    assert.deepStrictEqual(Object.keys(active), [fixture.ids[1]]);
    assert.equal(active[fixture.ids[1]].round_id, result.round.dispatch_id);
    const store = JSON.parse(fs.readFileSync(path.join(fixture.root, '.planning/graph/dispatches.json'), 'utf8'));
    assert.deepStrictEqual(store.rounds[result.round.dispatch_id].expired_tickets, [fixture.ids[0]]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('read-only sentinel smoke proves the runtime path without allowing PR duties', async () => {
  const fixture = setupSentinelRepository();
  let launched;
  try {
    const result = await createClaudeRoleHost({ ...hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    }), readOnlySmoke: true }).run(request(fixture));
    assert.equal(launched.selection.readOnly, true);
    assert.match(launched.prompt, /read-only runtime smoke/);
    assert.equal(result.result.outcome, 'awaiting-human');
    assert.deepStrictEqual(result.result.performed, []);
    assert.equal(result.dispatch.receipt.observed_effort, result.dispatch.receipt.applied_effort);
  } finally {
    cleanupFixture(fixture);
  }
});

test('pr-sentinel refuses caller-supplied ticket sets and missing live PR members', async () => {
  const fixture = setupSentinelRepository();
  try {
    assert.throws(() => parseRequest({ ...request(fixture), ticketSet: fixture.ids }), /field ticketSet is not permitted/);
    fixture.sentinelPrs.pop();
    await assert.rejects(createClaudeRoleHost(hostOptions(fixture)).run(request(fixture)), /exactly one live PR matching delivery state/);
    assert.equal(fs.existsSync(path.join(fixture.root, '.planning/graph/dispatches.json')), false);
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

test('integrator launch schema declares the authenticated ticket_set objects', async () => {
  const fixture = setupRepository('integrator');
  let launched;
  try {
    await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const schema = launched.selection.schema;
    assert.ok(schema.required.includes('ticket_set'));
    assert.ok(schema.required.includes('ticket_set_digest'));
    assert.deepEqual(schema.properties.ticket_set.items.required, ['id', 'pr', 'head', 'base', 'branch']);
    assert.equal(schema.properties.ticket_set.items.additionalProperties, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('an integrator result echoing ticket_set as a string is refused with the named remedy', async () => {
  const fixture = setupRepository('integrator');
  try {
    const options = hostOptions(fixture, {
      mutateResult(result) { result.ticket_set = 'T-39-01 … T-39-12'; },
    });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), (error) =>
      error.code === 'INVALID_RESULT' && error.message.includes('ticket_set')
      && error.message.includes('remedy: copy role_context.ticket_set verbatim')
      && !error.message.includes('identity differs'));
  } finally {
    cleanupFixture(fixture);
  }
});

test('an integrator result listing ticket ids is refused with the named remedy', async () => {
  const fixture = setupRepository('integrator');
  try {
    const options = hostOptions(fixture, {
      mutateResult(result) { result.ticket_set = ['T-01-01']; },
    });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), (error) =>
      error.code === 'INVALID_RESULT'
      && error.message.includes('remedy: copy role_context.ticket_set verbatim'));
  } finally {
    cleanupFixture(fixture);
  }
});

test('a well-shaped ticket_set with a changed head is still an identity mismatch', async () => {
  const fixture = setupRepository('integrator');
  try {
    const options = hostOptions(fixture, {
      mutateResult(result) {
        result.ticket_set = result.ticket_set.map((entry) => ({ ...entry, head: 'f'.repeat(40) }));
      },
    });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), (error) =>
      error.code === 'ARTIFACT_IDENTITY_MISMATCH' && error.message.includes('identity differs'));
  } finally {
    cleanupFixture(fixture);
  }
});

function needsFixFindings() {
  return [
    { id: 'F1', type: 'fix-ticket', blocking: true, summary: 'seam summary',
      ticket: { title: 'Fix title', files: ['a.cjs'], scope: 'scope text', depends_on: [] } },
    { id: 'F2', type: 'informational', blocking: false, summary: 'note summary',
      evidence: 'a.cjs:1', ticket: null },
  ];
}

test('the captured integrator result with an object ticket is refused with the fix_ticket remedy', async () => {
  const fixture = setupRepository('integrator');
  try {
    const options = hostOptions(fixture, {
      mutateResult(result) {
        result.outcome = 'needs-fix';
        result.blocking_count = 1;
        result.findings = needsFixFindings();
      },
    });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), (error) =>
      error.code === 'INVALID_RESULT'
      && error.message.includes('finding 0.ticket is an object')
      && error.message.includes('remedy:')
      && error.message.includes('fix_ticket')
      && !error.message.includes('non-empty text value'));
    assert.equal(fs.existsSync(path.join(fixture.root, '.shipyard-role-artifacts')), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('an integrator result with fix_ticket and null ticket is sealed', async () => {
  const fixture = setupRepository('integrator');
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      mutateResult(mutated) {
        mutated.outcome = 'needs-fix';
        mutated.blocking_count = 1;
        mutated.findings = [
          { id: 'F1', type: 'fix-ticket', blocking: true, summary: 'seam summary', ticket: null,
            fix_ticket: { title: 'Fix title', scope: 'scope text', files: ['a.cjs'], depends_on: [] } },
          { id: 'F2', type: 'informational', blocking: false, summary: 'note summary',
            evidence: 'a.cjs:1', ticket: null },
          { id: 'F3', type: 'informational', blocking: false, summary: 'ticketed note',
            evidence: 'a.cjs:2', ticket: 'T-01-01' },
        ];
      },
    })).run(request(fixture));
    assert.equal(result.artifact.outcome, 'needs-fix');
  } finally {
    cleanupFixture(fixture);
  }
});

test('integrator and arch-review launch schemas declare the finding ticket contract', async () => {
  const integratorFixture = setupRepository('integrator');
  const archFixture = setupRepository('arch-review');
  const sentinelFixture = setupSentinelRepository();
  let integratorLaunch;
  let archLaunch;
  let sentinelLaunch;
  try {
    await createClaudeRoleHost(hostOptions(integratorFixture, {
      onLaunch(prompt, selection) { integratorLaunch = selection; },
    })).run(request(integratorFixture));
    const integratorFindings = integratorLaunch.schema.properties.findings.items;
    assert.deepEqual(integratorFindings.properties.ticket.type, ['string', 'null']);
    assert.deepEqual(integratorFindings.properties.fix_ticket.required, ['title', 'scope', 'files']);
    assert.equal(integratorFindings.properties.fix_ticket.properties.files.minItems, 1);

    await createClaudeRoleHost(hostOptions(archFixture, {
      onLaunch(prompt, selection) { archLaunch = selection; },
    })).run(request(archFixture));
    assert.deepEqual(archLaunch.schema.properties.findings.items.properties.ticket.type, ['string', 'null']);

    await createClaudeRoleHost(hostOptions(sentinelFixture, {
      onLaunch(prompt, selection) { sentinelLaunch = selection; },
    })).run(request(sentinelFixture));
    assert.deepEqual(sentinelLaunch.schema, {
      type: 'object',
      properties: {
        blocking_count: { type: 'integer', minimum: 0 },
        outcome: { type: 'string', enum: ['clear', 'blocked', 'awaiting-human'] },
        ticket_set: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'pr', 'head', 'base', 'branch'],
            properties: {
              id: { type: 'string' }, pr: { type: 'integer', minimum: 1 }, head: { type: 'string' },
              base: { type: 'string' }, branch: { type: 'string' },
            },
          },
        },
        ticket_set_digest: { type: 'string' },
        head: { type: 'string' }, head_tree: { type: 'string' },
        performed: { type: 'array' }, refused: { type: 'array' }, summary: { type: 'string' },
      },
      required: ['outcome', 'ticket_set', 'ticket_set_digest', 'head', 'head_tree', 'blocking_count'],
    });
  } finally {
    cleanupFixture(integratorFixture);
    cleanupFixture(archFixture);
    cleanupFixture(sentinelFixture);
  }
});

test('integrator judges the code diff without conveyor planning state', async () => {
  const fixture = setupRepository('integrator', { planningBytes: 1200 * 1024 });
  let launched;
  try {
    await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const diff = packetFromPrompt(launched.prompt).role_context.combined_diff.content;
    assert.ok(diff.includes('diff --git a/src/role.txt b/src/role.txt'));
    assert.equal(diff.includes('.planning/'), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('integrator resolves a marker-matched merged PR on its recorded head branch', async () => {
  const fixture = setupRepository('integrator');
  let launched;
  try {
    const statePath = path.join(fixture.root, '.planning/graph/delivery-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fixture.prBranch = 'prep/T-38-03-impl';
    state[TICKET].pr_branch = fixture.prBranch;
    state[TICKET].matched_by = 'marker';
    fs.writeFileSync(statePath, JSON.stringify(state));
    git(fixture.root, ['add', '.planning/graph/delivery-state.json']);
    git(fixture.root, ['commit', '-m', 'test: record moved merged PR branch']);
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt) { launched = prompt; },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched);
    assert.equal(result.artifact.outcome, 'passed');
    assert.equal(packet.role_context.ticket_set[0].branch, fixture.prBranch);
  } finally {
    cleanupFixture(fixture);
  }
});

test('integrator rejects a moved merged PR whose title and body omit its ticket', async () => {
  const fixture = setupRepository('integrator');
  try {
    const statePath = path.join(fixture.root, '.planning/graph/delivery-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fixture.prBranch = 'prep/T-38-03-impl';
    state[TICKET].pr_branch = fixture.prBranch;
    state[TICKET].matched_by = 'marker';
    fs.writeFileSync(statePath, JSON.stringify(state));
    git(fixture.root, ['add', '.planning/graph/delivery-state.json']);
    git(fixture.root, ['commit', '-m', 'test: record moved merged PR branch']);
    const options = hostOptions(fixture);
    const original = options.getPullRequest;
    options.getPullRequest = (input) => ({ ...original(input), title: 'feat: unrelated change', body: 'No ticket reference.' });
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), /does not identify/);
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

test('arch-review refuses a fetch failure even when the local base already matches the expected oid', async () => {
  const fixture = setupRepository('arch-review');
  try {
    git(fixture.root, ['remote', 'add', 'origin', path.join(fixture.root, 'missing-remote.git')]);
    const options = hostOptions(fixture);
    options.refreshGit = true;
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)), /cannot refresh live base branch/);
  } finally {
    cleanupFixture(fixture);
  }
});

test('pr-sentinel surfaces a sentinel-preflight refusal unchanged', async () => {
  const fixture = setupSentinelRepository();
  try {
    const options = hostOptions(fixture);
    options.preflightRound = () => {
      const error = new Error('sentinel-preflight: fetch of main from origin failed; run: git -C /x fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main');
      error.code = 'BASE_FETCH_FAILED';
      throw error;
    };
    await assert.rejects(createClaudeRoleHost(options).run(request(fixture)),
      (error) => error.code === 'BASE_FETCH_FAILED' && /sentinel-preflight: fetch of main from origin failed/.test(error.message));
  } finally {
    cleanupFixture(fixture);
  }
});

test('pr-sentinel measures a second-repository ticket base in its own checkout, not the project worktree', async () => {
  const fixture = setupSentinelRepository();
  const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-sentinel-foreign-'));
  try {
    git(foreignRoot, ['init', '-b', 'main']);
    git(foreignRoot, ['config', 'user.name', 'Shipyard Test']);
    git(foreignRoot, ['config', 'user.email', 'shipyard-test@example.invalid']);
    git(foreignRoot, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(foreignRoot, 'f.txt'), 'base\n');
    git(foreignRoot, ['add', '.']);
    git(foreignRoot, ['commit', '-m', 'chore: seed foreign repository']);
    const foreignBase = git(foreignRoot, ['rev-parse', 'HEAD']);
    git(foreignRoot, ['update-ref', 'refs/remotes/origin/main', foreignBase]);

    const foreignTicket = fixture.ids[1];
    const ticketsPath = path.join(fixture.root, '.planning/graph/tickets.json');
    const statePath = path.join(fixture.root, '.planning/graph/delivery-state.json');
    const tickets = JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    tickets.tickets[foreignTicket].repo = 'acme/frontend';
    state[foreignTicket].repo_resolution = { resolution: 'configured', executable: true, repository_root: foreignRoot, reason: null };
    fs.writeFileSync(ticketsPath, JSON.stringify(tickets));
    fs.writeFileSync(statePath, JSON.stringify(state));
    fixture.sentinelPrs[1].baseRefOid = foreignBase;
    git(fixture.root, ['add', '.planning/graph']);
    git(fixture.root, ['commit', '--quiet', '-m', 'test: mark second-repository ticket']);
    fixture.head = git(fixture.root, ['rev-parse', 'HEAD']);
    fixture.headTree = git(fixture.root, ['rev-parse', 'HEAD^{tree}']);

    const seenRoots = [];
    const options = hostOptions(fixture);
    options.preflightRound = ({ projectWorktree, prs }) => {
      for (const pr of prs) seenRoots.push({ ticket: pr.ticket, root: pr.repo ? foreignRoot : projectWorktree });
      return {
        repos: [
          { repo: null, root: projectWorktree, base: 'main', base_oid: fixture.base },
          { repo: 'acme/frontend', root: foreignRoot, base: 'main', base_oid: foreignBase },
        ],
        synced: true,
        committed: null,
      };
    };
    const result = await createClaudeRoleHost(options).run(request(fixture));
    assert.equal(result.artifact.outcome, 'clear');
    assert.equal(seenRoots.find((entry) => entry.ticket === foreignTicket).root, foreignRoot);
  } finally {
    cleanupFixture(fixture);
    fs.rmSync(foreignRoot, { recursive: true, force: true });
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

function unreferencedAdrs(count, offset = 101) {
  const items = [];
  for (let index = 0; index < count; index++) {
    const number = offset + index;
    items.push({
      name: `ADR-${number}-extra.md`,
      content: `# ADR-${number} — extra\n\n- **Status:** accepted\n\nUnreferenced decision text for ADR-${number}.\n`,
    });
  }
  return items;
}

function unreferencedBacklogFiles(count) {
  const items = [];
  for (let index = 0; index < count; index++) {
    items.push({
      name: `extra-${index}.md`,
      content: `# Extra backlog item ${index}\n\nUnreferenced backlog note text for item ${index}.\n`,
    });
  }
  return items;
}

test('an integrator packet carries no unreferenced ADRs or backlog entries', async () => {
  const fixture = setupRepository('integrator', {
    corpus: { adrs: unreferencedAdrs(20), backlogFiles: unreferencedBacklogFiles(30) },
  });
  let launched;
  try {
    await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched.prompt);
    assert.equal(packet.required_refs.some((ref) => ref.path.startsWith('.planning/architecture/ADR-1')), false);
    assert.deepEqual(packet.role_context.adr_refs.map((ref) => ref.id), ['ADR-014']);
    assert.deepEqual(packet.backlog.selected_ids, []);
    assert.equal(packet.backlog.inventory.items.length, 0);
    assert.equal(packet.backlog.inventory.scope, 'selected');
  } finally {
    cleanupFixture(fixture);
  }
});

test('a referenced ADR and each plan appear once in the role prompt', async () => {
  const marker = 'ADR-101-UNIQUE-MARKER-4f19';
  const adrContent = `# ADR-101 — sample\n\n- **Status:** accepted\n\nDecision body with ${marker}.\n`;
  const planMarker = 'PLAN-CONTENT-UNIQUE-MARKER-8b2e';
  const fixture = setupRepository('integrator', {
    corpus: { adrs: [{ name: 'ADR-101-sample.md', content: adrContent }] },
    planExtra: [
      planMarker,
      'References ADR-101 twice: ADR-101 governs this change.',
      'See `.planning/architecture/ADR-101-sample.md` for detail.',
    ],
  });
  let launched;
  try {
    await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched.prompt);
    const matchingRefs = packet.required_refs.filter((ref) => ref.path === '.planning/architecture/ADR-101-sample.md');
    assert.equal(matchingRefs.length, 1);
    assert.equal(matchingRefs[0].content, adrContent);
    const adrRefs = packet.role_context.adr_refs.filter((ref) => ref.id === 'ADR-101');
    assert.equal(adrRefs.length, 1);
    assert.equal('content' in adrRefs[0], false);
    assert.equal(launched.prompt.split(marker).length - 1, 1);
    assert.equal(launched.prompt.split(planMarker).length - 1, 1);
    assert.deepEqual(packet.acceptance, []);
    assert.ok(packet.role_context.phase_contracts[0].acceptance.length > 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('a superseded ADR is excluded from arch-review and integrator packets', async () => {
  const adr105 = '# ADR-105 — old\n\n- **Status**: superseded for runtime model and effort selection\n\nBody text.\n';
  const adr112 = '# ADR-112 — older\n\n- **Status:** superseded for runtime model and effort selection\n\nBody text.\n';
  const corpus = { adrs: [{ name: 'ADR-105-old.md', content: adr105 }, { name: 'ADR-112-older.md', content: adr112 }] };
  const planExtra = ['References ADR-105, ADR-112 and ADR-999 for context.'];
  for (const kind of ['arch-review', 'integrator']) {
    const fixture = setupRepository(kind, { corpus, planExtra });
    let launched;
    try {
      await createClaudeRoleHost(hostOptions(fixture, {
        onLaunch(prompt, selection) { launched = { prompt, selection }; },
      })).run(request(fixture));
      const packet = packetFromPrompt(launched.prompt);
      assert.equal(packet.required_refs.some((ref) => ref.path.includes('ADR-105') || ref.path.includes('ADR-112')), false);
      assert.deepEqual(packet.role_context.adr_excluded, [
        { id: 'ADR-105', path: '.planning/architecture/ADR-105-old.md', reason: 'superseded' },
        { id: 'ADR-112', path: '.planning/architecture/ADR-112-older.md', reason: 'superseded' },
      ]);
      assert.deepEqual(packet.role_context.adr_unresolved, ['ADR-999']);
    } finally {
      cleanupFixture(fixture);
    }
  }
});

test('a plan-referenced backlog file is the only backlog in the packet', async () => {
  const refContent = '# Ref item\n\nThis is the referenced backlog content that must appear complete in the packet.\n';
  const otherContent = '# Other item\n\nThis backlog file is never referenced by any plan.\n';
  const fixture = setupRepository('integrator', {
    corpus: { backlogFiles: [{ name: 'ref.md', content: refContent }, { name: 'other.md', content: otherContent }] },
    planExtra: ['Selects `.planning/backlog/ref.md` for this ticket.'],
  });
  let launched;
  try {
    await createClaudeRoleHost(hostOptions(fixture, {
      onLaunch(prompt, selection) { launched = { prompt, selection }; },
    })).run(request(fixture));
    const packet = packetFromPrompt(launched.prompt);
    assert.ok(packet.backlog.selected.length >= 1);
    assert.ok(packet.backlog.selected.every((item) => item.source === 'local:.planning/backlog/ref.md'));
    assert.ok(packet.backlog.selected.some((item) => item.content.includes('referenced backlog content')));
    assert.ok(packet.backlog.inventory.items.length >= 1);
    assert.equal(packet.backlog.inventory.items.every((item) => item.source === 'local:.planning/backlog/ref.md'), true);
  } finally {
    cleanupFixture(fixture);
  }
});

test('an over-bound role packet is refused before launch with its remedy', async () => {
  const bigBody = (label) => `# ${label}\n\n- **Status:** accepted\n\n${'x'.repeat(150 * 1024)}\n`;
  const corpus = { adrs: [
    { name: 'ADR-201-big.md', content: bigBody('ADR-201 — big') },
    { name: 'ADR-202-big.md', content: bigBody('ADR-202 — big') },
  ] };
  const planExtra = ['References ADR-201 and ADR-202 for scale.'];

  const archFixture = setupRepository('arch-review', { corpus, planExtra });
  try {
    let launched = false;
    await assert.rejects(
      createClaudeRoleHost(hostOptions(archFixture, { onLaunch() { launched = true; } })).run(request(archFixture)),
      (error) => error.code === 'CONTEXT_PACKET_OVER_BOUND'
        && error.message.includes('arch-review context packet is')
        && error.message.includes('over its bound of 60000')
        && error.message.includes('remedy: split the ticket'),
    );
    assert.equal(launched, false);
    assert.equal(fs.existsSync(path.join(archFixture.root, '.shipyard-role-artifacts')), false);
  } finally {
    cleanupFixture(archFixture);
  }

  const integratorFixture = setupRepository('integrator', { corpus, planExtra });
  try {
    await assert.rejects(
      createClaudeRoleHost(hostOptions(integratorFixture)).run(request(integratorFixture)),
      (error) => error.code === 'CONTEXT_PACKET_OVER_BOUND'
        && error.message.includes('integrator context packet is')
        && error.message.includes('remedy: split the phase'),
    );
  } finally {
    cleanupFixture(integratorFixture);
  }

  const sentinelFixture = setupSentinelRepository({ corpus, planExtra });
  try {
    await assert.rejects(
      createClaudeRoleHost(hostOptions(sentinelFixture)).run(request(sentinelFixture)),
      (error) => error.code === 'CONTEXT_PACKET_OVER_BOUND'
        && error.message.includes('pr-sentinel context packet is')
        && error.message.includes('remedy: drop ADR and backlog references'),
    );
  } finally {
    cleanupFixture(sentinelFixture);
  }
});

test('role packets carry their explicit token bounds', async () => {
  const archFixture = setupRepository('arch-review');
  const integratorFixture = setupRepository('integrator');
  const sentinelFixture = setupSentinelRepository();
  try {
    let archPacket;
    await createClaudeRoleHost(hostOptions(archFixture, {
      onLaunch(prompt) { archPacket = packetFromPrompt(prompt); },
    })).run(request(archFixture));
    assert.equal(archPacket.accounting.soft_ceiling, 60000);

    let integratorPacket;
    await createClaudeRoleHost(hostOptions(integratorFixture, {
      onLaunch(prompt) { integratorPacket = packetFromPrompt(prompt); },
    })).run(request(integratorFixture));
    const diffBytes = Buffer.byteLength(integratorPacket.role_context.combined_diff.content, 'utf8');
    assert.equal(integratorPacket.accounting.soft_ceiling, 60000 + Math.ceil(diffBytes / 4));

    let sentinelPacket;
    await createClaudeRoleHost(hostOptions(sentinelFixture, {
      onLaunch(prompt) { sentinelPacket = packetFromPrompt(prompt); },
    })).run(request(sentinelFixture));
    assert.equal(sentinelPacket.accounting.soft_ceiling, 40000);
  } finally {
    cleanupFixture(archFixture);
    cleanupFixture(integratorFixture);
    cleanupFixture(sentinelFixture);
  }
});

test('the role reference appears once in the prompt and the packet keeps only its digest', async () => {
  const cases = [
    ['arch-review', () => setupRepository('arch-review')],
    ['integrator', () => setupRepository('integrator')],
    ['pr-sentinel', () => setupSentinelRepository()],
  ];
  for (const [role, build] of cases) {
    const fixture = build();
    let launched;
    try {
      const reference = loadClaudeReferenceContent(role);
      await createClaudeRoleHost(hostOptions(fixture, {
        onLaunch(prompt) { launched = prompt; },
      })).run(request(fixture));
      const packet = packetFromPrompt(launched);
      assert.equal(packet.role_context.reference_content, undefined);
      assert.deepEqual(packet.role_context.reference_digest, {
        sha256: crypto.createHash('sha256').update(reference).digest('hex'),
        bytes: Buffer.byteLength(reference, 'utf8'),
      });
      assert.equal(launched.split(reference).length - 1, 1);
    } finally {
      cleanupFixture(fixture);
    }
  }
});

test('a partially superseded ADR still admits the DECISIONS.md it transitively names', async () => {
  const decisionsPath = '.planning/investigations/INV-901-test-partial-supersession/DECISIONS.md';
  const decisionsContent = '# Decisions\n\n## A still-governing constraint\n\n**Why:** it still governs.\n';
  const adrPath = '.planning/architecture/ADR-105-old.md';
  const adrContent = `# ADR-105 — old\n\n- **Status**: superseded for runtime model and effort selection\n\n`
    + `See \`${decisionsPath}\` for the retained decision.\n`;
  const corpus = {
    adrs: [{ name: 'ADR-105-old.md', content: adrContent }],
    investigations: [{ path: decisionsPath, content: decisionsContent }],
  };
  const planExtra = ['References ADR-105 for context.'];
  const cases = [
    ['arch-review', () => setupRepository('arch-review', { corpus, planExtra })],
    ['integrator', () => setupRepository('integrator', { corpus, planExtra })],
    ['pr-sentinel', () => setupSentinelRepository({ corpus, planExtra })],
  ];
  for (const [role, build] of cases) {
    const fixture = build();
    let launched;
    try {
      await createClaudeRoleHost(hostOptions(fixture, {
        onLaunch(prompt) { launched = prompt; },
      })).run(request(fixture));
      const packet = packetFromPrompt(launched);
      if (role !== 'pr-sentinel') {
        assert.deepEqual(packet.role_context.adr_excluded, [{ id: 'ADR-105', path: adrPath, reason: 'superseded' }]);
      }
      assert.equal(packet.required_refs.some((ref) => ref.path === adrPath), false);
      const decisionsRef = packet.required_refs.find((ref) => ref.path === decisionsPath);
      assert.ok(decisionsRef, `${role}: a transitively named DECISIONS.md must remain admitted`);
      assert.equal(decisionsRef.content, decisionsContent);
    } finally {
      cleanupFixture(fixture);
    }
  }
});

test('the launch record separates the packet estimate from the complete prompt and reports unmatched usage as unknown', async () => {
  const cases = [
    () => setupRepository('arch-review'),
    () => setupRepository('integrator'),
    () => setupSentinelRepository(),
  ];
  for (const build of cases) {
    const fixture = build();
    let launched;
    try {
      const result = await createClaudeRoleHost(hostOptions(fixture, {
        onLaunch(prompt, selection) { launched = { prompt, selection }; },
      })).run(request(fixture));
      const packet = packetFromPrompt(launched.prompt);
      assert.equal(result.context.packet_bytes, packet.accounting.estimated_bytes);
      assert.equal(result.context.packet_estimated_tokens, packet.accounting.estimated_tokens);
      assert.equal(result.context.packet_estimated_tokens, Math.ceil(result.context.packet_bytes / 4));
      assert.equal(result.context.prompt_bytes, Buffer.byteLength(launched.prompt, 'utf8'));
      assert.ok(result.context.prompt_bytes > result.context.packet_bytes);
      assert.equal(result.context.model, result.dispatch.receipt.applied_model);
      assert.equal(result.context.effort, result.dispatch.receipt.applied_effort);
      assert.equal(result.context.policy_hash, packet.policy_hash);
      assert.deepEqual(result.context.host_identity, {
        role_host_sha256: fileSha('plugins/delivery-pipeline/scripts/claude-role-host.cjs'),
        context_packet_sha256: fileSha('plugins/delivery-pipeline/scripts/context-packet.cjs'),
      });
      assert.match(result.context.run_id, /^claude-role-/);
      assert.deepEqual(result.context.selected_backlog_ids, packet.backlog.selected_ids);
      assert.ok(result.context.selected_refs.some((ref) => ref.path.endsWith('PLAN.md')));
      assert.deepEqual(result.context.first_response_usage, { status: 'unknown', reason: 'transcript is unreadable' });
    } finally {
      cleanupFixture(fixture);
    }
  }
});

test('a matched first-response transcript records observed provider usage by authenticated dispatch identity', async () => {
  const fixture = setupRepository('arch-review');
  const usage = { input_tokens: 1200, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500, output_tokens: 800 };
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseUsage: usage,
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, {
      status: 'observed',
      dispatch_identity: { session_id: result.dispatch.receipt.session_id, launch_id: result.dispatch.receipt.launch_id },
      counters: usage,
    });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('streamed partial-then-final records of the same message id are max-merged into one observed response', async () => {
  const fixture = setupRepository('arch-review');
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseLines: [
        { type: 'assistant', message: { role: 'assistant', id: 'msg-1', model: 'claude-opus-5-5',
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
        { type: 'assistant', message: { role: 'assistant', id: 'msg-1', model: 'claude-opus-5-5',
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 },
          stop_reason: 'end_turn' } },
      ],
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, {
      status: 'observed',
      dispatch_identity: { session_id: result.dispatch.receipt.session_id, launch_id: result.dispatch.receipt.launch_id },
      counters: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 },
    });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('a first response with no stop_reason on any of its records is reported unknown as incomplete', async () => {
  const fixture = setupRepository('arch-review');
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseLines: [
        { type: 'assistant', message: { role: 'assistant', id: 'msg-1', model: 'claude-opus-5-5',
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 } } },
      ],
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, { status: 'unknown', reason: 'incomplete' });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('a synthetic first record is skipped and the following real response is measured', async () => {
  const fixture = setupRepository('arch-review');
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseLines: [
        { type: 'assistant', message: { role: 'assistant', id: 'msg-synthetic', model: '<synthetic>',
          usage: { input_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999, output_tokens: 999 },
          stop_reason: 'end_turn' } },
        { type: 'assistant', message: { role: 'assistant', id: 'msg-real', model: 'claude-opus-5-5',
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
          stop_reason: 'end_turn' } },
      ],
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, {
      status: 'observed',
      dispatch_identity: { session_id: result.dispatch.receipt.session_id, launch_id: result.dispatch.receipt.launch_id },
      counters: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
    });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('a session containing only synthetic assistant records reports unknown as synthetic-only', async () => {
  const fixture = setupRepository('arch-review');
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseLines: [
        { type: 'assistant', message: { role: 'assistant', id: 'msg-synthetic', model: '<synthetic>',
          usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
          stop_reason: 'end_turn' } },
      ],
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, { status: 'unknown', reason: 'synthetic-only' });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('a record without a stable message id or uuid is skipped and reported as no identity', async () => {
  const fixture = setupRepository('arch-review');
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseLines: [
        { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5',
          usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
          stop_reason: 'end_turn' } },
      ],
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, { status: 'unknown', reason: 'no identity' });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('two records sharing one message id but declaring different models report unknown as conflicting', async () => {
  const fixture = setupRepository('arch-review');
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseLines: [
        { type: 'assistant', message: { role: 'assistant', id: 'msg-1', model: 'claude-opus-5-5',
          usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
        { type: 'assistant', message: { role: 'assistant', id: 'msg-1', model: 'claude-sonnet-5',
          usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
          stop_reason: 'end_turn' } },
      ],
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage, { status: 'unknown', reason: 'conflicting model' });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});

test('a transcript whose content no longer matches its recorded digest is refused as unknown', async () => {
  const fixture = setupRepository('arch-review');
  const usage = { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  let transcriptPath;
  try {
    const result = await createClaudeRoleHost(hostOptions(fixture, {
      firstResponseUsage: usage,
      corruptDigest: true,
      onLaunch() {},
    })).run(request(fixture));
    transcriptPath = result.dispatch.application_evidence.transcript.path;
    assert.deepEqual(result.context.first_response_usage,
      { status: 'unknown', reason: 'transcript content does not match its recorded digest' });
  } finally {
    cleanupFixture(fixture);
    if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
  }
});
