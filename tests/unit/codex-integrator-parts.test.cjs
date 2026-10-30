'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PHASE, TICKET, git, write, livePr, packetFromPrompt, cleanupFixture, integratorFixture, commit, withPrs, manyTicketFixture,
  stackedFixture, hostOptions } = require('./helpers/claude-role-fixtures.cjs');
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const { createCodexDeliveryHost, runCli } = require(path.join(scripts, 'codex-delivery-host.cjs'));
const { prepareIntegratorContext } = require(path.join(scripts, 'claude-role-host.cjs'));
const { createDurableRecorder } = require(path.join(scripts, 'dispatch-boundary.cjs'));
const codeContext = require(path.join(scripts, 'codex-code-review-context.cjs'));
const policy = require(path.join(scripts, 'model-policy.cjs'));
const { writeCodexSession } = require('../fixtures/code-review/artifact-fixture.cjs');
const { focusedNativeSession } = require('./helpers/codex-arch-review-fixtures.cjs');
const { createCodexRuntimeHost } = require(path.join(scripts, 'codex-runtime-host.cjs'));

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const FILES = ['src/a/one.txt', 'src/b/two.txt', 'src/c/three.txt'];
const SPLIT_PATHS = [['src/a/one.txt', 'src/b/two.txt'], ['src/c/three.txt', 'src/role.txt']];
const BLOCKER = { id: 'F-1', type: 'fix-ticket', blocking: true, summary: 'The seam loses an update.',
  fix_ticket: { title: 'Keep updates', scope: 'Persist first.', files: ['src/a/one.txt'] } };

function nativeStream(session, text) {
  const records = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('{"shipyard_fixture"')).map(line => JSON.parse(line.replace(/<SESSION-1>/g, session)));
  for (const record of records) if (record.item?.type === 'agent_message') record.item.text = text;
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

async function withHost(f, config, action) {
  const storage = f.storageRoot;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-integrator-home-')));
  const agentDir = path.join(home, 'agents'); fs.mkdirSync(agentDir);
  const manifest = { policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION, policy_hash: policy.POLICY_HASH,
    agent_files: [], agent_digests: {} };
  for (const signals of [{}, { critical: true }]) {
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'integrator', signals });
    const content = ['# shipyard-policy-id = "' + policy.POLICY.id + '"', '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
      '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"', '# shipyard-policy-runtime = "codex"',
      '# shipyard-policy-role = "integrator"', '# shipyard-policy-rung = "' + selected.rung + '"',
      'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"', 'model = "' + selected.model + '"',
      'model_reasoning_effort = "' + selected.effort + '"', 'sandbox_mode = "read-only"',
      "developer_instructions = '''\nJudge the complete authenticated phase.\n'''", ''].join('\n');
    fs.writeFileSync(path.join(agentDir, selected.agent_file), content);
    manifest.agent_files.push(selected.agent_file); manifest.agent_digests[selected.agent_file] = hash(content);
  }
  const agentManifest = path.join(agentDir, '.shipyard-manifest.json'); fs.writeFileSync(agentManifest, JSON.stringify(manifest));
  const options = { storageRoot: storage, refreshGit: false, defaultBranch: 'main', agentDir, agentManifest, env: {},
    ...withPrs({}, config.subjectPrs || config.prs || [livePr(f)]), ...(config.partBudget ? { partBudget: config.partBudget } : {}) };
  const subject = prepareIntegratorContext(options, { worktree: f.root, phase: PHASE });
  Object.assign(options, withPrs({}, config.prs || [livePr(f)]));
  const scope = { run_id: 'codex-integrator-' + crypto.randomUUID(), runtime: 'codex', provider: 'openai', phase: subject.phaseNumber,
    worktree: f.root, repository: subject.canonical.commonPath, ticket: subject.ticket };
  const calls = [];
  const host = { scope, capabilities: { supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['high', 'xhigh'] },
    recorder: createDurableRecorder(path.join(storage, 'receipts')),
    launch() { assert.fail('the integrator launches statically'); },
    launchStatic(selection, launchContext) {
      const value = launchContext.review_prepared;
      const binding = codeContext.authenticateLaunch(value, launchContext.prompt, { ticket: scope.ticket, phase: scope.phase,
        worktree: scope.worktree, dispatch_id: launchContext.dispatch_id, agent_file: selection.agent_file,
        agent_file_digest: selection.agent_file_digest });
      const packet = packetFromPrompt(launchContext.prompt), role = packet.role_context;
      const raw = role.part
        ? { part: role.part.id, review_completeness: 'complete', limitations: [], unresolved_sources: [],
          summary: 'Reviewed ' + role.part.id, findings: [] }
        : { outcome: 'passed', phase: role.phase, head: role.combined_diff.head, head_tree: role.combined_diff.head_tree,
          base: role.integration_base.ref, base_tree: role.integration_base.tree, ticket_set: role.ticket_set,
          ticket_set_digest: role.ticket_set_digest, blocking_count: 0, summary: 'Phase is coherent.', findings: [],
          evidence_markdown: `Integration check at ${role.combined_diff.head}.\n` };
      calls.push({ selection, context: launchContext, packet, binding });
      config.mutate?.(raw, packet, { f, value });
      const session = crypto.randomUUID();
      const stream = nativeStream(session, JSON.stringify(raw));
      const transcript = path.join(storage, session + '.jsonl'); fs.writeFileSync(transcript, stream);
      const { nativeText } = writeCodexSession({ home, session, worktree: scope.worktree, model: selection.model,
        effort: selection.reasoning_effort, prompt: launchContext.prompt, raw });
      const runtime_evidence = { schema: 'shipyard.codex-runtime-evidence.v1', runtime: 'codex', provider: 'openai',
        session_id: session, worktree: scope.worktree, ticket: scope.ticket, phase: scope.phase,
        ...(config.noCustody ? {} : { integrator_review: binding }),
        native_session_evidence: { session_id: session, bytes: Buffer.byteLength(nativeText), sha256: hash(nativeText) },
        input_consumption: { native_session_sha256: hash(nativeText) },
        transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: hash(stream) } };
      return { launch_id: 'integrator-' + session, applied_model: selection.model, applied_effort: selection.reasoning_effort,
        observed_model: selection.model, observed_effort: selection.reasoning_effort,
        agent_file_digest: selection.agent_file_digest, runtime_evidence };
    } };
  const originalHome = os.homedir, originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await action({ calls, host, scope, options: { ...options, host, capabilities: host.capabilities },
      cli: async () => {
        const file = path.join(storage, 'integrator-request.json');
        fs.writeFileSync(file, JSON.stringify({ scope: { ...scope, repository: undefined, run_id: scope.run_id }, graph_dir: path.join(f.root, '.planning/graph'),
          role: 'integrator', signals: {}, context: {} }));
        let output = '';
        const result = await runCli(['--args-file', file], { write(chunk) { output += chunk; } }, { ...options, host, capabilities: host.capabilities });
        assert.deepEqual(JSON.parse(output), result);
        return result;
      },
      run: (extra = {}) => createCodexDeliveryHost({ ...options, host, capabilities: host.capabilities, scope, ...extra })
        .run({ role: 'integrator', context: {} }) });
  } finally {
    os.homedir = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const evidenceFile = f => path.join(f.root, `.planning/phases/${PHASE}/INTEGRATION.md`);

test('the Codex integrator reads the diff through git in one read-only session and the host writes the evidence', async () => {
  const f = integratorFixture();
  try {
    await withHost(f, {}, async ({ calls, run }) => {
      const result = await run();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].selection.sandbox_mode, 'read-only');
      assert.equal(calls[0].packet.role_context.combined_diff.content, undefined);
      assert.match(calls[0].context.prompt, /git diff [0-9a-f]{40}\.\.\.[0-9a-f]{40} -- <path>/);
      assert.equal(result.role, 'integrator');
      assert.equal(result.artifact.outcome, 'passed');
      assert.equal(result.receipt.runtime_evidence.integrator_review.launch_digest.length, 64);
      assert.equal(fs.readFileSync(evidenceFile(f), 'utf8'), `Integration check at ${f.head}.\n`);
    });
  } finally { cleanupFixture(f); }
});

test('large diffs split into path-group parts, each its own launch and receipt, and a fresh final owns the verdict', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5 }, async ({ calls, run }) => {
      const result = await run();
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.slice(0, 2).map(call => call.packet.role_context.part.paths), SPLIT_PATHS);
      assert.ok(calls.slice(0, 2).every(call => call.packet.role_context.parts === undefined));
      const final = calls[2].packet.role_context;
      assert.deepEqual(final.parts.map(part => part.paths), SPLIT_PATHS);
      const ids = calls.map(call => call.context.dispatch_id);
      assert.equal(new Set(ids).size, 3, 'every part and the final are separate dispatches');
      assert.deepEqual(final.parts.map(part => part.dispatch_id), ids.slice(0, 2));
      assert.equal(result.dispatch.dispatch_id, ids[2]);
      assert.equal(new Set(calls.map(call => call.binding.launch_digest)).size, 3);
      assert.equal(result.artifact.outcome, 'passed');
      assert.equal(fs.readFileSync(evidenceFile(f), 'utf8'), `Integration check at ${f.head}.\n`);
    });
  } finally { cleanupFixture(f); }
});

test('the Codex integrator cannot pass over an incomplete part', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5, mutate(raw, packet) {
      if (packet.role_context.part?.ordinal === 2) Object.assign(raw, { review_completeness: 'incomplete', limitations: ['src/c/three.txt was unreadable'] });
    } }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'INVALID_RESULT' });
      assert.equal(calls.length, 3, 'the final ran and its pass was refused');
    });
  } finally { cleanupFixture(f); }
});

const blockerScenario = final => ({ partBudget: 5, mutate(raw, packet) {
  const context = packet.role_context;
  if (context.part?.ordinal === 1) raw.findings = [BLOCKER];
  if (!context.part) final(raw, context.parts[0].findings[0].ref);
} });

test('a part blocker needs one justified disposition from the final, and unresolved ones need a blocking finding', async () => {
  const outcomes = [];
  for (const [final, code] of [[() => {}, 'JUDGMENT_OUTCOME_MISMATCH'],
    [(raw, ref) => { raw.dispositions = [{ ref, disposition: 'resolved', justification: 'git show confirms it' }]; }, null],
    [(raw, ref) => { raw.dispositions = [{ ref, disposition: 'unresolved', justification: 'still racy' }]; }, 'JUDGMENT_OUTCOME_MISMATCH'],
    [(raw, ref) => Object.assign(raw, { outcome: 'needs-fix', blocking_count: 1, findings: [BLOCKER],
      dispositions: [{ ref, disposition: 'unresolved', justification: 'still racy' }] }), null]]) {
    const f = integratorFixture({ files: FILES });
    try {
      await withHost(f, blockerScenario(final), async ({ run }) => {
        if (code) await assert.rejects(run(), { code });
        else outcomes.push((await run()).artifact.outcome);
      });
    } finally { cleanupFixture(f); }
  }
  assert.deepEqual(outcomes, ['passed', 'needs-fix']);
});

test('a Codex part finding without a boolean blocking flag is refused', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5, mutate(raw, packet) {
      if (packet.role_context.part?.ordinal === 1) raw.findings = [{ id: 'F-1', type: 'fix-ticket', severity: 'BLOCKER', summary: 'unflagged' }];
    } }, async ({ run }) => assert.rejects(run(), { code: 'INVALID_RESULT' }));
  } finally { cleanupFixture(f); }
});

test('merge ancestry is computed by the host: a stacked ticket counts through its parent, an unreachable merge commit refuses before any launch', async () => {
  const stacked = stackedFixture();
  try {
    await withHost(stacked.fixture, { prs: stacked.prs }, async ({ run }) => assert.equal((await run()).artifact.outcome, 'passed'));
  } finally { cleanupFixture(stacked.fixture); }
  const { fixture, prs } = manyTicketFixture(2);
  try {
    const subjectPrs = structuredClone(prs);
    prs.at(-1).mergeCommit = { oid: git(fixture.root, ['commit-tree', git(fixture.root, ['rev-parse', 'HEAD^{tree}']), '-m', 'unreachable']) };
    await withHost(fixture, { prs, subjectPrs }, async ({ calls, run }) => {
      await assert.rejects(run(), /merged PR \d+ is not included/);
      assert.equal(calls.length, 0);
    });
  } finally { cleanupFixture(fixture); }
});

test('an integrator head that moves while its parts run is refused and launches no final', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5, mutate(_raw, packet) {
      if (packet.role_context.part?.ordinal === 2) { write(f.root, 'src/b/two.txt', 'moved\n'); commit(f, 'feat: moved head'); }
    } }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'STALE_CONTEXT' });
      assert.equal(calls.length, 2);
    });
  } finally { cleanupFixture(f); }
});

test('a merged PR that changes while the integrator runs is stale', async () => {
  const f = integratorFixture();
  const prs = [livePr(f)];
  try {
    await withHost(f, { prs, mutate() { prs[0] = { ...prs[0], mergedAt: '2026-09-24T12:00:00Z' }; } }, async ({ run }) =>
      assert.rejects(run(), { code: 'STALE_CONTEXT' }));
  } finally { cleanupFixture(f); }
});

test('a merged PR that changes after the first part is stale before the next part launches', async () => {
  const f = integratorFixture({ files: FILES });
  const prs = [livePr(f)];
  try {
    await withHost(f, { prs, partBudget: 5, mutate(_raw, packet) {
      if (packet.role_context.part?.ordinal === 1) prs[0] = { ...prs[0], mergedAt: '2026-09-24T12:00:00Z' };
    } }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'STALE_CONTEXT' });
      assert.equal(calls.length, 1);
    });
  } finally { cleanupFixture(f); }
});

test('an archive member that appears after the first part refuses the next part', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5, mutate(_raw, packet) {
      if (packet.role_context.part?.ordinal === 1) write(f.root, '.shipyard-role-artifacts/rogue/evidence.md', 'x\n');
    } }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'ARCHIVE_AUTHORITY_INVALID' });
      assert.equal(calls.length, 1);
    });
  } finally { cleanupFixture(f); }
});

test('a Codex part that writes an untracked file is refused and no further session launches', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5, mutate() { write(f.root, 'src/rogue.txt', 'x\n'); } }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'WORKTREE_MUTATED' });
      assert.equal(calls.length, 1);
    });
  } finally { cleanupFixture(f); }
});

test('a final that would not fit after the parts refuses before any part launches', async () => {
  const { fixture, prs } = manyTicketFixture(37, 12000);
  try {
    await withHost(fixture, { prs, partBudget: 4000 }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'CONTEXT_OVER_BOUND' });
      assert.equal(calls.length, 0);
    });
  } finally { cleanupFixture(fixture); }
});

test('a final that cannot hold every part at its size bound refuses before any part launches although the inventory fits one session', async () => {
  const single = manyTicketFixture(2, 40);
  try {
    await withHost(single.fixture, { prs: single.prs }, async ({ calls, run }) => {
      assert.equal((await run()).artifact.outcome, 'passed');
      assert.equal(calls.length, 1);
    });
  } finally { cleanupFixture(single.fixture); }
  const { fixture, prs } = manyTicketFixture(2, 40);
  try {
    await withHost(fixture, { prs, partBudget: 2 }, async ({ calls, run }) => {
      await assert.rejects(run(), { code: 'CONTEXT_OVER_BOUND' });
      assert.equal(calls.length, 0);
    });
  } finally { cleanupFixture(fixture); }
});

test('a launch without the host receipt custody is refused', async () => {
  const f = integratorFixture();
  try {
    await withHost(f, { noCustody: true }, async ({ run }) => assert.rejects(run(), { code: 'MISSING_RECEIPT' }));
  } finally { cleanupFixture(f); }
});

test('the integrator takes no caller prompt, signal, selector or review contract', async () => {
  const f = integratorFixture();
  try {
    await withHost(f, {}, async ({ calls, options, scope }) => {
      for (const request of [{ role: 'integrator', context: { prompt: 'judge it' } }, { role: 'integrator', signals: { critical: true } },
        { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }, { role: 'integrator', context: { repo: 'acme/app' } }])
        await assert.rejects(createCodexDeliveryHost({ ...options, scope }).run(request), /refused|takes no|accepts only/);
      assert.equal(calls.length, 0);
    });
  } finally { cleanupFixture(f); }
});

test('the documented integrator caller runs unchanged on both runtimes', async () => {
  const deliver = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/commands/deliver.md'), 'utf8');
  const snippet = deliver.slice(deliver.indexOf('**Integrator launch.**')).match(/```javascript\n([\s\S]*?)\n\s*```/)[1];
  const caller = new (Object.getPrototypeOf(async function () {}).constructor)(
    'require', 'CLAUDE_PLUGIN_ROOT', 'options', 'worktree', 'phase', 'run_id', 'runtime', snippet + '\nreturn result;');
  const plugin = path.resolve(scripts, '..');
  const codex = integratorFixture();
  try {
    await withHost(codex, {}, async ({ options, scope }) => {
      const result = await caller(require, plugin, options, codex.root, PHASE, scope.run_id, 'codex');
      assert.equal(result.role, 'integrator');
      assert.equal(result.artifact.outcome, 'passed');
    });
  } finally { cleanupFixture(codex); }
  const claude = integratorFixture();
  try {
    const result = await caller(require, plugin, hostOptions(claude), claude.root, PHASE, 'documented-claude', 'claude');
    assert.equal(result.role, 'integrator');
    assert.equal(result.artifact.outcome, 'passed');
  } finally { cleanupFixture(claude); }
});

test('the Codex CLI entry runs the integrator with the canonical graph selector', async () => {
  const f = integratorFixture({ files: FILES });
  try {
    await withHost(f, { partBudget: 5 }, async ({ calls, cli }) => {
      const result = await cli();
      assert.equal(calls.length, 3);
      assert.equal(result.role, 'integrator');
      assert.equal(result.artifact.outcome, 'passed');
    });
  } finally { cleanupFixture(f); }
});

for (const critical of [true, false]) test('the real Codex runtime launches the integrator read-only with host custody and no write path: critical=' + critical, async () => {
  const f = integratorFixture();
  if (!critical) {
    const file = path.join(f.root, '.planning/graph/tickets.json'), graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(graph.tickets[TICKET], { risk: 'low', human_checkpoint: false, critical: false });
    write(f.root, '.planning/graph/tickets.json', JSON.stringify(graph));
    f.head = commit(f, 'chore: low risk row');
    git(f.root, ['update-ref', `refs/remotes/origin/${f.branch}`, f.head]);
  }
  try {
    await withHost(f, {}, async ({ options, scope }) => {
      const dispatchId = 'integrator-runtime-' + crypto.randomUUID();
      const value = codeContext.prepare(scope, { role: 'integrator', signals: {}, context: {} },
        { ...options, graphDir: path.join(f.root, '.planning/graph'), inflightDispatchId: dispatchId });
      const selected = policy.resolveDispatch({ runtime: 'codex', role: 'integrator', signals: value.prepared.signals });
      assert.equal(selected.agent_file, policy.codexAgentFile('integrator', critical ? 'critical' : 'base'));
      const content = fs.readFileSync(path.join(options.agentDir, selected.agent_file), 'utf8');
      const selection = { model: selected.model, effort: selected.effort, sandbox_mode: 'read-only', agent_file: selected.agent_file,
        agent_file_content: content, agent_file_digest: hash(content) };
      codeContext.admitInstalledLaunch(value, { agentDir: options.agentDir, agentFile: selected.agent_file,
        agentManifest: options.agentManifest, capabilities: options.capabilities });
      const context = { dispatch_id: dispatchId, prompt: codeContext.admittedPrompt(value), review_prepared: value };
      const binding = codeContext.authenticateLaunch(value, context.prompt, { ticket: scope.ticket, phase: scope.phase,
        worktree: scope.worktree, dispatch_id: dispatchId, agent_file: selection.agent_file, agent_file_digest: selection.agent_file_digest });
      const role = packetFromPrompt(context.prompt).role_context;
      const text = JSON.stringify({ outcome: 'passed', phase: role.phase, head: role.combined_diff.head, head_tree: role.combined_diff.head_tree,
        base: role.integration_base.ref, base_tree: role.integration_base.tree, ticket_set: role.ticket_set,
        ticket_set_digest: role.ticket_set_digest, blocking_count: 0, summary: 'Coherent.', findings: [], evidence_markdown: 'Evidence.\n' });
      const session = crypto.randomUUID(), home = process.env.CODEX_HOME;
      const native = focusedNativeSession({ session, worktree: scope.worktree, model: selection.model, effort: selection.effort,
        text, prompt: context.prompt });
      const now = new Date(), directory = path.join(home, 'sessions', String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
      fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, session + '.jsonl'), native);
      const calls = [], { EventEmitter } = require('node:events');
      const real = createCodexRuntimeHost({ scope, capabilities: options.capabilities, env: { CODEX_HOME: home },
        probe: { schema: 'shipyard.codex-runtime-probe.v1', version: 1, status: 'available', executable: 'codex',
          runtime_version: '0.155.1', capabilities: options.capabilities },
        recorderDir: path.join(f.storageRoot, 'real-receipts'), transcriptDir: path.join(f.storageRoot, 'real-transcripts'),
        spawn(_executable, args) {
          calls.push(args);
          const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 24037;
          child.stdin = { write() {}, end() {} };
          process.nextTick(() => { child.stdout.emit('data', Buffer.from(nativeStream(session, text))); child.emit('close', 0, null); });
          return child;
        } });
      const result = await real.launchStatic(selection, context);
      assert.equal(calls.length, 1);
      const sandbox = result.runtime_evidence.sandbox_evidence;
      assert.ok(calls[0].includes('permissions.shipyard-runtime.extends=":read-only"'));
      assert.equal(sandbox.base_profile, ':read-only');
      assert.equal(sandbox.evidence_write_path, undefined);
      assert.ok(!calls[0].find(value => value.startsWith('permissions.shipyard-runtime.filesystem=')).includes('="write"'));
      assert.deepEqual(result.runtime_evidence.integrator_review, binding);
      assert.equal(result.runtime_evidence.code_review, undefined);
      assert.equal(result.runtime_evidence.input_transport, undefined);
    });
  } finally { cleanupFixture(f); }
});
