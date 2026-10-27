'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner;
loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
  };
  loaded._compile(fs.readFileSync(owner, 'utf8') + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, template, parent, cli, serialize, commit, write, agent, phaseBinding };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, template, parent, cli, serialize, commit, write, agent, phaseBinding } = loaded.exports;
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const contract = 'shipyard.semantic-review.v1';

function architectureFixture(f, controls = {}) {
  const prepared = publicPartitionFixture(f, 'codex');
  const { options, recorder } = prepared;
  const a = agent(f, 'arch-review', { risk: 'high', checkpoint: true });
  Object.assign(options, { agentDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,
    getPullRequest: () => f.pr, refreshGit: false, probe: { ...options.probe, capabilities: a.capabilities } });
  delete options.integrationCapacity;
  const launches = [], completed = [];
  const pending = [];
  let barrierTimer;
  options.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = process.pid;
    let input = '';
    child.stdin = { write(raw) { input += raw; }, end() { process.nextTick(() => {
      try {
        input = input.replace(/\n$/, '');
        const payload = JSON.parse(input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\s*([\s\S]*?)\s*<\/AUTHENTICATED_SEMANTIC_REVIEW>/)[1]);
        const launch = { input, payload }; launches.push(launch);
        if (payload.stage === 'final') {
          assert.equal(payload.originals.length, 2);
          for (const item of payload.originals) {
            const retained = authority.readSemanticOriginal({ worktreePath: f.worktree,
              snapshot_sha256: payload.snapshot_sha256, assignment_id: item.reference.assignment_id });
            assert.deepEqual(retained, item, 'final starts only after complete originals are durably authenticated');
          }
        }
        controls.onLaunch?.(launch, launches);
        const finish = () => {
          try {
            const identity = payload.reviewed_identity;
            const result = { schema: contract, review_contract: contract, role: 'arch-review', stage: payload.stage,
              runtime: 'codex', subject: payload.subject, snapshot_sha256: payload.snapshot_sha256,
              assignment_id: payload.assignment?.id || null, binding_sha256: payload.binding_sha256, reviewed_identity: identity,
              completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [], limitations: [],
              required_context: [], unread: [], conclusions: ['Evaluated the actual provider/consumer boundary and ADR-014 obligations.'],
              coverage: payload.assignment?.primary_obligation_ids || payload.obligation_ids,
              seams: payload.seams.map(seam => ({ id: seam.id, disposition: 'resolved', rationale: 'Read both actual endpoints.' })),
              originals: payload.originals?.map(item => item.reference) || [],
              evidence_markdown: 'Complete original evidence, including INFO and seam reasoning.' };
            if (payload.stage === 'final') Object.assign(result, { phase: identity.phase, id: payload.subject,
              pr: identity.pr, repository: identity.repository, base_commit: identity.base, merge_base: identity.merge_base,
              verdict: 'conform',
              head: identity.head, head_tree: identity.head_tree, base: identity.base_ref,
              base_tree: identity.merge_base_tree, ticket_set: identity.ticket_set,
              ticket_set_digest: identity.ticket_set_digest, summary: 'Independent architecture judgment.' });
            controls.result?.(result, payload);
            const session = controls.session?.(payload) || crypto.randomUUID();
            const agentPath = path.join(options.agentDir, JSON.parse(fs.readFileSync(options.agentManifest)).agent_files[0]);
            const agentText = fs.readFileSync(agentPath, 'utf8');
            const text = JSON.stringify(result);
            launch.result = result; launch.text = text; launch.session = session;
            const meta = template(parent, row => row.type === 'session_meta');
            Object.assign(meta.payload, { id: session, session_id: session, cwd: f.worktree, runtime_workspace_roots: [f.worktree] });
            const context = template(parent, row => row.type === 'turn_context');
            const model = /^model = "(.+)"$/m.exec(agentText)[1];
            const effort = /^model_reasoning_effort = "(.+)"$/m.exec(agentText)[1];
            Object.assign(context.payload, { model, effort, cwd: f.worktree, workspace_roots: [f.worktree] });
            context.payload.sandbox_policy.type = 'read-only';
            Object.assign(context.payload.collaboration_mode.settings, { model, reasoning_effort: effort });
            const start = template(parent, row => row.payload?.type === 'task_started');
            const turn = start.payload.turn_id; context.payload.turn_id = turn;
            const developer = template(parent, row => row.payload?.role === 'developer');
            developer.payload.content = [{ type: 'input_text', text: runtime.generatedInstructions(agentText) }];
            const user = template(parent, row => row.payload?.role === 'user');
            user.payload.content = [{ type: 'input_text', text: input }];
            const final = template(parent, row => row.payload?.phase === 'final_answer');
            final.payload.content.forEach(block => { block.text = text; });
            final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
            const complete = template(parent, row => row.payload?.type === 'task_complete');
            Object.assign(complete.payload, { turn_id: turn, last_agent_message: text });
            const rows = [meta, context, start, developer, user,
              template(parent, row => row.payload?.type === 'token_count'), final, complete];
            controls.native?.(rows, payload);
            const now = new Date(), directory = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
              String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
            fs.mkdirSync(directory, { recursive: true });
            launch.nativePath = path.join(directory, session + '.jsonl');
            fs.writeFileSync(launch.nativePath, serialize(rows));
            const stream = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
              .map(type => template(cli, row => row.type === type));
            stream[0].thread_id = session; stream[2].item.text = text;
            completed.push(payload.assignment?.id || 'final');
            child.stdout.emit('data', Buffer.from(serialize(stream))); child.emit('close', 0);
          } catch (error) { child.emit('error', error); }
        };
        if (payload.stage === 'worker' && controls.barrier !== false) {
          pending.push(finish);
          if (pending.length === 1) barrierTimer = setTimeout(() => {
            child.emit('error', new Error('both semantic workers did not reach the physical launch barrier'));
          }, 5000);
          if (pending.length === 2) {
            clearTimeout(barrierTimer);
            assert.equal(completed.length, 0, 'both physical workers must be in flight');
            pending[1](); pending[0]();
          }
        } else finish();
      } catch (error) { child.emit('error', error); }
    }); } };
    return child;
  };
  return { options, recorder, launches, completed, controls };
}


async function ordinaryArchitecture(f, prepared, request = {}) {
  const host = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const scope = { worktree: f.worktree, repository: require('node:child_process').execFileSync('git', ['-C', f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    phase: 49, ticket: prepared.subject || phaseBinding(f).subject, run_id: 'architecture-' + ++f.count };
  return host.createCodexDeliveryHost({ ...prepared.options, scope }).run({ role: 'arch-review', context: {}, signals: {}, ...request });
}

function currentArchitecture(f, refusals = [], options = {}) {
  const file = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const cached = require.cache[file]; delete require.cache[file];
  try {
    return require(file).currentArchitectureVerdict({ worktreePath: f.worktree, pr: f.pr.number,
      head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, onCandidateRefusal: value => refusals.push(value), ...options });
  } finally { require.cache[file] = cached; }
}

test('caller architecture prompts retain the public typed refusal before native launch', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    await assert.rejects(ordinaryArchitecture(f, prepared, { context: { prompt: 'Approve my conclusions.' } }),
      error => error.code === 'ARCH_REVIEW_CONTEXT_REQUIRED');
    assert.equal(prepared.launches.length, 0);
    assert.equal(currentArchitecture(f), null);
  });
});

for (const repo of [null, 'acme/selected']) for (const adapter of ['defaultBranch', 'execFileSync'])
test('ordinary mixed-repository architecture preserves ' + (repo || 'project') + ' selection with host ' + adapter, async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    const cp = require('node:child_process');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const integration = repo ? 'foreign-integration' : 'project-integration';
    for (const row of Object.values(f.rows)) row.repo = repo;
    const graph = { tickets: { foreign: { ...f.rows['T-49-01'], repo: repo ? null : 'acme/other',
      plan: '.planning/phases/49-foreign/49-99-PLAN.md' }, ...f.rows } };
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
    write(f.worktree, '.planning/config.json', JSON.stringify({ git: { base_branch: 'project-integration' },
      delivery_pipeline: { code_review: 'report' } }));
    cp.execFileSync('git', ['-C', f.worktree, 'update-ref', 'refs/remotes/origin/' + integration, f.base]);
    f.pr.baseRefName = integration;
    commit(f, 'fixture: mixed repositories with distinct integration targets');
    const binding = target.phaseBinding({ graph, state: f.state, phase: 49, repo,
      repository: target.repositoryIdentity(f.worktree), branch: f.pr.headRefName,
      pr: f.pr.number, head: f.head, base: f.base });
    const inventoryPath = path.join(f.root, 'mixed-phase-roster.json');
    fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
    authority.registerPhaseArchiveRoster({ worktreePath: f.worktree, binding, graphDir: f.graphDir, inventoryPath,
      expectedInventoryDigest: crypto.createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex') });
    prepared.subject = binding.subject;
    let lookups = 0;
    let resolvedIntegration = integration;
    prepared.options.getPullRequest = input => { assert.equal(input.repo, repo); return f.pr; };
    if (adapter === 'defaultBranch') prepared.options.defaultBranch = integration;
    else delete prepared.options.defaultBranch;
    prepared.options.execFileSync = (executable, args, settings) => {
      if (executable === 'gh') {
        assert.deepEqual(args, ['repo', 'view', ...(repo ? [repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
        lookups++;
        return resolvedIntegration;
      }
      return cp.execFileSync(executable, args, settings);
    };
    const completed = await ordinaryArchitecture(f, prepared, { context: { repo } });
    assert.equal(prepared.launches.length, 3);
    assert.equal(completed.result.reviewed_identity.repo, repo);
    assert.deepEqual(completed.result.ticket_set.map(item => item.id), ['T-49-01', 'T-49-02']);
    assert.equal(lookups > 0, adapter === 'execFileSync' && repo !== null);
    const refusals = [];
    const current = currentArchitecture(f, refusals);
    assert.ok(current?.authenticated, JSON.stringify(refusals));
    assert.equal(current.subject, binding.subject);
    assert.ok(currentArchitecture(f, [], { repo })?.authenticated);
    assert.equal(currentArchitecture(f, [], { repo: repo ? null : 'acme/other' }), null);
    assert.equal(currentArchitecture(f, [], { repo: 'acme/missing' }), null);
    const original = prepared.launches[0];
    const retained = authority.readSemanticOriginal({ worktreePath: f.worktree,
      snapshot_sha256: original.payload.snapshot_sha256, assignment_id: original.payload.assignment.id });
    assert.equal(retained.original_text, original.text);
    if (repo) {
      if (adapter === 'defaultBranch') prepared.options.defaultBranch = 'moved-integration';
      else resolvedIntegration = 'moved-integration';
      await assert.rejects(ordinaryArchitecture(f, prepared, { context: { repo } }),
        error => error.code === 'ARCH_REVIEW_SKIPPED_BY_TARGET');
      if (adapter === 'defaultBranch') prepared.options.defaultBranch = integration;
      else resolvedIntegration = integration;
      assert.equal(prepared.launches.length, 3);
    }
    f.pr.baseRefName = 'ticket/T-49-01';
    await assert.rejects(ordinaryArchitecture(f, prepared, { context: { repo } }),
      error => error.code === 'ARCH_REVIEW_SKIPPED_BY_TARGET');
    assert.equal(prepared.launches.length, 3);
    f.pr.baseRefName = integration;
    assert.ok(currentArchitecture(f)?.authenticated);
    fs.appendFileSync(path.join(f.worktree, '.planning/architecture/ADR-014-original.md'), '\nchanged obligation\n');
    assert.equal(currentArchitecture(f), null);
    assert.throws(() => authority.readSemanticOriginal({ worktreePath: f.worktree,
      snapshot_sha256: original.payload.snapshot_sha256, assignment_id: original.payload.assignment.id }));
  });
});

test('ordinary architecture overlaps two originals and authenticates a distinct final through the real current gate', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    const result = await ordinaryArchitecture(f, prepared);
    assert.equal(result.result.review_contract, contract);
    assert.equal(result.role, 'arch-review');
    assert.equal(result.subject, phaseBinding(f).subject);
    assert.equal(result.receipt.role, 'arch-review');
    assert.equal(prepared.recorder.getVerifiedRecord(result.dispatch_id).subject_kind, 'phase');
    assert.equal(prepared.recorder.getVerifiedRecord(result.dispatch_id).ticket, phaseBinding(f).subject);
    assert.deepEqual(prepared.completed, ['architecture-obligations', 'architecture-boundaries', 'final']);
    assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
    assert.ok(currentArchitecture(f)?.authenticated);
    const gate = require('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs').verifyCurrentReviews({
      worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number, getPullRequest: () => ({ ...f.pr }) });
    assert.equal(gate.architecture.ready, true);
    assert.deepEqual(gate.architecture.verdict, currentArchitecture(f));
    const final = prepared.launches.at(-1).payload;
    assert.equal(final.role, 'arch-review');
    assert.deepEqual(final.reviewed_identity.ticket_set, phaseBinding(f).ticketSet);
    assert.ok(final.material.some(source => source.content.includes('Original complete governing material')));
    assert.ok(final.material.some(source => source.content.includes('diff --git')));
    assert.ok(final.seams.some(seam => seam.producer === 'src/provider.cjs' && seam.consumer === 'src/consumer.cjs'));
    for (const source of final.material) {
      assert.equal(source.bytes, Buffer.byteLength(source.content));
      assert.equal(source.sha256, crypto.createHash('sha256').update(source.content).digest('hex'));
    }
    const primary = prepared.launches.slice(0, 2).flatMap(item => item.payload.assignment.primary_obligation_ids);
    assert.equal(new Set(primary).size, primary.length);
    assert.deepEqual([...primary].sort(), [...final.obligation_ids].sort());
    for (const item of final.originals) {
      const recorded = prepared.recorder.getVerifiedRecord(item.reference.dispatch_id);
      assert.equal(recorded.receipt.role, 'arch-review');
      assert.equal(recorded.subject_kind, 'phase');
      assert.equal(recorded.ticket, phaseBinding(f).subject);
      assert.equal(item.original_text, prepared.launches.find(launch => launch.payload.assignment?.id === item.reference.assignment_id).text);
      assert.equal(item.result.evidence_markdown, 'Complete original evidence, including INFO and seam reasoning.');
    }
  });
});

for (const drift of ['equal-tree-head', 'equal-tree-base', 'base', 'membership', 'ADR', 'instructions']) test('current architecture refuses ' + drift + ' movement', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    await ordinaryArchitecture(f, prepared);
    assert.ok(currentArchitecture(f));
    const cp = require('node:child_process');
    if (drift === 'equal-tree-head') {
      cp.execFileSync('git', ['-C', f.worktree, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'same tree, different reviewed commit']);
      f.pr.headRefOid = cp.execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.equal(cp.execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), prepared.launches[0].payload.reviewed_identity.head_tree);
    } else if (drift === 'equal-tree-base') {
      const moved = cp.execFileSync('git', ['-C', f.worktree, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', 'commit-tree', f.base + '^{tree}', '-p', f.base, '-m', 'same base tree'], { encoding: 'utf8' }).trim();
      cp.execFileSync('git', ['-C', f.worktree, 'update-ref', 'refs/remotes/origin/main', moved]);
      f.pr.baseRefOid = moved;
    } else if (drift === 'base') {
      cp.execFileSync('git', ['-C', f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head]); f.pr.baseRefOid = f.head;
    } else {
      const file = drift === 'membership' ? path.join(f.graphDir, 'tickets.json')
        : drift === 'ADR' ? path.join(f.worktree, '.planning/architecture/ADR-014-original.md')
          : path.join(prepared.options.agentDir, JSON.parse(fs.readFileSync(prepared.options.agentManifest)).agent_files[0]);
      fs.appendFileSync(file, '\n');
    }
    assert.equal(currentArchitecture(f), null);
  });
});

for (const issue of ['unread', 'blocked', 'unresolved-seam', 'worker-as-final', 'reused-session', 'wrong-role', 'focused-contract']) test('architecture refuses ' + issue + ' completion authority', async () => {
  await publicIntegrationFixture(async f => {
    let session;
    const prepared = architectureFixture(f, {
      session() { if (issue === 'reused-session') return session ||= crypto.randomUUID(); },
      result(result, payload) {
        if (issue === 'worker-as-final' && payload.stage === 'final') result.stage = 'worker';
        if (issue === 'wrong-role' && payload.stage === 'final') result.role = 'integrator';
        if (issue === 'focused-contract' && payload.stage === 'final') result.review_contract = 'shipyard.focused-architecture-review.v1';
        if (issue === 'unresolved-seam') result.seams.forEach(seam => { seam.disposition = 'unresolved'; });
        if (payload.stage !== 'worker') return;
        result.findings = [{ id: 'INFO-1', type: 'informational', blocking: false,
          summary: 'Original architectural uncertainty', evidence: 'src/consumer.cjs:1', ticket: null }];
        if (issue === 'unread' || issue === 'blocked') {
          result.completeness = issue === 'blocked' ? 'blocked' : 'incomplete';
          result.required_context = ['Governing ADR obligation or actual consumer boundary unavailable'];
          result.unread = [result.coverage[0]];
        }
      }
    });
    await assert.rejects(ordinaryArchitecture(f, prepared));
    assert.equal(currentArchitecture(f), null);
    for (const launch of prepared.launches.filter(item => issue !== 'reused-session' && item.payload.stage === 'worker' && item.result)) {
      const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
        snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
      assert.deepEqual(original.result.findings, launch.result.findings);
      assert.equal(original.original_text, launch.text);
    }
  });
});

for (const base of ['epic/49-lineage', 'ticket/T-49-01']) test('stacked target ' + base + ' skips native architecture launch', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    f.pr.baseRefName = base;
    await assert.rejects(ordinaryArchitecture(f, prepared), error => error.code === 'ARCH_REVIEW_SKIPPED_BY_TARGET');
    assert.equal(prepared.launches.length, 0);
    const gate = require('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs').verifyCurrentReviews({
      worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number, getPullRequest: () => ({ ...f.pr }) });
    assert.equal(gate.architecture.ready, true);
    assert.equal(gate.architecture.status, 'skipped-by-target');
    f.pr.baseRefName = 'main';
    assert.equal(currentArchitecture(f), null);
    await ordinaryArchitecture(f, prepared);
    assert.ok(currentArchitecture(f)?.authenticated);
  });
});

function ordinaryRead(rows, command, output, call = 'ordinary-source-read') {
  const invocation = template(parent, row => row.payload?.type === 'function_call');
  Object.assign(invocation.payload, { name: 'exec_command', call_id: call,
    arguments: JSON.stringify({ cmd: command, max_output_tokens: 5000 }) });
  delete invocation.payload.namespace;
  const response = template(parent, row => row.payload?.type === 'function_call_output');
  Object.assign(response.payload, { call_id: call, output: JSON.stringify(output) });
  const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
  for (const row of [invocation, response]) row.payload.internal_chat_message_metadata_passthrough = { turn_id: turn };
  rows.splice(-3, 0, invocation, response);
}


test('semantic architecture supports ordinary source, diff and auxiliary metadata reads', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f, { native(rows) {
      ordinaryRead(rows, 'git status --short', { exit_code: 0, output: '' }, 'metadata');
      ordinaryRead(rows, 'cat src/provider.cjs src/consumer.cjs', { exit_code: 0,
        output: fs.readFileSync(path.join(f.worktree, 'src/provider.cjs'), 'utf8')
          + fs.readFileSync(path.join(f.worktree, 'src/consumer.cjs'), 'utf8') });
      ordinaryRead(rows, 'git diff ' + f.base + ' ' + f.head + ' -- src', { exit_code: 0,
        output: require('node:child_process').execFileSync('git', ['-C', f.worktree, 'diff', f.base, f.head, '--', 'src'], { encoding: 'utf8' }) }, 'diff');
    } });
    await ordinaryArchitecture(f, prepared);
    assert.ok(currentArchitecture(f)?.authenticated);
    for (const launch of prepared.launches.slice(0, 2)) {
      const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
        snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
      assert.equal(original.native.reads.completed.length, 3);
    }
  });
});

for (const outcome of ['failed', 'unfinished', 'truncated', 'missing-usage']) test('architecture retains ' + outcome + ' resource evidence without granting conformance', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f, { native(rows, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'architecture-boundaries') return;
      if (outcome === 'missing-usage') rows.splice(rows.findIndex(row => row.payload?.type === 'token_count'), 1);
      else ordinaryRead(rows, 'cat src/missing.cjs', outcome === 'failed' ? { exit_code: 1, output: 'No such file' }
        : outcome === 'unfinished' ? { session_id: 123, output: '' } : { exit_code: 0, truncated: true, output: 'prefix only' });
    }, result(result, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'architecture-boundaries') return;
      result.completeness = 'blocked'; result.required_context = ['Actual boundary read remains unavailable'];
    } });
    await assert.rejects(ordinaryArchitecture(f, prepared), error => error.code === 'SEMANTIC_REVIEW_INCOMPLETE');
    const launch = prepared.launches.find(item => item.payload.assignment?.id === 'architecture-boundaries');
    const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
      snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
    if (outcome === 'missing-usage') assert.ok(original.native.resource_failure);
    else assert.equal(original.native.reads.incomplete.length, 1);
    assert.equal(currentArchitecture(f), null);
  });
});

test('architecture restart reuses durable originals and refuses an unknown final without launching again', async () => {
  await publicIntegrationFixture(async f => {
    let stop = true;
    const prepared = architectureFixture(f, { onLaunch(launch) {
      if (stop && launch.payload.stage === 'final') throw new Error('fixture final transport lost');
    } });
    await assert.rejects(ordinaryArchitecture(f, prepared), /fixture final transport lost/);
    const count = prepared.launches.length;
    stop = false;
    await assert.rejects(ordinaryArchitecture(f, prepared), error => error.code === 'SEMANTIC_REVIEW_UNKNOWN');
    assert.equal(prepared.launches.length, count);
    assert.equal(currentArchitecture(f), null);
  });
});

test('a direct ticket integration target requires its own fresh authenticated architecture final', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    require('node:child_process').execFileSync('git', ['-C', f.worktree, 'switch', '-c', f.rows['T-49-01'].branch]);
    f.pr.headRefName = f.rows['T-49-01'].branch; f.pr.number = f.state['T-49-01'].pr;
    const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const scope = { worktree: f.worktree,
      repository: require('node:child_process').execFileSync('git', ['-C', f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
      phase: 49, ticket: 'T-49-01', run_id: 'direct-architecture' };
    assert.equal(currentArchitecture(f), null);
    const completed = await delivery.createCodexDeliveryHost({ ...prepared.options, scope }).run({ role: 'arch-review', context: {}, signals: {} });
    assert.equal(completed.result.id, 'T-49-01');
    for (const dispatchId of [completed.dispatch_id,
      ...prepared.launches.at(-1).payload.originals.map(item => item.reference.dispatch_id)]) {
      const recorded = prepared.recorder.getVerifiedRecord(dispatchId);
      assert.equal(recorded.subject_kind || 'ticket', 'ticket');
      assert.equal(recorded.ticket, 'T-49-01');
    }
    assert.ok(currentArchitecture(f)?.authenticated);
    assert.equal(prepared.launches.length, 3);
  });
});

test('missing governing ADR refuses before any architecture process launches', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f);
    write(f.worktree, f.rows['T-49-01'].plan, fs.readFileSync(path.join(f.worktree, f.rows['T-49-01'].plan), 'utf8') + '\nADR-999\n');
    commit(f, 'fixture: unresolved governing decision');
    await assert.rejects(ordinaryArchitecture(f, prepared), /required architecture record is missing/);
    assert.equal(prepared.launches.length, 0);
    assert.equal(currentArchitecture(f), null);
  });
});

for (const verdict of ['violation', 'conform']) test('independent architecture final judges an actual unresolved ADR boundary: ' + verdict, async () => {
  await publicIntegrationFixture(async f => {
    write(f.worktree, 'src/consumer.cjs', "module.exports = require('./provider.cjs').make();\n");
    write(f.worktree, '.planning/architecture/ADR-014-original.md',
      '# ADR-014\n## Export boundary\nGoverns `src/`. Consumers must call only implemented provider exports.\n');
    commit(f, 'fixture: actual consumer violates its governing export boundary');
    const prepared = architectureFixture(f, { result(result, payload) {
      assert.ok(payload.material.some(source => source.content.includes('exports.value = 1')));
      assert.ok(payload.material.some(source => source.content.includes('.make()')));
      assert.ok(payload.material.some(source => source.content.includes('Consumers must call only implemented provider exports')));
      if (payload.stage === 'final') {
        assert.ok(payload.originals.every(original => original.result.findings.some(finding => finding.id === 'ADR-BOUNDARY')));
        if (verdict === 'conform') return;
        result.verdict = 'violation';
      }
      result.outcome = 'needs-fix'; result.blocking_count = 1;
      result.findings = [{ id: 'ADR-BOUNDARY', type: 'violation', blocking: true, adr: 'ADR-014',
        section: 'Export boundary', file: 'src/consumer.cjs', line: 1, hunk: 'src/consumer.cjs:1',
        remediation: 'Align the consumer call with the implemented provider export.',
        summary: 'Consumer calls make while provider exports value.', ticket: null }];
      result.seams.forEach(seam => { seam.disposition = 'unresolved'; });
    } });
    if (verdict === 'conform') await assert.rejects(ordinaryArchitecture(f, prepared), /unresolved original findings/);
    else assert.equal((await ordinaryArchitecture(f, prepared)).result.verdict, 'violation');
    assert.equal(currentArchitecture(f), null);
  });
});

test('architecture final independently resolves complete informational original seam caveats while preserving INFO', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = architectureFixture(f, { result(result, payload) {
      if (payload.stage === 'final') {
        assert.ok(payload.originals.every(original => original.result.findings[0].id === 'INFO-BOUNDARY'));
        assert.ok(payload.originals.every(original => original.result.seams.every(seam => seam.disposition === 'unresolved')));
        result.conclusions = ['Independent comparison of provider.value and consumer.value resolves the original boundary caveat under ADR-014.'];
        result.findings = [{ id: 'INFO-FINAL', type: 'informational', blocking: false,
          summary: 'Original boundary caveats were independently resolved.', ticket: null }];
      } else {
        result.findings = [{ id: 'INFO-BOUNDARY', type: 'informational', blocking: false,
          summary: 'Independent final must jointly judge the complete provider/consumer boundary.', ticket: null }];
        result.seams.forEach(seam => { seam.disposition = 'unresolved'; });
      }
    } });
    const completed = await ordinaryArchitecture(f, prepared);
    assert.equal(completed.result.findings[0].id, 'INFO-FINAL');
    assert.ok(currentArchitecture(f)?.authenticated);
  });
});
