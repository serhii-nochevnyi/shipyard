'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const serialize = records => records.map(record => JSON.stringify(record) + '\n').join('');
const captureRoot = path.resolve(__dirname, '../fixtures/captured');
const registry = JSON.parse(fs.readFileSync(path.join(captureRoot, 'boundaries/codex-agent-stream.json')));
function captured(name) {
  const relative = registry.fixtures.find(file => file.endsWith('/codex-agent-stream-' + name + '.jsonl'));
  assert.ok(relative, 'original native shapes must be registered');
  return fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(record => !record.shipyard_fixture);
}
const cli = captured('exec');
const parent = captured('parent');
function template(records, predicate) {
  const original = records.find(predicate);
  assert.ok(original, 'registered native template is required');
  return structuredClone(original);
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}
function write(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function commit(f, message) {
  git(f.worktree, 'add', 'src', '.planning'); git(f.worktree, 'commit', '-qm', message);
  f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
  git(f.worktree, 'update-ref', 'refs/remotes/origin/' + f.pr.headRefName, f.head);
}

const secondRuntime = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');

test('focused original inline judgment reaches finish, archive lookup and the existing live gate without reads', async () => {
  await fixture(async f => {
    const reviewed = await runFocusedArchitecture(f);
    assert.equal(reviewed.receipt.runtime_evidence.input_consumption, undefined);
    assert.equal(reviewed.receipt.runtime_evidence.focused_review.review_contract, collector.FOCUSED_CONTRACT);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    git(f.worktree, 'commit', '--allow-empty', '-qm', 'tree-equal moved focused head');
    f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

for (const completeness of ['complete', 'incomplete']) test('direct ticket original ' + completeness + ' architecture reaches actual sentinel duty and live merge', async () => {
  await fixture(async f => {
    f.directTicket = 'T-49-01';
    git(f.worktree, 'switch', '-qc', f.rows[f.directTicket].branch);
    f.pr.headRefName = f.rows[f.directTicket].branch;
    f.rows[f.directTicket].human_checkpoint = false;
    f.rows[f.directTicket].risk = 'medium';
    f.state[f.directTicket] = { status: 'pr-open', pr: f.pr.number, branch: f.pr.headRefName };
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    commit(f, 'direct ticket review subject');
    const sentinel = require.resolve('../../plugins/delivery-pipeline/scripts/sentinel.cjs');
    const preload = path.join(f.root, 'fixture-home.cjs');
    fs.writeFileSync(preload, "require('node:os').homedir = () => " + JSON.stringify(f.root) + ';');
    const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
    const live = path.join(f.root, 'live-pr.json');
    fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\n' +
      "const args = process.argv.slice(2); if (args[0] === 'pr' && args[1] === 'view') " +
      "process.stdout.write(require('fs').readFileSync(" + JSON.stringify(live) + ")); " +
      "else if (args[0] === 'repo') console.log('main'); else process.exit(1);\n", { mode: 0o755 });
    const invoke = args => JSON.parse(execFileSync(process.execPath, [sentinel, ...args, '--json'], {
      cwd: f.worktree, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        NODE_OPTIONS: '--require=' + preload } }));
    const project = (worktree = f.worktree) => {
      fs.writeFileSync(live, JSON.stringify(f.pr));
      const admitted = require('../../plugins/delivery-pipeline/scripts/state-sync.cjs').currentReviewAdmission({ ...currentSubject(f),
        worktreePath: worktree, graphDir: path.join(worktree, '.planning/graph') });
      const entry = { ...f.state[f.directTicket], draft: false, merge_scope: 'integration',
        epic: f.rows[f.directTicket].epic, pr_base: f.pr.baseRefName, integration_branch: 'main',
        head_sha: f.pr.headRefOid, pr_base_sha: f.pr.baseRefOid,
        checks: { total: 3, failing: 0, pending: 0, none_reported: false },
        authenticated_architecture: admitted?.architecture.verdict || null };
      write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify({ ...f.state, [f.directTicket]: entry }));
      return invoke(['duty', '--scope', f.directTicket]);
    };
    const assertOwed = duty => {
      assert.equal(duty.items[0].action, 'arch-review'); assert.equal(duty.actionable_count, 1);
      assert.equal(duty.human_count, 0); assert.equal(duty.clear, false);
    };
    assertOwed(project());
    for (const dry of [[], ['--dry-run']]) {
      const row = invoke(['merge', f.directTicket, ...dry]).results[0];
      assert.equal(row.merged, false); assert.equal(row.would_merge, undefined);
      assert.match(row.blockers.join('; '), /fresh authenticated architecture/);
    }
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    await runFocusedArchitecture(f, result => {
      if (completeness === 'incomplete') {
        result.review_completeness = 'incomplete'; result.limitations = ['Unresolved consumer'];
        result.unresolved_sources = ['src/consumer.cjs'];
      }
    });
    const duty = project();
    if (completeness === 'incomplete') { assertOwed(duty); return; }
    assert.equal(duty.items[0].action, 'human-merge'); assert.equal(duty.human_count, 1);
    assert.equal(duty.actionable_count, 0); assert.equal(duty.waiting_count, 0); assert.equal(duty.clear, true);
    for (const dry of [[], ['--dry-run']]) {
      const row = invoke(['merge', f.directTicket, ...dry]).results[0];
      assert.equal(row.merged, false); assert.equal(row.would_merge, undefined);
      assert.match(row.blockers.join('; '), /integration branch.*human/);
    }
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head);
    f.pr.baseRefOid = f.head;
    assertOwed(project());
    const movedBase = invoke(['merge', f.directTicket, '--dry-run']).results[0];
    assert.equal(movedBase.merged, false); assert.equal(movedBase.would_merge, undefined);
    assert.match(movedBase.blockers.join('; '), /fresh authenticated architecture/);
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
    f.pr.baseRefOid = f.base;
    const foreign = path.join(f.root, 'foreign-repository');
    git(f.root, 'clone', '--quiet', '--no-hardlinks', f.worktree, foreign);
    assert.notEqual(git(foreign, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    assertOwed(project(foreign));
    assert.equal(project().items[0].action, 'human-merge');
    git(f.worktree, 'commit', '--allow-empty', '-qm', 'tree-equal moved direct head');
    f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
    assertOwed(project());
    const stale = invoke(['merge', f.directTicket, '--dry-run']).results[0];
    assert.equal(stale.merged, false); assert.equal(stale.would_merge, undefined);
    assert.match(stale.blockers.join('; '), /fresh authenticated architecture/);
  });
});

test('focused incomplete original review retains limitations and findings but cannot grant current conformance', async () => {
  await fixture(async f => {
    const reviewed = await runFocusedArchitecture(f, result => {
      result.review_completeness = 'incomplete'; result.unresolved_sources = ['src/consumer.cjs'];
      result.limitations = ['Consumer boundary remains unresolved'];
    });
    assert.equal(reviewed.result.review_completeness, 'incomplete');
    const manifest = JSON.parse(fs.readFileSync(reviewed.artifact.ref));
    assert.equal(manifest.current_review.review_completeness, 'incomplete');
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

for (const producer of ['codex', 'claude']) test(producer + ' large diff reaches original finish, archive and live gate while the reviewer reads it through git', async () => {
  await claudeFixture(async f => {
    const line = 'complete current producer and consumer boundary';
    write(f.worktree, 'src/provider.cjs', Array.from({ length: 24000 }, (_, index) =>
      'exports.field' + index + ' = "' + line + '";').join('\n') + '\n');
    commit(f, 'large diff source');
    const reviewed = producer === 'codex' ? await runFocusedArchitecture(f) : await runClaudeCurrentReview(f, 'arch-review');
    const manifest = JSON.parse(fs.readFileSync(reviewed.artifact.ref));
    assert.equal(manifest.current_review.contract, collector.FOCUSED_CONTRACT);
    assert.equal(manifest.current_review.review_completeness, 'complete');
    const prompt = producer === 'codex' ? collector.admittedPrompt(f.lastArchitecture) : f.lastClaudeUserInput.message.content;
    assert.doesNotMatch(prompt, new RegExp(line), 'the diff is not in the prompt');
    assert.doesNotMatch(prompt, /AUTHENTICATED_FOCUSED_INPUT/);
    if (producer === 'codex') assert.equal(reviewed.receipt.runtime_evidence.input_transport, undefined);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
  });
});

for (const [name, edit] of [
  ['forged contract', result => { result.review_contract = 'forged'; }],
  ['wrong repository', result => { result.repository += '-foreign'; }],
  ['wrong membership', result => { result.ticket_set_digest = '0'.repeat(64); }],
  ['wrong base', result => { result.base_commit = '0'.repeat(40); }],
  ['wrong launch', result => { result.launch_digest = '0'.repeat(64); }],
  ['malformed completeness', result => { result.review_completeness = 'maybe'; }],
  ['contradictory complete', result => { result.unresolved_sources = ['current-pr.diff:partition-2']; }],
]) test('focused original completion refuses ' + name, async () => {
  await fixture(async f => {
    await assert.rejects(runFocusedArchitecture(f, edit));
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

test('Claude original incomplete focused judgment is archived without granting conformance', async () => {
  await claudeFixture(async f => {
    const reviewed = await runClaudeCurrentReview(f, 'arch-review', { originalResult(result) {
      result.review_completeness = 'incomplete'; result.limitations = ['Consumer boundary unresolved'];
      result.unresolved_sources = ['src/consumer.cjs'];
    } });
    const manifest = JSON.parse(fs.readFileSync(reviewed.artifact.ref));
    assert.equal(manifest.current_review.review_completeness, 'incomplete');
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

async function runFocusedArchitecture(f, edit = () => {}) {
  const dispatchId = 'focused-original-' + ++f.count;
  prepareArchitecture(f, 'arch-review', dispatchId);
  const prepared = f.lastArchitecture;
  const scope = { worktree: f.worktree, ticket: prepared.prepared.ticket, phase: 49, run_id: dispatchId };
  const prompt = collector.admittedPrompt(prepared);
  const binding = collector.authenticateFocusedLaunch(prepared, prompt, { ...scope, dispatch_id: dispatchId });
  const result = { ...binding, ticket_set: prepared.prepared.binding?.ticketSet || [prepared.prepared.ticket],
    verdict: 'conform', blocking_count: 0, findings: [], summary: 'Independent focused judgment',
    review_completeness: 'complete', limitations: [], unresolved_sources: [],
    evidence_markdown: 'Complete independent review of the current diff and selected governing ADR.' };
  edit(result);
  const a = f.agents['arch-review'], session = crypto.randomUUID(), text = JSON.stringify(result);
  const native = nativeRecords(scope, session, a.selection, text, prompt);
  const now = new Date(), dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, session + '.jsonl'), serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed'].map(type => template(cli, r => r.type === type));
  records[0].thread_id = session; records[2].item.text = text;
  const recorder = boundary.createDurableRecorder(path.join(f.root, 'focused-receipts'));
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: { CODEX_HOME: process.env.CODEX_HOME }, transcriptDir: path.join(f.root, 'focused-transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const processFixture = new EventEmitter(); processFixture.stdout = new EventEmitter(); processFixture.stderr = new EventEmitter(); processFixture.pid = process.pid;
      processFixture.stdin = { write() {}, end() { process.nextTick(() => {
        processFixture.stdout.emit('data', Buffer.from(serialize(records))); processFixture.emit('close', 0);
      }); } }; return processFixture;
    } });
  const launched = await host.launchStatic({ model: a.selection.model, effort: a.selection.effort, sandbox_mode: 'read-only',
    agent_file: a.selection.agent_file, agent_file_content: a.text, agent_file_digest: hash(a.text) },
    { dispatch_id: dispatchId, prompt, focused_prepared: prepared });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched } });
  const dispatched = boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch(
    { runtime: 'codex', role: 'arch-review', dispatch_id: dispatchId, signals: prepared.launch.signals },
    { ticket: scope.ticket, ...(prepared.prepared.binding ? { subject_kind: 'phase' } : {}) });
  return collector.finish(prepared, dispatched, recorder);
}

function currentSubject(f) {
  return { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
    getPullRequest: () => f.pr };
}
function admissionDiagnostic(f, consumer) {
  const refusals = [];
  try {
    authority.currentArchitectureVerdict({ worktreePath: f.worktree, graphDir: f.graphDir,
      pr: f.pr.number, head: f.head, headBranch: f.pr.headRefName,
      baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid,
      onCandidateRefusal: refusal => refusals.push(refusal) });
  } catch (error) { refusals.push({ code: error.code, message: error.message }); }
  return JSON.stringify({ admission: consumer(currentSubject(f)), refusals });
}
const gate = require('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs');
const consumers = [gate.verifyCurrentReviews,
  require('../../plugins/delivery-pipeline/scripts/sentinel.cjs').currentReviewAdmission,
  require('../../plugins/delivery-pipeline/scripts/state-sync.cjs').currentReviewAdmission];

function projectOptions(f) {
  const live = branch => {
    const id = Object.keys(f.rows).find(id => f.rows[id].branch === branch);
    return { number: f.state[id].pr, state: 'MERGED', mergedAt: '2026-10-09T12:00:00Z',
      headRefName: branch, headRefOid: f.memberHead, baseRefName: f.pr.headRefName,
      mergeCommit: { oid: f.memberHead }, isDraft: false, title: id, body: id };
  };
  return { graphDir: f.graphDir, defaultBranch: 'main', refreshGit: false,
    listPullRequests: ({ branch }) => [live(branch)],
    getPullRequest: ({ pr }) => live(Object.keys(f.rows).map(id => f.rows[id].branch)
      .find(branch => live(branch).number === pr)),
    execFileSync(file, args, options) {
      if (file === 'git' && args.includes('fetch')) return '';
      return execFileSync(file, args, options);
    } };
}

test('last-moment live PR or membership drift re-owes the architecture verdict', async () => {
  await claudeFixture(async f => {
    await runClaudeCurrentReview(f, 'arch-review');
    for (const [field, changed] of [['headRefOid', 'f'.repeat(40)], ['baseRefOid', 'f'.repeat(40)],
      ['baseRefName', 'another-target'], ['headRefName', 'another-branch']]) {
      for (const consumer of consumers) {
        let calls = 0;
        const admitted = consumer({ ...currentSubject(f), getPullRequest: () => ++calls === 1 ? f.pr : { ...f.pr, [field]: changed } });
        assert.equal(calls, 2); assert.equal(admitted.architecture.ready, false);
      }
    }
    let calls = 0;
    const admitted = gate.verifyCurrentReviews({ ...currentSubject(f), getPullRequest: () => {
      if (++calls === 2) write(f.worktree, '.planning/graph/delivery-state.json', '{}'); return f.pr;
    } });
    assert.equal(admitted.architecture.ready, false);
  });
});

test('ticket and stacked targets preserve skipped-by-target architecture policy', async () => {
  await fixture(async f => {
    for (const base of ['ticket/T-49-01', 'epic/49-parent']) for (const consumer of consumers) {
      const admitted = consumer({ ...currentSubject(f), getPullRequest: () => ({ ...f.pr, baseRefName: base }) });
      assert.equal(admitted.architecture.status, 'skipped-by-target');
      assert.equal(admitted.architecture.ready, true);
    }
  });
});

test('genuine finalized Claude receipts admit full architecture at all current consumers', async () => {
  for (const role of ['arch-review']) await claudeFixture(async f => {
    const scratch = require('../../plugins/delivery-pipeline/scripts/conveyor-scratch.cjs');
    const before = scratch.statusIgnoringScratch(f.worktree, { forJudge: false });
    assert.equal(before.ok, true);
    assert.deepEqual(before.entries, []);
    const fresh = await runClaudeCurrentReview(f, role);
    const receipt = fresh.dispatch.receipt;
    assert.equal(receipt.runtime, 'claude');
    assert.equal(receipt.runtime_evidence, undefined);
    assert.ok(receipt.session_id);
    assert.notEqual(receipt.transcript.path, claudeNativePin(receipt).path);
    for (const pin of [receipt.transcript, claudeNativePin(receipt)]) {
      const original = fs.readFileSync(pin.path);
      assert.equal(original.length, pin.bytes);
      assert.equal(hash(original), pin.sha256);
    }
    const native = fs.readFileSync(claudeNativePin(receipt).path, 'utf8');
    const userRecords = native.trim().split('\n').map(JSON.parse).filter(row => row.type === 'user');
    assert.equal(userRecords.length, 1);
    assert.equal(userRecords[0].sessionId, receipt.session_id);
    assert.deepEqual(userRecords[0].message, f.lastClaudeUserInput.message);
    if (role === 'arch-review') {
      const manifest = JSON.parse(fs.readFileSync(fresh.artifact.ref));
      const findings = JSON.parse(fs.readFileSync(path.join(f.worktree, manifest.files.findings.path)));
      assert.notEqual(hash(JSON.stringify(findings.ticket_set)), manifest.ticket_set_digest);
      assert.equal(hash(JSON.stringify(phaseBinding(f).ticketSet)), manifest.ticket_set_digest);
      assert.deepEqual(findings.ticket_set, f.lastClaudePacket.role_context.ticket_set);
      assert.equal(f.lastClaudePacket.required_refs.some(ref => ref.path === '.planning/graph/tickets.json'), false);
      const stateRef = f.lastClaudePacket.required_refs.find(ref => ref.path === '.planning/graph/delivery-state.json');
      assert.ok(stateRef, JSON.stringify({ contract: f.lastClaudePacket.role_context.review_contract,
        required_refs: f.lastClaudePacket.required_refs.map(ref => ref.path), dispatch_id: receipt.dispatch_id }));
      assert.equal(hash(stateRef.content), stateRef.sha256);
      assert.equal(Buffer.byteLength(stateRef.content), stateRef.bytes);
      const originalState = JSON.parse(stateRef.content);
      const currentGraph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
      const originalBinding = target.phaseBinding({ graph: currentGraph, state: originalState.tickets || originalState,
        phase: 49, repository: git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        branch: f.pr.headRefName, pr: f.pr.number, head: f.head, base: f.pr.baseRefOid });
      assert.equal(originalBinding.subject, manifest.boundary_subject);
      assert.equal(originalBinding.membership, manifest.ticket_set_digest);
      assert.equal(hash(JSON.stringify(originalBinding.ticketSet)), manifest.ticket_set_digest);
      assert.deepEqual(originalBinding.ticketSet, findings.ticket_set);
    }
    for (const consumer of consumers) {
      const admitted = consumer(currentSubject(f));
      assert.equal(admitted.architecture.ready, true, admissionDiagnostic(f, consumer));
    }
    if (role === 'arch-review') {
      const dirty = scratch.statusIgnoringScratch(f.worktree, { forJudge: false });
      assert.equal(dirty.ok, true);
      for (const relative of ['.planning/graph/dispatches.json',
        '.planning/graph/provenance/' + receipt.dispatch_id + '.json']) {
        assert.ok(dirty.entries.some(entry => entry.status === '??' && entry.path === relative), relative);
      }
    }
  });
});

for (const [name, edit] of [
  ['absent original user packet', rows => rows.shift()],
  ['duplicate original user packet', rows => rows.unshift(structuredClone(rows[0]))],
  ['foreign original user session', rows => { rows[0].sessionId = crypto.randomUUID(); }],
  ['changed complete original membership with unchanged digest', rows => {
    const text = rows[0].message.content;
    const match = /<AUTHENTICATED_CONTEXT_PACKET>\s*([\s\S]*?)\s*<\/AUTHENTICATED_CONTEXT_PACKET>/.exec(text);
    const packet = packets.decodeUniqueContent(JSON.parse(match[1]));
    packet.role_context.ticket_set[0].row.title = 'Altered original membership';
    rows[0].message.content = text.replace(match[1], JSON.stringify(packets.encodeUniqueContent(packet)));
  }],
  ['altered original governing source with repinned semantic content', rows => {
    const text = rows[0].message.content;
    const match = /<AUTHENTICATED_CONTEXT_PACKET>\s*([\s\S]*?)\s*<\/AUTHENTICATED_CONTEXT_PACKET>/.exec(text);
    const packet = packets.decodeUniqueContent(JSON.parse(match[1]));
    const ref = packet.required_refs.find(item => item.path.endsWith('ADR-014-original.md'));
    assert.ok(ref, 'the original packet carries its governing decision');
    ref.content += '\nAltered original governing boundary.\n';
    ref.sha256 = ref.digest = hash(ref.content); ref.bytes = ref.content_bytes = Buffer.byteLength(ref.content);
    for (const item of packet.logical_source_obligations.filter(item => item.path === ref.path)) {
      item.sha256 = ref.sha256; item.bytes = ref.bytes;
    }
    rows[0].message.content = text.replace(match[1], JSON.stringify(packets.encodeUniqueContent(packet)));
  }],
]) test('Claude architecture refuses to seal over a tampered original input: ' + name, async () => {
  await claudeFixture(async f => {
    await assert.rejects(runClaudeCurrentReview(f, 'arch-review', { native: edit }));
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

for (const [name, mutate] of [
  ['complete live row mutation', f => {
    const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
    graph.tickets['T-49-02'].files.push('src/unchanged.cjs');
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  }],
  ['semantically equal live row with a different original digest', f => {
    const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
    const row = graph.tickets['T-49-02'];
    graph.tickets['T-49-02'] = Object.fromEntries(Object.keys(row).reverse().map(key => [key, row[key]]));
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  }],
  ['complete live member evidence mutation', f => {
    const state = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state.json')));
    state['T-49-02'].head_sha = 'f'.repeat(40);
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(state));
  }],
  ['semantically equal original state with changed physical source bytes', f => {
    const state = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state.json')));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(state, null, 2));
  }],
]) test('Claude architecture current binding refuses ' + name, async () => {
  await claudeFixture(async f => {
    const fresh = await runClaudeCurrentReview(f, 'arch-review');
    const manifestBytes = fs.readFileSync(fresh.artifact.ref);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    mutate(f);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
    assert.deepEqual(fs.readFileSync(fresh.artifact.ref), manifestBytes);
  });
});

for (const role of ['arch-review']) for (const [name, mutate] of [
  ['missing physical stream', pin => fs.unlinkSync(pin.path)],
  ['changed original final JSON', pin => {
    const rows = fs.readFileSync(pin.path, 'utf8').trim().split('\n').map(JSON.parse);
    rows.at(-1).structured_output.summary = 'Altered original output';
    fs.writeFileSync(pin.path, serialize(rows));
  }],
  ['truncated original stream', pin => {
    const raw = fs.readFileSync(pin.path); fs.writeFileSync(pin.path, raw.subarray(0, raw.length - 1));
  }],
  ['missing physical semantic transcript', (_pin, native) => fs.unlinkSync(native.path)],
  ['changed original semantic transcript', (_pin, native) => fs.appendFileSync(native.path, '\n')],
]) test('Claude ' + role + ' current consumers refuse ' + name, async () => {
  await claudeFixture(async f => {
    const fresh = await runClaudeCurrentReview(f, role);
    const receipt = fresh.dispatch.receipt;
    mutate(receipt.transcript, claudeNativePin(receipt));
    for (const consumer of consumers) {
      const admitted = consumer(currentSubject(f));
      assert.equal(admitted.architecture.ready, false);
    }
  });
});

async function claudeFixture(action) {
  await fixture(async f => {
    const originalConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(f.root, '.claude');
    try { await action(f); }
    finally {
      if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    }
  });
}

function claudeNativePin(receipt) {
  const pin = receipt.selection_evidence.transcript;
  return { ...pin, path: path.join(path.dirname(receipt.transcript.path), 'projects', pin.path) };
}

async function runClaudeCurrentReview(f, role, edit = {}) {
  const claudeRuntime = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const captureStart = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs').capture;
  const streamRegistry = JSON.parse(fs.readFileSync(path.join(captureRoot, 'boundaries/claude-stream.json')));
  const streamPath = streamRegistry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
  assert.ok(streamPath, 'registered second-runtime originals are required');
  const stream = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(record => !record.shipyard_fixture);
  const session = crypto.randomUUID();
  const options = { ...projectOptions(f), getPullRequest: () => f.pr, controller: false,
    storageRoot: path.join(f.root, 'claude-' + role),
    createRuntimeHost({ scope, recorderDir, transcriptDir }) {
      const originalHost = claudeRuntime.createClaudeRuntimeHost({ scope, recorderDir, transcriptDir,
        startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
        uuid: () => session, sessionTranscriptRoot: path.join(f.root, 'claude-native'),
        probe: { status: 'available', executable: 'claude-fixture', runtime_version: streamRegistry.cli_version,
          capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
        spawn(_file, args) {
          const childProcess = new EventEmitter(); childProcess.pid = process.pid;
          childProcess.stdout = new EventEmitter(); childProcess.stderr = new EventEmitter();
          let framedInput = '';
          childProcess.stdin = { write(value) { framedInput += value; }, end() {
            process.nextTick(() => {
              assert.ok(framedInput.endsWith('\n'));
              const userInput = JSON.parse(framedInput.slice(0, -1));
              f.lastClaudeUserInput = structuredClone(userInput);
              const prompt = userInput.message.content;
              const encoded = JSON.parse(prompt.split('<AUTHENTICATED_CONTEXT_PACKET>')[1].split('</AUTHENTICATED_CONTEXT_PACKET>')[0]);
              const packet = packets.decodeUniqueContent(encoded), context = packet.role_context;
              f.lastClaudePacket = structuredClone(packet);
              let result;
              if (role === 'arch-review') {
                const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
                  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
                    : JSON.stringify(value);
                const contextDigest = hash(stable(packet));
                const echoed = JSON.parse(/Echo these focused subject fields: ([^\n]+)/.exec(prompt)[1]);
                assert.equal(echoed.context_digest, contextDigest);
                assert.equal(echoed.launch_digest, hash(stable({ packet_digest: contextDigest,
                  reference_digest: context.reference_digest })));
                result = { ...context.focused, context_digest: contextDigest,
                  launch_digest: hash(stable({ packet_digest: contextDigest, reference_digest: context.reference_digest })),
                  review_completeness: 'complete', limitations: [], unresolved_sources: [],
                  evidence_markdown: 'Complete original architecture fixture evidence.\n',
                  id: packet.subject, pr: f.pr.number, head: f.head,
                  base_tree: git(f.worktree, 'rev-parse', f.base + '^{tree}'),
                  ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest,
                  verdict: 'conform', blocking_count: 0, summary: 'Complete original architecture fixture', findings: [] };
              }
              edit.originalResult?.(result);
              const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
              const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
              const init = template(stream, row => row.type === 'system' && row.subtype === 'init');
              Object.assign(init, { session_id: session, model, cwd: f.worktree });
              const assistant = template(stream, row => row.type === 'assistant');
              assistant.session_id = session; assistant.message.model = observedModel;
              assistant.message.content[0].input = result;
              const final = template(stream, row => row.type === 'result');
              Object.assign(final, { session_id: session, is_error: false, structured_output: result, result: JSON.stringify(result) });
              const nativeFile = path.join(f.root, 'claude-native/project', session + '.jsonl');
              fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
              const nativeAssistant = structuredClone(assistant);
              Object.assign(nativeAssistant, { sessionId: session, effort });
              const native = [{ ...userInput, sessionId: session }, nativeAssistant];
              edit.native?.(native);
              fs.writeFileSync(nativeFile, serialize(native));
              const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
              const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
              const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
              captureStart({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
                transcript_path: nativeFile, cwd: f.worktree }, {
                evidenceFile: hookValue('--evidence-file'), expectedSession: hookValue('--expected-session') });
              let raw = serialize([init, assistant, final]);
              if (edit.stream) raw = edit.stream(raw);
              childProcess.stdout.emit('data', Buffer.from(raw)); childProcess.emit('close', 0, null);
            });
          } };
          return childProcess;
        } });
      if (!edit.result) return originalHost;
      const originals = new WeakMap();
      return { ...originalHost, async agent(...args) {
        const original = await originalHost.agent(...args);
        const output = structuredClone(original.output); edit.result(output);
        const changed = { ...original, output }; originals.set(changed, original); return changed;
      }, applicationEvidence({ result }) {
        return originalHost.applicationEvidence({ result: originals.get(result) });
      } };
    } };
  return secondRuntime.createClaudeRoleHost(options).run({ schema: secondRuntime.REQUEST_SCHEMA,
    role, worktree: f.worktree, phase: f.phase, pr: f.pr.number });
}

async function fixture(action) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-lineage-')));
  const originalHome = os.homedir, originalCodex = process.env.CODEX_HOME;
  os.homedir = () => root; process.env.CODEX_HOME = path.join(root, '.codex');
  try {
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
    git(worktree, 'init', '-qb', 'main');
    const phase = '49-lineage';
    const graphDir = path.join(worktree, '.planning/graph');
    const rows = Object.fromEntries(['T-49-01', 'T-49-02'].map(id => [id, {
      phase: '49', title: 'Original review fixture', plan: '.planning/phases/' + phase + '/49-' + id.slice(-2) + '-PLAN.md',
      branch: 'ticket/' + id, epic: 'epic/' + phase, pr_base: 'main', repo: null, wave: 1,
      depends_on: [], files: ['src/provider.cjs', 'src/consumer.cjs'], risk: 'high', human_checkpoint: true,
    }]));
    const state = Object.fromEntries(Object.keys(rows).map((id, index) => [id, { status: 'merged', pr: 101 + index, branch: rows[id].branch }]));
    write(worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: rows }));
    write(worktree, '.planning/graph/delivery-state.json', JSON.stringify(state));
    write(worktree, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
    for (const row of Object.values(rows)) write(worktree, row.plan, '---\nphase: 49\nplan: ' + row.plan.match(/49-(\d+)-PLAN/)[1] + '\n---\nADR-014\n## Acceptance criteria\n- Complete merged behavior.\n## Verification commands\n- `node --test tests/unit/phase49-current-review-admission.test.cjs`\n');
    write(worktree, '.planning/architecture/ADR-014-original.md', '# ADR-014\nOriginal complete governing material.\n');
    write(worktree, 'src/provider.cjs', 'exports.value = 0;\n');
    write(worktree, 'src/consumer.cjs', "module.exports = require('./provider.cjs').value;\n");
    write(worktree, 'src/unchanged.cjs', 'exports.untouched = true;\n');
    git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'original base');
    const base = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'update-ref', 'refs/remotes/origin/main', base);
    git(worktree, 'switch', '-qc', 'epic/' + phase);
    write(worktree, 'src/provider.cjs', 'exports.value = 1;\n');
    const f = { root, worktree, base, graphDir, phase, rows, state, count: 0, agents: {}, reviews: [] };
    f.pr = { number: 301, state: 'OPEN', isDraft: false, headRefName: 'epic/' + phase, headRefOid: '',
      baseRefName: 'main', baseRefOid: base, reviewDecision: 'REVIEW_REQUIRED' };
    commit(f, 'original implementation'); f.memberHead = f.head;
    await action(f);
  } finally {
    os.homedir = originalHome;
    if (originalCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodex;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function phaseBinding(f) {
  return target.phaseBinding({ graph: { tickets: f.rows }, state: f.state, phase: 49,
    repository: git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    branch: f.pr.headRefName, pr: f.pr.number, head: f.head, base: f.pr.baseRefOid });
}

function agent(f, role, signals) {
  if (f.agents[role]) return f.agents[role];
  const selection = policy.resolveDispatch({ runtime: 'codex', role, signals });
  const dir = path.join(f.root, role + '-agents'); fs.mkdirSync(dir);
  const text = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"', '# shipyard-policy-version = "' + selection.policy_version + '"',
    '# shipyard-policy-hash = "' + selection.policy_hash + '"', '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "' + role + '"', '# shipyard-policy-rung = "' + selection.rung + '"',
    'name = "' + selection.agent_file.replace(/\.toml$/, '') + '"', 'model = "' + selection.model + '"',
    'model_reasoning_effort = "' + selection.effort + '"', 'sandbox_mode = "read-only"',
    "developer_instructions = '''", 'Read complete original material.', "'''", '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, selection.agent_file), text);
  const manifest = path.join(dir, '.shipyard-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: selection.policy_version,
    policy_hash: policy.POLICY_HASH, agent_files: [selection.agent_file], agent_digests: { [selection.agent_file]: hash(text) } }));
  return f.agents[role] = { dir, manifest, text, selection,
    capabilities: { supportedModels: [selection.model], supportedEfforts: [selection.effort] } };
}

function architectureScope(f, dispatchId) {
  const binding = f.directTicket ? null : phaseBinding(f);
  return { worktree: f.worktree, phase: 49, ticket: f.directTicket || binding.subject, run_id: dispatchId };
}

function prepareArchitecture(f, role, dispatchId = 'current-' + role + '-' + ++f.count) {
  const value = collector.prepare(architectureScope(f, dispatchId), { role, context: {}, signals: {} }, { graphDir: f.graphDir,
    refreshGit: false, getPullRequest: () => f.pr, inflightDispatchId: dispatchId, storageRoot: path.join(f.root, 'inputs') });
  const a = agent(f, role, value.launch.signals);
  collector.admitInstalledLaunch(value, { agentDir: a.dir, agentFile: a.selection.agent_file,
    agentManifest: a.manifest, capabilities: a.capabilities });
  f.lastArchitecture = value;
}

function nativeRecords(scope, session, selection, resultText, prompt) {
  const meta = template(parent, record => record.type === 'session_meta');
  Object.assign(meta.payload, { id: session, session_id: session, cwd: scope.worktree, runtime_workspace_roots: [scope.worktree] });
  const context = template(parent, record => record.type === 'turn_context');
  Object.assign(context.payload, { model: selection.model, effort: selection.effort, cwd: scope.worktree, workspace_roots: [scope.worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model: selection.model, reasoning_effort: selection.effort });
  const start = template(parent, record => record.payload?.type === 'task_started');
  const turn = start.payload.turn_id;
  context.payload.turn_id = turn;
  const final = template(parent, record => record.type === 'response_item' && record.payload.phase === 'final_answer');
  final.payload.content.forEach(block => { block.text = resultText; });
  final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  const completion = template(parent, record => record.payload?.type === 'task_complete');
  Object.assign(completion.payload, { turn_id: turn, last_agent_message: resultText });
  const user = prompt === undefined ? [] : [template(parent,
    record => record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user')];
  if (user.length) {
    user[0].payload.content = [{ type: 'input_text', text: prompt }];
    user[0].payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  }
  return [meta, context, start, ...user, final, completion];
}
