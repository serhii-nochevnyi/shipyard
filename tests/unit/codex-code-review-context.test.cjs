'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-context-authority-')));
const transportBin = path.join(home, 'bin');
fs.mkdirSync(transportBin);
fs.writeFileSync(path.join(transportBin, 'gh'), '#!/usr/bin/env node\nthrow new Error("Unexpected uninjected GitHub transport");\n', { mode: 0o755 });
const originalPath = process.env.PATH;
process.env.PATH = transportBin + path.delimiter + originalPath;
process.on('exit', () => { process.env.PATH = originalPath; });
const originalCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = home;
process.on('exit', () => { if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome; });
const originalHomedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const context = require(path.join(scripts, 'codex-code-review-context.cjs'));
const artifact = require(path.join(scripts, 'role-artifact.cjs'));
const target = require(path.join(scripts, 'architecture-target.cjs'));
const policy = require(path.join(scripts, 'model-policy.cjs'));
const partitions = require(path.join(scripts, 'codex-arch-review-context.cjs'));
const { fixture: archFixture, git, write } = require('./helpers/codex-arch-review-fixtures.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const admissions = new WeakMap();
const pinNames = ['codex-code-review-context.cjs', 'codex-delivery-host.cjs', 'codex-runtime-host.cjs',
  'codex-arch-review-context.cjs', 'claude-role-host.cjs', 'code-review-core.cjs', 'role-artifact.cjs',
  'conveyor-scratch.cjs', 'dispatch-record.cjs', 'architecture-target.cjs', 'development-artifacts.cjs',
  'context-packet.cjs', 'lock.cjs', 'model-policy.cjs', 'model-policy-internal.cjs'];

function fixture(label = 'plain', sameRoot = false) {
  const f = archFixture();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-context-')));
  const project = path.join(parent, label);
  fs.renameSync(f.root, project);
  const graphDir = path.join(project, '.planning/graph');
  const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
  const row = Object.values(graph.tickets)[0];
  row.epic = 'epic/38-codex-arch-review'; row.human_checkpoint = false;
  row.files = ['src/reviewed.txt'];
  write(project, '.planning/graph/tickets.json', JSON.stringify(graph));
  write(project, 'src/reviewed.txt', Array.from({ length: 120 }, (_, i) => 'const value' + i + ' = ' + i + ';').join('\n') + '\n');
  git(project, ['add', '.']); git(project, ['commit', '-m', 'phase graph and reviewed source']);
  let root = project;
  if (sameRoot) git(root, ['switch', '-c', row.epic]);
  else { root = path.join(parent, 'epic'); git(project, ['worktree', 'add', '-b', row.epic, root]); }
  const state = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json')));
  const storage = path.join(parent, 'storage'); fs.mkdirSync(storage, { mode: 0o700 });
  const pr = { ...f.pr, headRefName: row.epic, headRefOid: git(root, ['rev-parse', 'HEAD']) };
  function scope() {
    return { worktree: root, phase: 38, ticket: target.phaseBinding({ graph, state, phase: 38,
      repository: target.repositoryIdentity(root), pr: pr.number, head: pr.headRefOid,
      base: pr.baseRefOid, branch: row.epic }).subject };
  }
  const options = { graphDir, refreshGit: false, getPullRequest: () => pr, storageRoot: storage };
  return { root, project, parent, graphDir, graph, row, state, storage, pr, scope, options,
    prepare(extra = {}, launch = {}) { return context.prepare(scope(), { role: 'code-review', context: {}, signals: {}, ...launch },
      { ...options, inflightDispatchId: crypto.randomUUID(), ...extra }); },
    commit(change) { change(); git(root, ['add', 'src/reviewed.txt']); git(root, ['commit', '-m', 'fix reviewed source']); pr.headRefOid = git(root, ['rev-parse', 'HEAD']); },
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); } };
}

function admit(f, value, builder = context, extra = {}) {
  const agentDir = path.join(f.storage, 'agents-' + crypto.randomUUID()); fs.mkdirSync(agentDir);
  const selected = policy.resolveDispatch({ runtime: 'codex', role: 'code-review', signals: value.launch.signals });
  const agent = "developer_instructions = '''\nJudge every supplied source partition.\n'''\n";
  write(agentDir, selected.agent_file, agent);
  const manifest = path.join(agentDir, '.shipyard-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ agent_files: [selected.agent_file], agent_digests: { [selected.agent_file]: hash(agent) } }));
  const installation = builder.admitInstalledLaunch(value, { agentDir, agentFile: selected.agent_file,
    agentManifest: manifest, capabilities: {}, ...extra });
  admissions.set(value, { content: agent, digest: hash(agent), file: selected.agent_file });
  return { installation, agentDir, manifest, agentFile: selected.agent_file };
}

function dispatchFixture(f, value, mutate = () => {}, evidence = true, mutateEvidence = () => {}, builder = context, boundaryModule = require(path.join(scripts, 'dispatch-boundary.cjs'))) {
  const recorder = boundaryModule.createDurableRecorder(path.join(f.storage, 'receipts-' + crypto.randomUUID()));
  const association = { ticket: value.prepared.ticket, phase: 38, worktree: f.root,
    dispatch_id: value.launch.dispatch_id };
  const binding = builder.authenticateLaunch(value, builder.admittedPrompt(value), association);
  const part = value.prepared.part;
  const raw = part ? { part: part.id, review_completeness: 'complete', limitations: [], unresolved_sources: [], summary: 'Reviewed the part.', findings: [] }
    : { ...binding, ticket_set: value.prepared.binding.ticketSet, findings: [], dispositions: [],
    summary: 'Reviewed the complete phase change.', review_completeness: 'complete', limitations: [], unresolved_sources: [],
    evidence_markdown: 'Exact role-owned evidence.\n' };
  mutate(raw);
  if (evidence && !part) write(f.root, '.shipyard-code-review-evidence.md', raw.evidence_markdown);
  const session = crypto.randomUUID();
  const captured = fs.readFileSync(path.resolve(__dirname,
    '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const records = captured.filter(record => !record.shipyard_fixture);
  for (const record of records) {
    if (record.thread_id) record.thread_id = session;
    if (record.item?.type === 'agent_message') record.item.text = JSON.stringify(raw);
  }
  const stream = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  const transcript = path.join(f.storage, session + '.jsonl'); fs.writeFileSync(transcript, stream);
  const selected = policy.resolveDispatch({ runtime: 'codex', role: 'code-review', signals: value.launch.signals });
  const nativeRows = [
    { type: 'session_meta', payload: { id: session, model_provider: 'openai', cwd: f.root } },
    { type: 'turn_context', payload: { model: selected.model, effort: selected.effort } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'original-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: builder.admittedPrompt(value) }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify(raw) }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original-turn', last_agent_message: JSON.stringify(raw) } },
  ];
  const nativeText = nativeRows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const now = new Date();
  const nativeDirectory = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(nativeDirectory, { recursive: true });
  const nativePath = path.join(nativeDirectory, session + '.jsonl'); fs.writeFileSync(nativePath, nativeText);
  const runtimeEvidence = { schema: 'shipyard.codex-runtime-evidence.v1', runtime: 'codex', provider: 'openai',
    session_id: session, worktree: f.root, ticket: value.prepared.ticket, phase: 38,
    native_session_evidence: { session_id: session, bytes: Buffer.byteLength(nativeText), sha256: hash(nativeText) },
    input_consumption: { native_session_sha256: hash(nativeText) },
    code_review: binding, transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: hash(stream) } };
  mutateEvidence(runtimeEvidence, { nativePath, nativeRows, transcript, records });
  const agent = admissions.get(value);
  const boundary = boundaryModule.createDispatchBoundary({ recorder, adapters: { codex: {
    validateGeneratedAgent(r) { return { valid: true, exists: true, content_verified: true, policy_hash: r.policy_hash,
      agent_file: agent.file, agent_file_content: agent.content, agent_file_digest: agent.digest }; },
    launchStatic(r) {
      return { receipt_type: 'adr-014.application', runtime: r.runtime, role: r.role, dispatch_id: r.dispatch_id,
        launch_id: 'unit-' + r.dispatch_id, requested_model: r.requested_model, requested_effort: r.requested_effort,
        applied_model: r.model, applied_effort: r.effort, observed_model: r.model, observed_effort: r.effort,
        policy_hash: r.policy_hash, agent_file: r.agent_file, agent_file_digest: r.agent_file_digest,
        runtime_evidence: runtimeEvidence };
  } } } });
  const dispatch = structuredClone(boundary.dispatch({ runtime: 'codex', role: 'code-review', signals: value.launch.signals,
    dispatch_id: association.dispatch_id }, { ticket: value.prepared.ticket, subject_kind: 'phase' }));
  assert.equal(dispatch.dispatch_id, association.dispatch_id);
  assert.ok(recorder.getVerifiedRecord(dispatch.dispatch_id));
  return { dispatch, recorder, raw, runtimeEvidence, nativePath };
}

function review(f, mutate = () => {}, builder = context, boundaryModule) {
  const id = crypto.randomUUID();
  const value = f.prepare({ inflightDispatchId: id }, { dispatch_id: id });
  admit(f, value, builder); builder.recheckInstalledLaunch(value);
  const d = dispatchFixture(f, value, mutate, true, () => {}, builder, boundaryModule);
  return { value, ...d, result: builder.finish(value, d.dispatch, d.recorder) };
}

const warning = (patch = {}) => ({ id: 'old-label', rule: 'old-rule', severity: 'WARNING', path: 'src/reviewed.txt',
  line: 61, line_text: 'const value60 = 60;', summary: 'Review this statement.', ...patch });
const blocker = (patch = {}) => ({ ...warning(), severity: 'BLOCKER', failure_scenario: 'This statement can fail for a caller.',
  fix_ticket: { title: 'Fix statement', scope: 'Correct the cited statement', files: ['src/reviewed.txt'] }, ...patch });

test('tracer prepares private context, admits installed inputs and seals a durable code review', () => {
  const f = fixture();
  try {
    const r = review(f);
    assert.ok(Object.isFrozen(r.value)); assert.ok(Object.isFrozen(r.value.prepared.packet));
    assert.equal(context.isPreparedContext(r.value), true); assert.equal(context.isPreparedContext({ ...r.value }), false);
    assert.equal(r.result.schema, 'shipyard.codex-delivery-result.v1'); assert.equal(r.result.artifact.outcome, 'pass');
    assert.equal(artifact.authenticatedArchivePins(f.root).length, 3);
    assert.equal(JSON.parse(fs.readFileSync(r.result.artifact.ref)).role, 'code-review');
    assert.throws(() => context.finish({ ...r.value }, r.dispatch, r.recorder));
    assert.throws(() => context.finish(r.value, r.dispatch, { getVerifiedRecord: () => null }), { code: 'MISSING_RECEIPT' });
  } finally { f.cleanup(); }
});

for (const launch of [{ role: 'arch-review' }, { context: { prompt: 'injected' } }, { context: { selector: 'x' } },
  { signals: { critical: true } }, { signals: { contested: true } }, { gsd_role: 'gsd-code-reviewer' },
  { context: 'injected' }, { signals: 'injected' }]) test('caller authority refused: ' + JSON.stringify(launch), () => {
  const f = fixture(); try { assert.throws(() => f.prepare({}, launch)); } finally { f.cleanup(); }
});

test('signals derive from every graph row and never route on contested or window pressure', () => {
  const f = fixture();
  try {
    f.graph.tickets['T-38-02'] = { ...f.row, critical: true, human_checkpoint: 'merge' };
    write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
    const v = f.prepare();
    assert.equal(v.launch.signals.critical, true); assert.equal(v.launch.signals.checkpoint, true);
    assert.deepEqual(Object.keys(v.launch.signals).sort(), ['checkpoint', 'critical', 'inputTokens', 'risk']);
    assert.equal(policy.resolveDispatch({ runtime: 'codex', role: 'code-review', signals: v.launch.signals }).effort, 'xhigh');
  } finally { f.cleanup(); }
});

test('ordinary high-risk review stays on Sol/high despite contested PR evidence', () => {
  const f = fixture();
  try {
    const v = f.prepare();
    assert.equal(v.launch.signals.critical, false); assert.equal(v.launch.signals.checkpoint, false);
    assert.equal(Object.hasOwn(v.launch.signals, 'contested'), false);
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'code-review',
      signals: { ...v.launch.signals, inputTokens: 1000000 } });
    assert.equal(selected.effort, 'high');
  } finally { f.cleanup(); }
});

test('product diff excludes development artifacts while complete plans stay in the packet', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/review-notes.md', 'Development context only.');
    git(f.root, ['add', '.planning/review-notes.md']); git(f.root, ['commit', '-m', 'development notes']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    const v = f.prepare(), packet = v.prepared.packet.role_context;
    assert.deepEqual(packet.change_metadata.changes.flatMap(change => change.paths), ['src/reviewed.txt']);
    assert.ok(packet.plan_acceptance[0].content.includes('Acceptance criteria'));
  } finally { f.cleanup(); }
});

for (const [label, mutate] of [
  ['head', f => { f.pr.headRefOid = 'a'.repeat(40); }],
  ['base', f => { f.pr.baseRefOid = 'b'.repeat(40); }],
  ['target', f => { f.pr.baseRefName = 'wrong'; }],
  ['closed', f => { f.pr.state = 'CLOSED'; }],
  ['branch', f => { git(f.root, ['switch', '-c', 'wrong']); }],
  ['tracked change', f => { fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'dirty'); }],
  ['untracked change', f => { write(f.root, 'unknown', 'dirty'); }],
]) test('prepare refuses ' + label, () => {
  const f = fixture(); try { mutate(f); assert.throws(() => f.prepare()); } finally { f.cleanup(); }
});

for (const name of ['plain', 'with space', 'répertoire-ü']) test('shared repository identity through injected runner: ' + name, () => {
  const f = fixture(name, true);
  try {
    const calls = [];
    const runner = (...args) => { calls.push(args); return execFileSync(...args); };
    const v = f.prepare({ execFileSync: runner });
    const expected = target.phaseBinding({ graph: f.graph, state: f.state, phase: 38,
      repository: target.repositoryIdentity(f.root, { execFileSync: runner }), pr: f.pr.number,
      head: f.pr.headRefOid, base: f.pr.baseRefOid, branch: f.row.epic });
    assert.equal(v.prepared.ticket, expected.subject);
    assert.ok(calls.some(([exe, args]) => exe === 'git' && args.includes('--git-common-dir')));
  } finally { f.cleanup(); }
});

test('semicolon repository rejected at producer with unchanged code', () => {
  const f = fixture('semi;colon', true);
  try { assert.throws(() => context.prepare({ worktree: f.root, phase: 38, ticket: 'phase=38-review;repository=x' },
    { role: 'code-review', context: {}, signals: {} }, f.options), { code: 'REPOSITORY_IDENTITY_INVALID' }); }
  finally { f.cleanup(); }
});

test('rounds two and three admit their exact sealed archives and fourth refuses before launch', () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 3; n++) {
      const r = review(f, raw => { raw.findings = [warning()]; raw.ticket_set = reverseReviewKeys(raw.ticket_set); });
      assert.equal(r.result.result.review_round, n); assert.equal(r.result.result.review_scope, n === 1 ? 'full' : 'delta');
      assert.equal(artifact.authenticatedArchivePins(f.root).length, 3 * n);
      if (n < 3) f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), '\n'));
    }
    assert.throws(() => f.prepare(), { code: 'CODE_REVIEW_ROUND_LIMIT' });
  } finally { f.cleanup(); }
});

function reverseReviewKeys(value) {
  if (Array.isArray(value)) return value.map(reverseReviewKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, item]) => [key, reverseReviewKeys(item)]));
  return value;
}

for (const mutation of ['row', 'evidence', 'array-order', 'added', 'deleted'])
  test('finish rejects changed nested membership before sealing: ' + mutation, () => {
    const f = fixture();
    try {
      assert.throws(() => review(f, raw => {
        raw.ticket_set = reverseReviewKeys(raw.ticket_set);
        if (mutation === 'row') raw.ticket_set[0].row.epic = 'epic/forged';
        if (mutation === 'evidence') raw.ticket_set[0].evidence.status = 'pending';
        if (mutation === 'array-order') raw.ticket_set[0].row.files.push('forged.js');
        if (mutation === 'added') raw.ticket_set.push({ id: 'T-38-99', row: {}, evidence: {} });
        if (mutation === 'deleted') raw.ticket_set.pop();
      }), { code: 'ARTIFACT_IDENTITY_MISMATCH' });
      assert.deepEqual(artifact.authenticatedArchivePins(f.root), []);
    } finally { f.cleanup(); }
  });

for (const incomplete of [false, true]) test('finish preserves verified host membership across recursive key order: ' + incomplete, () => {
  const f = fixture();
  try {
    f.row.review_metadata = { checks: ['first', 'second'], evidence: { source: 'graph', required: true } };
    write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
    const r = review(f, raw => {
      raw.ticket_set = reverseReviewKeys(raw.ticket_set);
      if (incomplete) {
        raw.review_completeness = 'incomplete'; raw.limitations = ['Unread source'];
        raw.findings = [blocker()];
      }
    });
    assert.deepEqual(r.raw.ticket_set, r.value.prepared.binding.ticketSet);
    assert.notEqual(JSON.stringify(r.raw.ticket_set), JSON.stringify(r.value.prepared.binding.ticketSet));
    const manifest = JSON.parse(fs.readFileSync(r.result.artifact.ref));
    const findings = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
    assert.equal(JSON.stringify(findings.ticket_set), JSON.stringify(r.value.prepared.binding.ticketSet));
    const prior = artifact.priorCodeReviewVerdicts({ worktreePath: f.root,
      repository: target.repositoryIdentity(f.root), phaseDir: r.value.prepared.binding.phase, graphDir: f.graphDir });
    assert.equal(prior.length, 1);
    assert.equal(prior[0].review_completeness, incomplete ? 'incomplete' : 'complete');
    const current = artifact.currentCodeReviewVerdict({ worktreePath: f.root, pr: f.pr.number,
      head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid,
      graphDir: f.graphDir, headBranch: f.pr.headRefName });
    assert.equal(current.verdict, incomplete ? 'incomplete' : 'pass');
    if (incomplete) {
      const core = require(path.join(scripts, 'code-review-core.cjs'));
      assert.equal(prior[0].blocking_count, 1);
      assert.equal(core.countableVerdicts({ priorVerdicts: prior, head: prior[0].head, isAncestor: () => false }).length, 0);
      const next = f.prepare().prepared.round;
      assert.equal(next.rounds_used, 0); assert.equal(next.round, 1); assert.equal(next.scope, 'full');
    }
  } finally { f.cleanup(); }
});

test('incomplete verdict seals as incomplete and never advances round', () => {
  const f = fixture();
  try {
    assert.equal(review(f, r => { r.review_completeness = 'incomplete'; r.limitations = ['unread source']; }).result.artifact.outcome, 'incomplete');
    assert.equal(f.prepare().prepared.round.round, 1);
  } finally { f.cleanup(); }
});

for (const [label, change, touched] of [
  ['insertion and nearby edit', text => 'inserted();\n' + text.replace('const value80 = 80;', 'const value80 = 81;'), false],
  ['cited line replacement', text => text.replace('const value60 = 60;', 'const value60 = 61;'), true],
]) test('host source identity through real unified=50 delta: ' + label, () => {
  const f = fixture();
  try {
    const first = review(f, r => { r.findings = [warning()]; });
    const identity = first.result.result.findings[0].identity;
    f.commit(() => { const p = path.join(f.root, 'src/reviewed.txt'); fs.writeFileSync(p, change(fs.readFileSync(p, 'utf8'))); });
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id });
    const carried = v.prepared.priorFindings[0];
    assert.equal(v.prepared.round.priorHead, first.result.result.head);
    assert.equal(carried.delta_touch, touched); assert.equal(carried.identity, touched ? null : identity);
    assert.equal(v.prepared.packet.role_context.exact_diff.delta_base, first.result.result.head);
    if (!touched) assert.equal(carried.line, 62);
    admit(f, v);
    const d = dispatchFixture(f, v, r => { r.findings = [blocker({ id: 'changed-id', rule: 'changed-rule',
      line: touched ? 61 : 62, line_text: touched ? 'const value60 = 61;' : warning().line_text })]; });
    const result = context.finish(v, d.dispatch, d.recorder).result;
    assert.equal(result.findings[0].classification, touched ? 'new' : 'prior');
  } finally { f.cleanup(); }
});

test('missing or unmatched head citations remain new and counted', () => {
  const f = fixture();
  try {
    const r = review(f, raw => { raw.findings = [warning({ path: 'absent.js' }), warning({ id: 'mismatch', line_text: 'wrong' })]; });
    assert.equal(r.result.result.finding_count, 2);
    for (const finding of r.result.result.findings) { assert.equal(finding.classification, 'new'); assert.equal(finding.identity, null); }
  } finally { f.cleanup(); }
});

test('recorded disagreement suppresses in round two and retains round three target', () => {
  const f = fixture();
  try {
    review(f, r => { r.findings = [blocker()]; });
    const relative = '.planning/phases/38-codex-arch-review/code-review-disagreements.json';
    write(f.project, relative, JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [
      { path: warning().path, line_text: warning().line_text, occurrence: 1, reason: 'Accepted by project owner', recorded_by: 'owner' } ] }));
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), '\n'));
    const second = review(f);
    assert.equal(second.result.result.disagreement_suppressed, 1);
    assert.equal(second.result.result.findings[0].suppressed, true);
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), '\n'));
    const third = review(f);
    assert.equal(third.result.result.disagreement_suppressed, 1);
  } finally { f.cleanup(); }
});

for (const content of ['{', JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [
  { path: 'absent.js', line_text: 'unknown', occurrence: 1, reason: 'x', recorded_by: 'owner' } ] })]) {
  test('invalid or unknown disagreement refuses preparation: ' + content.slice(0, 20), () => {
    const f = fixture();
    try { write(f.project, '.planning/phases/38-codex-arch-review/code-review-disagreements.json', content);
      assert.throws(() => f.prepare(), error => ['DISPOSITIONS_INVALID', 'DISPOSITION_TARGET_UNKNOWN'].includes(error.code)); }
    finally { f.cleanup(); }
  });
}

for (const field of ['review_contract', 'repository', 'id', 'pr', 'head', 'base_commit', 'merge_base', 'base_tree',
  'ticket_set_digest', 'context_digest', 'launch_digest', 'ticket_set']) test('finish refuses changed identity: ' + field, () => {
  const f = fixture();
  try { assert.throws(() => review(f, r => { r[field] = field === 'ticket_set' ? [] : 'forged'; })); }
  finally { f.cleanup(); }
});

for (const field of ['ticket', 'phase', 'worktree', 'dispatch_id', 'prompt']) test('launch authentication binds ' + field, () => {
  const f = fixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const a = { ticket: v.prepared.ticket, phase: 38, worktree: f.root, dispatch_id: id };
    if (field !== 'prompt') a[field] = 'wrong';
    assert.throws(() => context.authenticateLaunch(v, field === 'prompt' ? 'wrong' : context.admittedPrompt(v), a));
  } finally { f.cleanup(); }
});

for (const label of ['missing', 'divergent', 'symlink', 'oversized']) test('finish refuses ' + label + ' evidence', () => {
  const f = fixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    const p = path.join(f.root, '.shipyard-code-review-evidence.md');
    if (label === 'missing') fs.unlinkSync(p);
    if (label === 'divergent') fs.appendFileSync(p, ' ');
    if (label === 'symlink') { fs.unlinkSync(p); const other = path.join(f.storage, 'evidence'); fs.writeFileSync(other, d.raw.evidence_markdown); fs.symlinkSync(other, p); }
    if (label === 'oversized') fs.writeFileSync(p, 'x'.repeat(partitions.EVIDENCE_MAX_BYTES + 1));
    assert.throws(() => context.finish(v, d.dispatch, d.recorder));
  } finally { f.cleanup(); }
});

for (const mutation of ['replacement', 'in-place']) test('finish refuses evidence ' + mutation + ' after pinning', () => {
  const f = fixture();
  const originalOpen = fs.openSync, originalClose = fs.closeSync;
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    const evidencePath = path.join(f.root, '.shipyard-code-review-evidence.md');
    let evidenceFd, mutated = false;
    fs.openSync = (file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (file === evidencePath && !mutated) evidenceFd = fd;
      return fd;
    };
    fs.closeSync = fd => {
      originalClose(fd);
      if (fd === evidenceFd && !mutated) {
        mutated = true;
        const replacement = 'X'.repeat(Buffer.byteLength(d.raw.evidence_markdown));
        if (mutation === 'replacement') {
          const temporary = path.join(f.storage, 'replacement.md');
          fs.writeFileSync(temporary, replacement); fs.renameSync(temporary, evidencePath);
        } else fs.writeFileSync(evidencePath, replacement);
      }
    };
    assert.throws(() => context.finish(v, d.dispatch, d.recorder), { code: 'STALE_CONTEXT' });
    assert.equal(mutated, true);
    assert.deepEqual(artifact.authenticatedArchivePins(f.root), []);
  } finally { fs.openSync = originalOpen; fs.closeSync = originalClose; f.cleanup(); }
});

for (const changed of ['head', 'base', 'packet']) test('live recheck and finish refuse moved ' + changed, () => {
  const f = fixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    if (changed === 'packet') { f.row.title = 'changed'; write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph)); }
    else f.pr[changed === 'head' ? 'headRefOid' : 'baseRefOid'] = 'a'.repeat(40);
    assert.throws(() => context.recheckInstalledLaunch(v));
    assert.throws(() => context.finish(v, d.dispatch, d.recorder));
  } finally { f.cleanup(); }
});

for (const label of ['pass with blockers', 'incomplete pass', 'missing custody', 'unbound receipt']) test('finish refuses ' + label, () => {
  const f = fixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v, r => {
      if (label === 'pass with blockers') { r.findings = [blocker()]; r.verdict = 'pass'; }
      if (label === 'incomplete pass') { r.review_completeness = 'incomplete'; r.verdict = 'pass'; }
    }, true, runtime => { if (label === 'missing custody') delete runtime.code_review; });
    if (label === 'unbound receipt') d.dispatch.receipt = { ...d.dispatch.receipt, launch_id: 'forged' };
    assert.throws(() => context.finish(v, d.dispatch, d.recorder));
  } finally { f.cleanup(); }
});

test('the packet carries the changed-path inventory and no diff; the prompt sends the reviewer to git', () => {
  const f = fixture();
  try {
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), ('large line ' + 'x'.repeat(240) + '\n').repeat(5000)));
    const v = f.prepare();
    const context = v.prepared.packet.role_context;
    assert.equal(Object.hasOwn(context.exact_diff, 'content'), false);
    assert.deepEqual(context.change_metadata.changes.map(change => change.paths), [['src/reviewed.txt']]);
    assert.ok(Buffer.byteLength(v.launch.context.prompt) < partitions.INPUT_MAX_BYTES / 2);
    assert.match(v.launch.context.prompt, new RegExp('git diff ' + context.exact_diff.base + '\\.\\.\\.' + v.prepared.canonical.head));
    assert.equal(v.prepared.groups.length, 1);
  } finally { f.cleanup(); }
});

test('a prompt over the launch bound refuses before any part runs', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4000; i++) write(f.root, 'many/' + 'x'.repeat(240) + i + '.txt', 'x\n');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-q', '-m', 'many paths']); f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => f.prepare(), error => ['CONTEXT_PACKET_OVER_BOUND', 'CONTEXT_OVER_BOUND'].includes(error.code));
  } finally { f.cleanup(); }
});

function twoPartFixture() {
  const f = fixture();
  fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'const added = 1;\n'); write(f.root, 'extra/a.txt', 'a\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'two directories']); f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
  return f;
}

test('parts and final: each part is its own launch, the final owns the verdict and coverage derives from the parts', () => {
  const f = twoPartFixture();
  try {
    const launch = extra => { const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id, partBudget: 3, ...extra }, { dispatch_id: id }); admit(f, v); return v; };
    const first = launch();
    assert.deepEqual(first.prepared.groups.map(group => group.paths), [['extra/a.txt'], ['src/reviewed.txt']]);
    const parts = [];
    for (const group of first.prepared.groups) {
      const v = launch({ part: group.ordinal });
      assert.deepEqual(v.prepared.packet.role_context.part.paths, group.paths);
      assert.equal(v.prepared.packet.role_context.prior_findings.length, 0);
      const d = dispatchFixture(f, v, r => { if (group.ordinal === 2) r.findings = [blocker()]; });
      assert.equal(fs.existsSync(path.join(f.root, '.shipyard-code-review-evidence.md')), false);
      parts.push(context.finish(v, d.dispatch, d.recorder));
    }
    assert.deepEqual(parts.map(part => part.findings.length), [0, 1]);
    const v = launch({ parts });
    assert.match(v.launch.context.prompt, /independent final reviewer/);
    const d = dispatchFixture(f, v, r => { r.findings = [blocker()]; r.dispositions = [{ ref: parts[1].findings[0].ref, disposition: 'unresolved', justification: 'Confirmed with git.' }]; });
    const sealed = context.finish(v, d.dispatch, d.recorder);
    assert.equal(sealed.artifact.outcome, 'needs-fix');
    assert.deepEqual(sealed.result.coverage, [{ partition: 1, status: 'reviewed' }, { partition: 2, status: 'reviewed' }]);
    assert.deepEqual(sealed.result.part_dispositions.map(entry => entry.disposition), ['unresolved']);
  } finally { f.cleanup(); }
});

test('a part is rechecked against the live PR after its launch like the final', () => {
  const f = twoPartFixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id, partBudget: 3, part: 2 }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    f.pr.headRefOid = 'a'.repeat(40);
    assert.throws(() => context.finish(v, d.dispatch, d.recorder), { code: 'STALE_CONTEXT' });
  } finally { f.cleanup(); }
});

test('a part reviewer that wrote the evidence file is a mutated worktree', () => {
  const f = twoPartFixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id, partBudget: 3, part: 1 }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    write(f.root, '.shipyard-code-review-evidence.md', 'part wrote this');
    assert.throws(() => context.finish(v, d.dispatch, d.recorder), { code: 'WORKTREE_MUTATED' });
  } finally { f.cleanup(); }
});

test('a part reviewer that left a dangling evidence symlink is a mutated worktree', () => {
  const f = twoPartFixture();
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id, partBudget: 3, part: 1 }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    fs.symlinkSync(path.join(f.root, 'missing-target'), path.join(f.root, '.shipyard-code-review-evidence.md'));
    assert.throws(() => context.finish(v, d.dispatch, d.recorder), { code: 'WORKTREE_MUTATED' });
  } finally { f.cleanup(); }
});

test('generated instructions plus an inline prompt over the bound refuse admission', () => {
  const f = fixture();
  try {
    const v = f.prepare();
    const agentDir = path.join(f.storage, 'large-agent'); fs.mkdirSync(agentDir);
    const name = 'shipyard-code-review.toml';
    write(agentDir, name, "developer_instructions = '''\n" + 'x'.repeat(partitions.INPUT_MAX_BYTES - 100) + "\n'''\n");
    const manifest = path.join(agentDir, '.shipyard-manifest.json'); fs.writeFileSync(manifest, '{}');
    assert.throws(() => context.admitInstalledLaunch(v, { agentDir, agentFile: name, agentManifest: manifest,
      capabilities: {} }), { code: 'CONTEXT_OVER_BOUND' });
  } finally { f.cleanup(); }
});

for (const label of ['unknown file', 'unknown directory', 'changed old evidence', 'removed catalogue', 'forged catalogue', 'outside file', 'tracked file']) {
  test('archive admission refuses ' + label, () => {
    const f = fixture();
    try {
      review(f);
      const pins = artifact.authenticatedArchivePins(f.root);
      if (label === 'unknown file') write(f.root, '.shipyard-role-artifacts/unknown', 'forged');
      if (label === 'unknown directory') fs.mkdirSync(path.join(f.root, '.shipyard-role-artifacts/unknown'));
      if (label === 'changed old evidence') fs.appendFileSync(path.join(f.root, pins.find(p => p.path.endsWith('.md')).path), 'tamper');
      const catalogue = path.join(artifact.archiveAuthorityDirectory(f.root), 'catalogue.json');
      if (label === 'removed catalogue') fs.unlinkSync(catalogue);
      if (label === 'forged catalogue') fs.writeFileSync(catalogue, '{}');
      if (label === 'outside file') write(f.root, 'unknown', 'dirty');
      if (label === 'tracked file') fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'dirty');
      assert.throws(() => f.prepare());
    } finally { f.cleanup(); }
  });
}

for (const label of ['appeared', 'changed']) test('archive ' + label + ' after preparation refuses launch and seal', () => {
  const f = fixture();
  try {
    review(f);
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v);
    const p = artifact.authenticatedArchivePins(f.root)[0].path;
    if (label === 'appeared') write(f.root, '.shipyard-role-artifacts/forged', 'x');
    else fs.appendFileSync(path.join(f.root, p), 'x');
    assert.throws(() => context.recheckInstalledLaunch(v)); assert.throws(() => context.finish(v, d.dispatch, d.recorder));
  } finally { f.cleanup(); }
});

test('installed pins cover every required host source and reject one changed byte of each', () => {
  const f = fixture();
  try {
    const copied = path.join(f.storage, 'source'); fs.cpSync(path.dirname(scripts), copied, { recursive: true });
    const isolated = require(path.join(copied, 'scripts/codex-code-review-context.cjs'));
    const v = isolated.prepare(f.scope(), { role: 'code-review', context: {}, signals: {} }, f.options);
    const a = admit(f, v, isolated);
    for (const name of pinNames) assert.ok(a.installation.files.some(pin => pin.path === name));
    for (const pin of a.installation.files) {
      const absolute = path.join(pin.root, pin.path), original = fs.readFileSync(absolute);
      fs.writeFileSync(absolute, Buffer.concat([original, Buffer.from(' ')]));
      assert.throws(() => isolated.recheckInstalledLaunch(v), { code: 'STALE_CONTEXT' });
      fs.writeFileSync(absolute, original); isolated.recheckInstalledLaunch(v);
    }
  } finally { f.cleanup(); }
});

function foreignFixture() {
  const f = fixture();
  git(f.project, ['worktree', 'remove', '--force', f.root]);
  execFileSync('git', ['clone', '--quiet', '--no-local', f.project, f.root]);
  git(f.root, ['config', 'user.name', 'Shipyard Test']);
  git(f.root, ['config', 'user.email', 'shipyard-test@example.invalid']);
  git(f.root, ['config', 'commit.gpgsign', 'false']);
  git(f.root, ['switch', '-c', f.row.epic]);
  git(f.root, ['update-ref', '-d', 'refs/remotes/origin/' + f.row.epic]);
  git(f.root, ['update-ref', 'refs/remotes/origin/main', f.pr.baseRefOid]);
  git(f.root, ['rm', '-r', '.planning']);
  git(f.root, ['commit', '-m', 'coordinator owns planning']);
  f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
  f.row.repo = 'acme/app';
  f.graph.epics = { '38': { branch: f.row.epic, phaseDir: '38-codex-arch-review', repos: ['acme/app'] } };
  write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
  write(f.project, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' },
    delivery_pipeline: { code_review: 'hold', repos: { 'acme/app': f.root } } }));
  f.options.getPullRequest = ({ worktree, pr, repo }) => {
    assert.equal(worktree, f.root);
    assert.equal(pr, f.pr.number);
    assert.equal(repo, 'acme/app');
    return f.pr;
  };
  f.options.execFileSync = (executable, args, options) => {
    if (executable === 'gh') {
      assert.deepEqual(args, ['repo', 'view', 'acme/app', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
      return 'main\n';
    }
    assert.equal(executable, 'git');
    assert.equal(args.some(arg => ['fetch', 'push', 'pull', 'clone', 'ls-remote'].includes(arg)), false);
    return execFileSync(executable, args, options);
  };
  f.build = (runtime = 'codex') => require(path.join(scripts, 'deliver-dispatch.cjs')).build([
    'code-review', '38-codex-arch-review', '--phase', '38', '--pr', String(f.pr.number),
    '--runtime', runtime, '--repo', 'acme/app', '--graph', f.graphDir,
  ], { ...f.options, cwd: f.root });
  f.scope = () => f.build().scope;
  f.prepare = (extra = {}, launch = {}) => {
    const request = f.build();
    return context.prepare(request.scope, { role: request.role, context: request.context, signals: request.signals, ...launch },
      { ...f.options, inflightDispatchId: crypto.randomUUID(), ...extra });
  };
  f.lookup = (extra = {}) => artifact.currentCodeReviewVerdict({ worktreePath: f.root, graphDir: f.graphDir,
    repo: 'acme/app', pr: f.pr.number, head: f.pr.headRefOid, headBranch: f.pr.headRefName,
    baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, ...extra });
  f.status = () => require(path.join(scripts, 'phase-code-review.cjs')).status({ worktree: f.root,
    graphDir: f.graphDir, repo: 'acme/app', pr: f.pr.number, phase: 38, live: f.pr }, f.options);
  return f;
}

for (const incomplete of [false, true])
  test('configured foreign builder through seal and hold: incomplete=' + incomplete, () => {
    const f = foreignFixture();
    try {
      assert.notEqual(target.repositoryIdentity(f.root), target.repositoryIdentity(f.project));
      assert.equal(fs.existsSync(path.join(f.root, '.planning')), false);
      const request = f.build();
      assert.deepEqual(request.context, { repo: 'acme/app' });
      const r = review(f, raw => {
        if (incomplete) {
          raw.review_completeness = 'incomplete'; raw.limitations = ['Unread source']; raw.findings = [blocker()];
        }
      });
      const p = r.value.prepared;
      assert.equal(p.repository, target.repositoryIdentity(f.root));
      assert.equal(p.canonical.head, f.pr.headRefOid);
      assert.equal(p.baseCommit, f.pr.baseRefOid);
      assert.equal(p.packet.canonical_root, f.project);
      assert.equal(p.packet.role_context.planning_reference.root, f.project);
      assert.equal(p.packet.role_context.planning_reference.repo, 'acme/app');
      assert.equal(p.packet.source_revision, f.pr.headRefOid);
      assert.ok(p.packet.required_refs.some(ref => ref.path === f.row.plan));
      const prior = artifact.priorCodeReviewVerdicts({ worktreePath: f.root, repository: p.repository,
        graphDir: f.graphDir, phaseDir: p.binding.phase });
      assert.equal(prior.length, 1);
      assert.equal(prior[0].verdict, incomplete ? 'incomplete' : 'pass');
      assert.equal(f.lookup().artifact_digest, r.result.artifact.digest);
      const status = f.status(), flow = require(path.join(scripts, 'phase-code-review.cjs'));
      assert.equal(status.rounds_used, incomplete ? 0 : 1);
      assert.equal(flow.evaluateGate(status).ok, !incomplete);
      if (incomplete) {
        assert.equal(status.state, 'owed'); assert.equal(status.retry, true);
        const next = f.prepare();
        assert.equal(next.prepared.round.round, 1);
        assert.equal(next.prepared.round.scope, 'full');
      } else {
        assert.equal(status.state, 'current'); assert.equal(status.verdict, 'pass');
      }
      const bytes = fs.readFileSync(r.result.artifact.ref);
      f.row.title = 'changed membership';
      write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
      assert.equal(f.lookup(), null);
      assert.equal(flow.evaluateGate(f.status()).ok, false);
      assert.equal(artifact.priorCodeReviewVerdicts({ worktreePath: f.root, repository: p.repository,
        graphDir: f.graphDir, phaseDir: p.binding.phase })[0].artifact_digest, r.result.artifact.digest);
      assert.deepEqual(fs.readFileSync(r.result.artifact.ref), bytes);
    } finally { f.cleanup(); }
  });

function preparationOnlyClaudeHost() {
  const Module = require('node:module');
  const filename = path.join(scripts, 'claude-role-host.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({',
    'module.exports = Object.freeze({ prepareInvocation,'), filename);
  return loaded.exports;
}

test('explicit foreign pure Claude and Codex preparation retain separate planning and source identities', () => {
  const f = foreignFixture();
  try {
    const codex = f.prepare().prepared;
    const request = f.build('claude');
    const claude = preparationOnlyClaudeHost().prepareInvocation(f.options, request);
    assert.equal(claude.canonical.commonPath, codex.repository);
    assert.equal(claude.canonical.head, codex.canonical.head);
    assert.equal(claude.packet.canonical_root, codex.packet.canonical_root);
    assert.deepEqual(claude.packet.role_context.planning_reference, codex.packet.role_context.planning_reference);
    assert.deepEqual(claude.binding.ticketSet, codex.binding.ticketSet);
    assert.equal(claude.baseCommit, codex.baseCommit);
  } finally { f.cleanup(); }
});

for (const changed of ['graph', 'config', 'plan', 'source', 'head', 'base', 'root'])
  test('foreign launch and finish reject original identity drift: ' + changed, () => {
    const f = foreignFixture();
    try {
      const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id });
      admit(f, v);
      const d = dispatchFixture(f, v);
      if (changed === 'graph') fs.appendFileSync(path.join(f.graphDir, 'tickets.json'), ' ');
      if (changed === 'config') fs.appendFileSync(path.join(f.project, '.planning/config.json'), ' ');
      if (changed === 'plan') fs.appendFileSync(path.join(f.project, f.row.plan), '\nChanged acceptance.\n');
      if (changed === 'source') fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'dirty');
      if (changed === 'head') f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), '\n'));
      if (changed === 'base') git(f.root, ['update-ref', 'refs/remotes/origin/main', f.pr.headRefOid]);
      if (changed === 'root') {
        fs.renameSync(path.join(f.project, '.planning'), path.join(f.project, 'planning-moved'));
        fs.symlinkSync('planning-moved', path.join(f.project, '.planning'));
      }
      assert.throws(() => context.recheckInstalledLaunch(v));
      assert.throws(() => context.finish(v, d.dispatch, d.recorder));
      assert.deepEqual(artifact.authenticatedArchivePins(f.root), []);
    } finally { f.cleanup(); }
  });

for (const changed of ['missing selector', 'wrong selector', 'missing mapping', 'wrong checkout', 'nested checkout',
  'epic repo', 'epic directory', 'row epic', 'plan symlink', 'checkout symlink'])
  test('foreign selection refuses ' + changed, () => {
    const f = foreignFixture();
    try {
      const request = f.build();
      if (changed === 'missing selector') request.context = {};
      if (changed === 'wrong selector') request.context.repo = 'acme/wrong';
      if (['missing mapping', 'wrong checkout', 'nested checkout', 'checkout symlink'].includes(changed)) {
        let checkout = f.root;
        if (changed === 'wrong checkout') checkout = f.project;
        if (changed === 'nested checkout') checkout = path.join(f.root, 'src');
        if (changed === 'checkout symlink') { checkout = path.join(f.parent, 'alias'); fs.symlinkSync(f.root, checkout); }
        write(f.project, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' },
          delivery_pipeline: { repos: changed === 'missing mapping' ? {} : { 'acme/app': checkout } } }));
      }
      if (changed === 'epic repo') f.graph.epics['38'].repos = ['acme/wrong'];
      if (changed === 'epic directory') f.graph.epics['38'].phaseDir = '38-other';
      if (changed === 'row epic') f.row.epic = 'epic/wrong';
      write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
      if (changed === 'plan symlink') {
        const plan = path.join(f.project, f.row.plan), outside = path.join(f.storage, 'plan');
        fs.renameSync(plan, outside); fs.symlinkSync(outside, plan);
      }
      assert.throws(() => context.prepare(request.scope,
        { role: request.role, context: request.context, signals: request.signals }, f.options));
    } finally { f.cleanup(); }
  });

test('foreign current lookup refuses changed sealed planning bytes', () => {
  const f = foreignFixture();
  try {
    review(f);
    const plan = path.join(f.project, f.row.plan), original = fs.readFileSync(plan);
    fs.appendFileSync(plan, '\nChanged acceptance.\n');
    assert.equal(f.lookup(), null);
    assert.equal(require(path.join(scripts, 'phase-code-review.cjs')).evaluateGate(f.status()).ok, false);
    fs.writeFileSync(plan, original);
    assert.equal(f.lookup().verdict, 'pass');
    fs.appendFileSync(path.join(f.project, '.planning/config.json'), ' ');
    assert.equal(f.lookup(), null);
  } finally { f.cleanup(); }
});

for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'])
  test('foreign collection keeps Git identity isolated from ambient ' + key, () => {
    const f = foreignFixture(), saved = process.env[key];
    try {
      const request = f.build();
      process.env[key] = key === 'GIT_WORK_TREE' ? f.project : path.join(f.project, '.git', key === 'GIT_INDEX_FILE' ? 'index' : '');
      assert.throws(() => context.prepare(request.scope,
        { role: request.role, context: request.context, signals: request.signals }, f.options), { code: 'STALE_CONTEXT' });
      assert.throws(() => f.lookup(), { code: 'ARCHIVE_AUTHORITY_INVALID' });
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
      f.cleanup();
    }
  });

test('D37 foreign full and delta lineage retain original membership across coordinator graph evolution', () => {
  const f = foreignFixture();
  try {
    const first = review(f);
    const firstManifest = fs.readFileSync(first.result.artifact.ref);
    f.graph.tickets['T-38-02'] = { ...f.row, plan: '.planning/phases/38-codex-arch-review/38-02-PLAN.md' };
    f.state['T-38-02'] = { status: 'merged' };
    write(f.project, f.graph.tickets['T-38-02'].plan, fs.readFileSync(path.join(f.project, f.row.plan)));
    write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
    write(f.project, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), '\n'));
    const second = review(f);
    assert.equal(second.value.prepared.round.round, 2);
    assert.equal(second.value.prepared.round.scope, 'delta');
    assert.equal(second.value.prepared.round.priorHead, first.value.prepared.canonical.head);
    assert.equal(f.lookup().verdict, 'pass');
    assert.equal(require(path.join(scripts, 'phase-code-review.cjs')).evaluateGate(f.status()).ok, true);
    const prior = artifact.priorCodeReviewVerdicts({ worktreePath: f.root, repository: target.repositoryIdentity(f.root),
      graphDir: f.graphDir, phaseDir: second.value.prepared.binding.phase });
    assert.equal(prior.length, 2);
    assert.equal(prior[0].artifact_digest, first.result.artifact.digest);
    assert.equal(prior[1].artifact_digest, second.result.artifact.digest);
    assert.deepEqual(fs.readFileSync(first.result.artifact.ref), firstManifest);
    fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'dirty source');
    assert.equal(f.lookup(), null);
    assert.equal(require(path.join(scripts, 'phase-code-review.cjs')).evaluateGate(f.status()).ok, false);
  } finally { f.cleanup(); }
});

for (const sameRoot of [true, false])
  test('original complete planning controls current reuse: same=' + sameRoot, () => {
    const f = fixture('original-planning', sameRoot);
    try {
      f.graph.epics = { '38': { branch: f.row.epic, phaseDir: '38-codex-arch-review', repos: [null] } };
      write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
      write(f.project, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' },
        delivery_pipeline: { code_review: 'hold' } }));
      if (sameRoot) {
        git(f.root, ['add', '.planning']); git(f.root, ['commit', '--quiet', '-m', 'canonical review graph and hold mode']);
        f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
      }
      const builder = require(path.join(scripts, 'deliver-dispatch.cjs'));
      f.prepare = (extra = {}, launch = {}) => {
        const request = builder.build(['code-review', '38-codex-arch-review', '--phase', '38', '--pr', String(f.pr.number),
          '--runtime', 'codex', '--graph', f.graphDir], { ...f.options, cwd: f.root, defaultBranch: 'main' });
        return context.prepare(request.scope, { role: request.role, context: request.context, signals: request.signals, ...launch },
          { ...f.options, inflightDispatchId: crypto.randomUUID(), ...extra });
      };
      const r = review(f, raw => { raw.host_context = { planning_reference: { root: '/model-selected' }, selected_refs: [] }; });
      const flow = require(path.join(scripts, 'phase-code-review.cjs'));
      const lookup = () => artifact.currentCodeReviewVerdict({ worktreePath: f.root, graphDir: f.graphDir,
        pr: f.pr.number, head: f.pr.headRefOid, headBranch: f.pr.headRefName,
        baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid });
      const status = () => flow.status({ worktree: f.root, graphDir: f.graphDir, phase: 38, pr: f.pr.number, live: f.pr },
        { defaultBranch: 'main' });
      assert.equal(lookup().artifact_digest, r.result.artifact.digest);
      assert.equal(flow.evaluateGate(status()).ok, true);
      const manifest = JSON.parse(fs.readFileSync(r.result.artifact.ref));
      const sealed = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
      assert.deepEqual(sealed.host_context, { original_packet: JSON.parse(JSON.stringify(require(path.join(scripts, 'context-packet.cjs')).encodeUniqueContent((({ digest, ...packet }) => packet)(r.value.prepared.packet)))), planning_reference: r.value.prepared.packet.role_context.planning_reference,
        selected_refs: r.value.evidence.selected_refs });
      assert.deepEqual(sealed.host_context.selected_refs.map(pin => pin.path), [f.row.plan]);
      const head = git(f.root, ['rev-parse', 'HEAD']), base = f.pr.baseRefOid;
      const membership = r.value.prepared.binding.membership;
      const archives = artifact.authenticatedArchivePins(f.root).map(pin => ({ ...pin,
        content: fs.readFileSync(path.join(f.root, pin.path)) }));
      for (const relative of [f.row.plan, '.planning/config.json']) {
        const absolute = path.join(f.project, relative), original = fs.readFileSync(absolute);
        const changed = relative === f.row.plan
          ? original.toString().replace('- Review the authenticated PR diff against ADR-014.',
            '- Reject all requests that lack a new authorization token.') : original.toString() + ' ';
        fs.writeFileSync(absolute, changed);
        assert.notDeepEqual(fs.readFileSync(absolute), original);
        assert.equal(git(f.root, ['rev-parse', 'HEAD']), head);
        assert.equal(git(f.root, ['rev-parse', 'refs/remotes/origin/main']), base);
        assert.equal(target.phaseBinding({ graph: f.graph, state: f.state, phase: 38,
          repository: target.repositoryIdentity(f.root), pr: f.pr.number, head, base, branch: f.row.epic }).membership, membership);
        assert.throws(() => context.recheckInstalledLaunch(r.value));
        assert.equal(lookup(), null); assert.equal(status().state, 'owed'); assert.equal(flow.evaluateGate(status()).ok, false);
        const prior = artifact.priorCodeReviewVerdicts({ worktreePath: f.root, repository: target.repositoryIdentity(f.root),
          phaseDir: r.value.prepared.binding.phase, graphDir: f.graphDir });
        assert.equal(prior[0].artifact_digest, r.result.artifact.digest);
        for (const pin of archives) assert.deepEqual(fs.readFileSync(path.join(f.root, pin.path)), pin.content);
        fs.writeFileSync(absolute, original);
        assert.equal(lookup().artifact_digest, r.result.artifact.digest);
        assert.equal(flow.evaluateGate(status()).ok, true);
      }
      fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'dirty source');
      assert.equal(lookup(), null); assert.equal(flow.evaluateGate(status()).ok, false);
    } finally { f.cleanup(); }
  });

for (const format of ['old-inline', 'missing', 'truncated', 'duplicate', 'substituted', 'mismatched'])
  test('D37 authenticated inline archive without complete original pins stays historical: ' + format, () => {
    const f = fixture('retained-inline', true);
    try {
      f.graph.epics = { '38': { branch: f.row.epic, phaseDir: '38-codex-arch-review', repos: [null] } };
      write(f.project, '.planning/graph/tickets.json', JSON.stringify(f.graph));
      write(f.project, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' },
        delivery_pipeline: { code_review: 'hold' } }));
      git(f.root, ['add', '.planning']); git(f.root, ['commit', '--quiet', '-m', 'canonical retained review inputs']);
      f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
      const Module = require('node:module');
      const filename = path.join(scripts, 'codex-code-review-context.cjs');
      let source = fs.readFileSync(filename, 'utf8');
      if (format === 'old-inline') source = source.replace('roleContext.planning_reference = planning;',
        'if (project !== worktree) roleContext.planning_reference = planning;');
      else {
        const expressions = { missing: 'undefined', truncated: '[]', duplicate: '[...value.evidence.selected_refs, ...value.evidence.selected_refs]',
          substituted: "value.evidence.selected_refs.map(pin => ({ ...pin, path: '.planning/config.json' }))",
          mismatched: "value.evidence.selected_refs.map(pin => ({ ...pin, sha256: '0'.repeat(64) }))" };
        source = source.replace('selected_refs: value.evidence.selected_refs', 'selected_refs: ' + expressions[format]);
      }
      source = source.replace("const roleArtifact = require('./role-artifact.cjs');",
        'const roleArtifact = require(' + JSON.stringify(require.resolve('../fixtures/code-review/artifact-fixture.cjs'))
          + ').originalHistoricalProducer();');
      const retained = new Module(filename, module);
      retained.filename = filename; retained.paths = Module._nodeModulePaths(scripts);
      retained._compile(source, filename);
      const builder = retained.exports;
      const id = crypto.randomUUID();
      const value = builder.prepare(f.scope(), { role: 'code-review', context: {}, signals: {}, dispatch_id: id },
        { ...f.options, inflightDispatchId: id });
      admit(f, value, builder);
      const d = dispatchFixture(f, value, () => {}, true, () => {}, builder);
      const result = builder.finish(value, d.dispatch, d.recorder);
      const fresh = { worktreePath: f.root, role: 'code-review', ticket: value.prepared.ticket,
        pr: f.pr.number, base: value.prepared.base, phase: value.prepared.binding.phase,
        ticketSet: value.prepared.binding.ticketSet, ticketSetDigest: value.prepared.binding.membership,
        recorder: d.recorder, dispatchId: d.dispatch.dispatch_id, result: result.result };
      assert.throws(() => artifact.sealJudgment(fresh));
      const manifest = JSON.parse(fs.readFileSync(result.artifact.ref));
      const findings = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
      if (format === 'old-inline') {
        assert.equal(value.prepared.packet.role_context.planning_reference, undefined);
        assert.deepEqual(Object.keys(findings.host_context), ['original_packet']);
      }
      assert.equal(findings.context_digest, value.prepared.packet.digest);
      const lookup = () => artifact.currentCodeReviewVerdict({ worktreePath: f.root, graphDir: f.graphDir,
        pr: f.pr.number, head: f.pr.headRefOid, headBranch: f.pr.headRefName,
        baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid });
      const flow = require(path.join(scripts, 'phase-code-review.cjs'));
      const status = () => flow.status({ worktree: f.root, graphDir: f.graphDir, phase: 38, pr: f.pr.number, live: f.pr },
        { defaultBranch: 'main' });
      const pins = artifact.authenticatedArchivePins(f.root).map(pin => ({ ...pin,
        content: fs.readFileSync(path.join(f.root, pin.path)) }));
      const plan = path.join(f.project, f.row.plan), original = fs.readFileSync(plan);
      for (const content of [original, Buffer.concat([original, Buffer.from('\nNew authorization requirement.\n')]), original]) {
        fs.writeFileSync(plan, content);
        assert.equal(lookup(), null);
        assert.equal(status().state, 'owed'); assert.equal(flow.evaluateGate(status()).ok, false);
        const prior = artifact.priorCodeReviewVerdicts({ worktreePath: f.root, graphDir: f.graphDir,
          repository: target.repositoryIdentity(f.root), phaseDir: value.prepared.binding.phase });
        assert.equal(prior[0].artifact_digest, result.artifact.digest);
        assert.equal(prior[0].answer_authenticated, false); assert.equal(prior[0].coverage_range, null);
        assert.equal(status().rounds_used, 1);
        for (const pin of pins) assert.deepEqual(fs.readFileSync(path.join(f.root, pin.path)), pin.content);
      }
    } finally { f.cleanup(); }
  });

function r5setup(label){
 const f=fixture(label);
 f.graph.epics={'38':{branch:f.row.epic,phaseDir:'38-codex-arch-review',repos:[null]}};
 write(f.project,'.planning/graph/tickets.json',JSON.stringify(f.graph));
 write(f.project,'.planning/config.json',JSON.stringify({git:{base_branch:'main'},delivery_pipeline:{code_review:'hold'}}));
 f.options.defaultBranch='main';
 const builder=require(path.join(scripts,'deliver-dispatch.cjs'));
 f.build=(runtime)=>builder.build(['code-review','38-codex-arch-review','--phase','38','--pr',String(f.pr.number),'--runtime',runtime,'--graph',f.graphDir],{...f.options,cwd:f.root,defaultBranch:'main'});
 f.prepare=(extra={},launch={})=>{
  const r=f.build('codex');
  return context.prepare(r.scope,{role:r.role,context:r.context,signals:r.signals,...launch},{...f.options,inflightDispatchId:crypto.randomUUID(),...extra});
 };
 f.pureClaude=()=>preparationOnlyClaudeHost().prepareInvocation({...f.options,defaultBranch:'main'},f.build('claude'));
 f.prior=()=>artifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:'38-codex-arch-review',graphDir:f.graphDir});
 f.current=()=>artifact.currentCodeReviewVerdict({worktreePath:f.root,graphDir:f.graphDir,pr:f.pr.number,head:f.pr.headRefOid,headBranch:f.pr.headRefName,baseName:f.pr.baseRefName,baseCommit:f.pr.baseRefOid});
 const flow=require(path.join(scripts,'phase-code-review.cjs'));
 f.input=()=>({worktree:f.root,graphDir:f.graphDir,phase:38,pr:f.pr.number,live:f.pr});
 f.status=()=>flow.status(f.input(),{defaultBranch:'main'});
 f.gate=()=>flow.evaluateGate(f.status());
 return f;
}
function r5archive(f){return artifact.authenticatedArchivePins(f.root).map(p=>({...p,content:fs.readFileSync(path.join(f.root,p.path))}));}
function r5archiveUnchanged(f,pins){for(const p of pins)assert.deepEqual(fs.readFileSync(path.join(f.root,p.path)),p.content);}

for(const baselineComplete of [false,true])test('coverage incomplete retry '+baselineComplete,()=>{
 const f=r5setup('r5-incomplete-'+baselineComplete);
 try{
  let baseline;
  if(baselineComplete){baseline=review(f);assert.equal(f.current().verdict,'pass');assert.equal(f.gate().ok,true);}
  const failed=review(f,raw=>{raw.review_completeness='incomplete';raw.limitations=['The rest of the input was not reviewed.'];raw.findings=[blocker()];});
  const pins=r5archive(f),history=f.prior(),before=f.status();
  const incomplete=history.find(p=>p.artifact_digest===failed.result.artifact.digest);
  assert.equal(incomplete.review_completeness,'incomplete');assert.equal(incomplete.blocking_count,1);
  assert.equal(before.state,'owed');assert.equal(before.rounds_used,baselineComplete?1:0);assert.equal(before.retry,true);
  assert.equal(f.gate().ok,false);
  assert.deepEqual(require(path.join(scripts,'phase-code-review.cjs')).fixTickets(f.input(),{defaultBranch:'main',stderr:{write(){}}}),[]);
  const codex=f.prepare().prepared,claude=f.pureClaude();
  assert.equal(codex.round.round,baselineComplete?2:1);assert.equal(codex.round.scope,baselineComplete?'delta':'full');
  assert.equal(claude.round.round,codex.round.round);assert.equal(claude.round.scope,codex.round.scope);
  assert.equal(codex.priorFindings.length,0);assert.equal(claude.priorFindings.length,0);
  if(!baselineComplete)assert.deepEqual(codex.packet.role_context.change_metadata.changes.flatMap(change=>change.paths),['src/reviewed.txt']);
  const retry=review(f);
  assert.equal(f.current().verdict,'pass');assert.equal(f.current().blocking_count,0);assert.equal(f.gate().ok,true);
  assert.equal(f.status().rounds_used,baselineComplete?2:1);
  assert.equal(f.prior().find(p=>p.artifact_digest===failed.result.artifact.digest).blocking_count,1);
  r5archiveUnchanged(f,pins);
 }finally{f.cleanup();}
});

test('coverage integration base rewind',()=>{
 const f=r5setup('r5-base-rewind');
 try{
  const oldHead=git(f.root,['rev-parse','HEAD']);
  const A=oldHead,marker='BASE_ONLY_EXPOSED_CHANGE';
  write(f.root,'src/inherited-base-only.txt',marker+'\n');
  git(f.root,['add','src/inherited-base-only.txt']);git(f.root,['commit','--quiet','-m','integration adds an inherited product file']);
  const B=git(f.root,['rev-parse','HEAD']);
  f.commit(()=>fs.appendFileSync(path.join(f.root,'src/reviewed.txt'),'const phaseChange = 1;\n'));
  const H=f.pr.headRefOid;
  git(f.root,['update-ref','refs/heads/main',B]);git(f.root,['update-ref','refs/remotes/origin/main',B]);f.pr.baseRefOid=B;
  const oldClaude=f.pureClaude();
  assert.equal(oldClaude.round.scope,'full');
  const first=review(f),initial=f.current(),pins=r5archive(f);
  assert.equal(initial.verdict,'pass');assert.equal(initial.scope,'full');assert.equal(f.gate().ok,true);
  assert(!first.value.prepared.packet.role_context.change_metadata.changes.some(change=>change.paths.includes('src/inherited-base-only.txt')));
  const oldDiff=git(f.root,['diff',B,H,'--','src']);
  assert(oldDiff.includes('phaseChange'));assert(!oldDiff.includes(marker));
  const membership=first.value.prepared.binding.membership;
  git(f.root,['update-ref','refs/heads/main',A]);git(f.root,['update-ref','refs/remotes/origin/main',A]);f.pr.baseRefOid=A;
  assert.equal(git(f.root,['rev-parse','HEAD']),H);
  const prior=f.prior();assert.equal(prior.length,1);assert.equal(prior[0].base_commit,B);assert.equal(prior[0].artifact_digest,first.result.artifact.digest);
  assert.equal(f.current(),null);const owed=f.status();assert.equal(owed.state,'owed');assert.equal(owed.rounds_used,1);assert.equal(f.gate().ok,false);
  assert.throws(()=>context.recheckInstalledLaunch(first.value));
  const fullCurrentDiff=git(f.root,['diff',A,H,'--','src']);
  assert(fullCurrentDiff.includes(marker));assert(fullCurrentDiff.includes('phaseChange'));
  const codex=f.prepare().prepared,claude=f.pureClaude();
  assert.equal(codex.binding.membership,membership);assert.equal(codex.round.round,2);assert.equal(codex.round.scope,'full');
  assert.equal(codex.round.priorHead,H);assert.equal(codex.round.deltaBase,null);
  assert.equal(codex.packet.role_context.integration_base.commit,A);assert(codex.packet.role_context.change_metadata.changes.some(change=>change.paths.includes('src/inherited-base-only.txt')));
  assert.equal(claude.round.round,2);assert.equal(claude.round.scope,'full');
  assert.equal(claude.round.priorHead,H);assert.equal(claude.packet.role_context.integration_base.commit,A);
  const second=review(f),current=f.current(),after=f.status(),latest=f.prior();
  assert.equal(current.verdict,'pass');assert.equal(current.scope,'full');assert.equal(current.prior_head,H);
  assert.equal(after.state,'current');assert.equal(after.rounds_used,2);assert.equal(f.gate().ok,true);
  assert.equal(latest.length,2);assert(latest.some(p=>p.base_commit===B&&p.review_scope==='full'));assert(latest.some(p=>p.base_commit===A&&p.review_scope==='full'));
  r5archiveUnchanged(f,pins);
 }finally{f.cleanup();}
});

test('expanded material preserves own-head disagreement and twin identities in both preparations and spends the cap', () => {
  const f = r5setup('coverage-twin');
  try {
    const initialBase = f.pr.baseRefOid;
    const A = git(f.root, ['rev-parse', 'HEAD']);
    const source = path.join(f.root, 'src/reviewed.txt');
    fs.writeFileSync(source, warning().line_text + '\n' + fs.readFileSync(source, 'utf8'));
    write(f.root, 'src/inherited-base-only.txt', 'BASE_ONLY_EXPOSED_CHANGE\n');
    git(f.root, ['add', 'src']); git(f.root, ['commit', '--quiet', '-m', 'base adds an identical twin']);
    const B = git(f.root, ['rev-parse', 'HEAD']);
    f.commit(() => fs.appendFileSync(source, 'phase change\n'));
    const move = base => {
      git(f.root, ['update-ref', 'refs/heads/main', base]);
      git(f.root, ['update-ref', 'refs/remotes/origin/main', base]); f.pr.baseRefOid = base;
    };
    move(B);
    const first = review(f, raw => { raw.findings = [blocker({ line: 62 })]; });
    const original = first.result.result.findings[0];
    assert.equal(original.occurrence, 2);
    const relative = '.planning/phases/38-codex-arch-review/code-review-disagreements.json';
    const disagreement = { schema: 'shipyard.code-review-disagreements.v1', entries: [{ path: original.path,
      line_text: original.line_text, occurrence: original.occurrence, reason: 'Accepted target', recorded_by: 'owner' }] };
    write(f.project, relative, JSON.stringify(disagreement));
    move(A);
    for (const prepared of [f.prepare().prepared, f.pureClaude()]) {
      assert.equal(prepared.round.round, 2); assert.equal(prepared.round.scope, 'full');
      assert(prepared.packet.role_context.change_metadata.name_status.includes('src/inherited-base-only.txt'));
      const carried = prepared.priorFindings[0];
      assert.equal(carried.identity, original.identity); assert.equal(carried.line, original.line);
      assert.equal(carried.occurrence, 2); assert.equal(carried.delta_touch, false);
      assert.equal(carried.disagreement_identity, original.identity);
      assert.equal(prepared.priorFindings.length, 1);
    }
    write(f.project, relative, JSON.stringify({ ...disagreement, entries: [{ ...disagreement.entries[0], occurrence: 99 }] }));
    assert.throws(() => f.prepare(), error => error.code === 'DISPOSITION_TARGET_UNKNOWN');
    assert.throws(() => f.pureClaude(), error => error.code === 'DISPOSITION_TARGET_UNKNOWN');
    write(f.project, relative, JSON.stringify(disagreement));
    const second = review(f);
    const retained = second.result.result.findings[0];
    assert.equal(retained.suppressed, true); assert.equal(retained.line, original.line);
    assert.equal(retained.disagreement_identity, original.identity);
    assert.equal(second.result.result.review_round, 2); assert.equal(second.result.result.review_scope, 'full');
    const pins = r5archive(f);
    move(B);
    assert.equal(f.current(), null);
    assert.equal(f.status().rounds_used, 2); assert.equal(f.gate().ok, false);
    r5archiveUnchanged(f, pins);
    const currentCarrier = fs.readFileSync(path.join(f.project, relative));
    fs.unlinkSync(path.join(f.project, relative));
    const returnedB = f.current();
    assert.equal(returnedB.artifact_digest, first.result.artifact.digest);
    assert.equal(returnedB.round, 1); assert.equal(returnedB.verdict, 'needs-fix');
    assert.equal(returnedB.blocking_count, 1); assert.equal(f.gate().ok, false);
    fs.writeFileSync(path.join(f.project, relative), currentCarrier);
    assert.equal(f.current(), null);
    for (const prepared of [f.prepare().prepared, f.pureClaude()]) {
      assert.equal(prepared.round.round, 3); assert.equal(prepared.round.scope, 'delta');
      assert.equal(prepared.packet.role_context.change_metadata.name_status, '');
    }
    review(f);
    assert.equal(f.status().rounds_used, 3); assert.equal(f.gate().ok, true);
    move(initialBase);
    assert.equal(f.current(), null); assert.equal(f.status().state, 'limit'); assert.equal(f.gate().ok, false);
    assert.throws(() => f.prepare(), error => error.code === 'CODE_REVIEW_ROUND_LIMIT');
    assert.throws(() => f.pureClaude(), error => error.code === 'CODE_REVIEW_ROUND_LIMIT');
    r5archiveUnchanged(f, pins);
  } finally { f.cleanup(); }
});

function d35SealInput(f, value, d, result) {
  return { worktreePath: f.root, role: 'code-review', ticket: value.prepared.ticket, pr: f.pr.number,
    base: value.prepared.base, phase: value.prepared.binding.phase, ticketSet: value.prepared.binding.ticketSet,
    ticketSetDigest: value.prepared.binding.membership, recorder: d.recorder, dispatchId: d.dispatch.dispatch_id,
    result, io: { execFileSync(executable, args, options) {
      if (executable === 'gh') return JSON.stringify(f.pr);
      return execFileSync(executable, args, options);
    } } };
}

test('D35 Codex completed original normalization reaches seal validate and current', () => {
  const f = fixture();
  try {
    const r = review(f, raw => { raw.findings = [warning({ severity: 'BLOCKER' }), { id: 'info', severity: 'INFO', summary: 'Observation' }]; });
    assert.equal(r.result.result.verdict, 'pass');
    assert.equal(r.result.result.demoted_for_evidence, 1); assert.equal(r.result.result.info_dropped, 1);
    assert.notDeepEqual(r.raw.findings, r.result.result.findings);
    const input = d35SealInput(f, r.value, r, r.result.result);
    assert.equal(artifact.validateJudgmentManifest({ ...input, artifactPath: r.result.artifact.ref,
      artifactDigest: r.result.artifact.digest }).envelope.outcome, 'pass');
    const lookup = () => artifact.currentCodeReviewVerdict({ worktreePath: f.root, pr: f.pr.number,
      head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, graphDir: f.graphDir });
    assert.equal(lookup().verdict, 'pass');
    const bytes = fs.readFileSync(r.nativePath); fs.writeFileSync(r.nativePath, bytes.subarray(0, bytes.length - 1));
    assert.throws(() => artifact.validateJudgmentManifest({ ...input, artifactPath: r.result.artifact.ref,
      artifactDigest: r.result.artifact.digest }), /native|original/);
    assert.equal(lookup(), null);
    fs.writeFileSync(r.nativePath, bytes); assert.equal(lookup().verdict, 'pass');
  } finally { f.cleanup(); }
});

for (const kind of ['needs-fix', 'incomplete']) test('D35 Codex public sealer refuses substituted pass before finish: ' + kind, () => {
  const f = fixture();
  try {
    const value = f.prepare(); admit(f, value);
    const d = dispatchFixture(f, value, raw => {
      if (kind === 'needs-fix') raw.findings = [blocker()];
      else { raw.review_completeness = 'incomplete'; raw.limitations = ['Unread source']; }
    });
    const core = require(path.join(scripts, 'code-review-core.cjs'));
    const { evidence_markdown: _markdown, ...normalized } = core.normalizeResult(d.raw, { round: 1, scope: 'full',
      readSource: file => fs.readFileSync(path.join(f.root, file), 'utf8') });
    const { digest: _digest, ...packet } = value.prepared.packet;
    const forged = { ...normalized, verdict: 'pass', findings: [], dispositions: [], blocking_count: 0, finding_count: 0,
      review_completeness: 'complete', limitations: [], unresolved_sources: [], prior_head: null,
      contract_digest: value.prepared.contractDigest, dispositions_digest: value.prepared.dispositionsDigest,
      reuse_key: core.reuseKey({ head: value.prepared.canonical.head, baseCommit: value.prepared.baseCommit,
        contractDigest: value.prepared.contractDigest }), host_context: {
        original_packet: require(path.join(scripts, 'context-packet.cjs')).encodeUniqueContent(packet),
        planning_reference: packet.role_context.planning_reference, selected_refs: value.evidence.selected_refs } };
    assert.throws(() => artifact.sealJudgment(d35SealInput(f, value, d, forged)), { code: 'REVIEW_NATIVE_INVALID' });
    assert.equal(context.finish(value, d.dispatch, d.recorder).result.verdict, kind);
  } finally { f.cleanup(); }
});

for (const mutation of ['stream-missing', 'native-final', 'native-completion', 'session', 'selection', 'packet'])
  test('D35 Codex refuses original native custody mutation: ' + mutation, () => {
    const f = fixture();
    try {
      const value = f.prepare(); admit(f, value);
      const d = dispatchFixture(f, value);
      const pin = d.runtimeEvidence;
      if (mutation === 'stream-missing') fs.unlinkSync(pin.transcript.path);
      else if (mutation === 'packet') {
        const rows = fs.readFileSync(d.nativePath, 'utf8').trim().split('\n').map(JSON.parse);
        rows[3].payload.content[0].text = rows[3].payload.content[0].text.replace('AUTHENTICATED_CONTEXT_PACKET', 'FOREIGN_CONTEXT_PACKET');
        fs.writeFileSync(d.nativePath, rows.map(JSON.stringify).join('\n') + '\n');
      } else {
        const rows = fs.readFileSync(d.nativePath, 'utf8').trim().split('\n').map(JSON.parse);
        if (mutation === 'native-final') rows[4].payload.content[0].text = '{}';
        if (mutation === 'native-completion') rows.pop();
        if (mutation === 'session') rows[0].payload.id = crypto.randomUUID();
        if (mutation === 'selection') rows[1].payload.effort = 'low';
        fs.writeFileSync(d.nativePath, rows.map(JSON.stringify).join('\n') + '\n');
      }
      assert.throws(() => context.finish(value, d.dispatch, d.recorder), mutation === 'stream-missing'
        ? { code: 'MISSING_RECEIPT', message: 'codex-arch-review-context: Codex architecture transcript is unavailable' }
        : /native|original|semantic|session/);
    } finally { f.cleanup(); }
  });

for (const mutation of ['native-final', 'completion', 'session', 'selection'])
  test('D35 Codex refuses authenticated foreign or incomplete native completion: ' + mutation, () => {
    const f = fixture();
    try {
      const value = f.prepare(); admit(f, value);
      const d = dispatchFixture(f, value, () => {}, true, (evidence, native) => {
        if (mutation === 'native-final') native.nativeRows[4].payload.content[0].text = '{}';
        if (mutation === 'completion') native.nativeRows.pop();
        if (mutation === 'session') native.nativeRows[0].payload.id = crypto.randomUUID();
        if (mutation === 'selection') native.nativeRows[1].payload.effort = 'low';
        const text = native.nativeRows.map(JSON.stringify).join('\n') + '\n';
        fs.writeFileSync(native.nativePath, text);
        evidence.native_session_evidence.bytes = Buffer.byteLength(text); evidence.native_session_evidence.sha256 = hash(text);
        evidence.input_consumption.native_session_sha256 = hash(text);
      });
      assert.throws(() => context.finish(value, d.dispatch, d.recorder), /native|original|policy|session/);
    } finally { f.cleanup(); }
  });

test('D35 Codex delta replay retains original carried identity and dispositions after later history', () => {
  const f = fixture();
  try {
    const first = review(f, raw => { raw.findings = [blocker()]; });
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), 'unrelated source addition\n'));
    const second = review(f, raw => { raw.dispositions = [{ ref: 'P-01', disposition: 'unresolved', justification: 'Still fails' }]; });
    assert.equal(second.result.result.review_scope, 'delta'); assert.equal(second.result.result.verdict, 'needs-fix');
    assert.equal(second.value.prepared.packet.role_context.normalization_inputs.prior_findings[0].identity,
      first.result.result.findings[0].identity);
    const third = review(f, raw => { raw.dispositions = [{ ref: 'P-01', disposition: 'resolved' }]; });
    assert.equal(third.result.result.verdict, 'pass');
    const input = d35SealInput(f, second.value, second, second.result.result);
    assert.equal(artifact.validateJudgmentManifest({ ...input, artifactPath: second.result.artifact.ref,
      artifactDigest: second.result.artifact.digest }).findings.verdict, 'needs-fix');
  } finally { f.cleanup(); }
});


function d35t36Review(mode = 'deletion', options = {}) {
  const fixtures = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const targets = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = fixtures.fixture('D35T36-codex-' + mode);
  const source = name => fs.readFileSync(path.join(__dirname, '../fixtures/code-review', name), 'utf8');
  const raw = JSON.parse(source('review.json'));
  const targetLine = mode === 'deletion' ? 6 : 4;
  const lines = options.lines || (mode === 'insertion' ? [2, 4, 6] : [6]);
  const firstRaw = { ...raw, findings: lines.map((line, index) => ({ ...raw.findings[0], id: 'CR-' + index,
    line, line_text: 'return null;' })) };
  const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
  const retain = (input, extra = {}) => fixtures.retainPlanningInput(f, input, f.root, null,
    { runtime: 'codex', ...extra });
  const lookup = () => ({ worktreePath: f.root, pr: 52, head: f.git(['rev-parse', 'HEAD']),
    baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.branch });
  const cold = () => JSON.parse(execFileSync(process.execPath, ['-e',
    "require('node:os').homedir = () => " + JSON.stringify(os.homedir()) + ';'
      + 'const a = require(' + JSON.stringify(require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs')) + ');'
      + 'try { process.stdout.write(JSON.stringify({current:a.currentCodeReviewVerdict('
      + JSON.stringify(lookup()) + ')})); } catch(e) { process.stdout.write(JSON.stringify({current:null,error:e.code})); }',
  ], { encoding: 'utf8', env: { ...process.env } }));
  const archives = [];
  const remember = sealed => {
    const manifest = JSON.parse(fs.readFileSync(sealed.artifact_ref));
    for (const absolute of [sealed.artifact_ref, ...Object.values(manifest.files).map(pin => path.join(f.root, pin.path))])
      archives.push({ absolute, bytes: fs.readFileSync(absolute) });
    return manifest;
  };
  try {
    fs.writeFileSync(path.join(f.root, 'source.js'), source('twins.js'));
    f.git(['add', 'source.js']);
    let firstBinding = f.advance(1);
    if (options.originScope === 'foreign-pr') firstBinding = targets.phaseBinding({ graph: f.graph, state: f.state,
      phase: 52, repository: targets.repositoryIdentity(f.root), pr: 53, head: f.git(['rev-parse', 'HEAD']), base: f.base, branch: f.branch });
    if (options.originScope === 'foreign-phase') {
      const graph = { tickets: { 'T-53-01': { ...f.graph.tickets['T-52-01'], phase: 53,
        plan: '.planning/phases/53-foreign/53-01-PLAN.md' } } };
      const state = { 'T-53-01': f.state['T-52-01'] };
      fs.writeFileSync(path.join(f.graphDir, 'tickets.json'), JSON.stringify(graph));
      fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({ tickets: state }));
      firstBinding = targets.phaseBinding({ graph, state, phase: 53, repository: targets.repositoryIdentity(f.root),
        pr: 52, head: f.git(['rev-parse', 'HEAD']), base: f.base, branch: f.branch });
    }
    const first = f.input(firstBinding, 1, null, firstRaw);
    if (options.originScope === 'foreign-pr') { first.pr = 53; first.result.pr = 53; }
    if (!options.inputOnly || options.inputOnly === 'native') retain(first);
    let firstSeal = null;
    if (!options.unsealed) {
      firstSeal = options.inputOnly ? fixtures.sealInputOnlyHistory(first) : artifacts.sealJudgment(first);
      remember(firstSeal);
    }
    f.writeGraph();
    const original = first.result.findings.find(finding => finding.line === targetLine);
    const text = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{
      path: 'source.js', line_text: 'return null;', occurrence: mode === 'deletion' ? 3 : 2,
      reason: 'The original target caller handles absence', recorded_by: 'operator',
    }] });
    fs.mkdirSync(path.join(f.root, '.planning/phases', f.phase), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json'), text);
    let previous = first.result.head, lastResult = first.result;
    return { f, core, artifacts, fixtures, targets, first, firstRaw, firstBinding, firstSeal, original, archives, cold, lookup, retain,
      assertOriginals() { for (const pin of archives) assert.deepEqual(fs.readFileSync(pin.absolute), pin.bytes); },
      next(round, extra = {}) {
        if (round === 2) {
          fs.writeFileSync(path.join(f.root, 'source.js'), mode === 'deletion' ? 'end();\n\treturn null;\n' : source('twins-added.js'));
          f.git(['add', 'source.js']);
        }
        const binding = f.advance(round);
        const deltaDiff = f.git(['diff', '--no-ext-diff', '--no-textconv', '--unified=50', previous, 'HEAD']);
        const prior = extra.predecessor || lastResult;
        const mapped = core.carryPriorFindings({ priorFindings: prior, deltaDiff, readSource });
        const disagreements = core.parseDisagreements(text, { priorFindings: mapped });
        const priorFindings = core.carryPriorFindings({ priorFindings: prior, deltaDiff, readSource, disagreements });
        extra.mutatePrior?.(priorFindings);
        const blank = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [] };
        const answer = { ...blank,
          findings: mode === 'insertion' && round === 2 ? [{ ...raw.findings[0], line: 5, line_text: 'return null;' }] : [],
          dispositions: priorFindings.filter(finding => !finding.disagreement).map(finding => ({
            ref: finding.ref, disposition: 'unresolved', justification: 'The other caller still fails',
          })),
        };
        extra.mutateAnswer?.(answer);
        const input = f.input(binding, round, previous, blank);
        fixtures.setOriginalReview(input, answer, priorFindings);
        retain(input, extra.native || {});
        extra.mutateInput?.(input);
        const sealed = artifacts.sealJudgment(input);
        const manifest = remember(sealed);
        const validated = artifacts.validateJudgmentManifest({ ...input,
          artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
        previous = input.result.head; lastResult = input.result;
        return { input, sealed, manifest, validated, priorFindings, deltaDiff };
      },
    };
  } catch (error) { f.cleanup(); throw error; }
}

for (const [mode, lines] of [['deletion', [6]], ['insertion', [4]], ['insertion', [2, 4, 6]]])
test('D35T36 codex three completed native rounds conserve original disagreement through ' + mode + ' with ' + lines.length + ' findings', () => {
  const r = d35t36Review(mode, { lines });
  try {
    for (const round of [2, 3]) {
      const v = r.next(round);
      const currentLine = mode === 'deletion' ? 2 : 5;
      const occurrence = mode === 'deletion' ? 1 : 3;
      if (round === 2) assert.deepEqual(r.core.mapLineThroughDiff('source.js', r.original.line, v.deltaDiff), { line: currentLine });
      const carried = v.priorFindings.find(finding => finding.disagreement);
      assert.equal(carried.delta_touch, false);
      assert.equal(carried.line, currentLine); assert.equal(carried.occurrence, occurrence);
      assert.equal(carried.disagreement_identity, r.original.identity);
      assert.equal(carried.stored_identity, round === 2 ? r.original.identity
        : r.core.lineIdentity({ path: 'source.js', lineText: 'return null;', ordinal: occurrence }));
      assert.equal(carried.disagreement.reason, 'The original target caller handles absence');
      const findings = v.validated.findings.findings;
      const suppressed = findings.filter(finding => finding.suppressed);
      assert.equal(suppressed.length, 1);
      assert.equal(suppressed[0].line, currentLine); assert.equal(suppressed[0].occurrence, occurrence);
      assert.equal(suppressed[0].identity, r.core.lineIdentity({ path: 'source.js', lineText: 'return null;', ordinal: occurrence }));
      assert.equal(suppressed[0].disagreement_identity, r.original.identity);
      assert.equal(v.validated.findings.dispositions.find(entry => entry.source === 'recorded_disagreement').justification,
        'The original target caller handles absence');
      const current = r.cold().current;
      assert.equal(current.disagreement_suppressed, 1); assert.equal(current.round, round);
      assert.equal(current.blocking_count, lines.length - 1);
      assert.deepEqual(current.findings, findings);
      if (mode === 'insertion' && lines.length === 3) {
        const others = findings.filter(finding => !finding.suppressed);
        assert.deepEqual(others.map(finding => finding.line), [3, 7]);
        assert.ok(others.every(finding => finding.blocking && !finding.disagreement_identity));
        assert.equal(new Set(findings.map(finding => finding.identity)).size, 3);
        assert.deepEqual(others.map(finding => finding.occurrence), [2, 4]);
        assert.equal(others[0].identity, r.original.identity);
      }
      const history = r.artifacts.priorCodeReviewVerdicts({ worktreePath: r.f.root,
        repository: r.targets.repositoryIdentity(r.f.root), phaseDir: r.f.phase });
      assert.equal(history.length, round); assert.ok(history.every(entry => entry.answer_authenticated));
      r.assertOriginals();
    }
  } finally { r.f.cleanup(); }
});

test('D35T36 codex cold replay loses authority for missing or altered original custody and recovers exact originals', () => {
  const r = d35t36Review();
  try {
    r.next(2); const third = r.next(3);
    const receipt = r.f.recorder.getVerifiedRecord(r.first.dispatchId).receipt;
    const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? walk(path.join(root, entry.name)) : [path.join(root, entry.name)]);
    const native = 'codex' === 'codex'
      ? walk(path.join(r.f.root, '.planning/codex-fixture/sessions')).find(file => file.endsWith(receipt.runtime_evidence.session_id + '.jsonl'))
      : receipt.selection_evidence.transcript.path;
    const stream = 'codex' === 'codex' ? receipt.runtime_evidence.transcript.path : receipt.transcript.path;
    const receiptFile = path.join(r.f.root, 'receipts', 'record-' + crypto.createHash('sha256').update(r.first.dispatchId).digest('hex') + '.json');
    const blob = r.f.git(['rev-parse', r.first.result.head + ':source.js']);
    const sourceObject = path.join(r.f.root, '.git/objects', blob.slice(0, 2), blob.slice(2));
    const authority = path.join(os.homedir(), '.local/state/shipyard/role-artifact-authority');
    const neighbour = path.join(authority, 'unrelated-cold-fixture');
    fs.mkdirSync(neighbour, { recursive: true });
    fs.writeFileSync(path.join(neighbour, 'catalogue.json'), JSON.stringify({ unrelated: true }));
    const catalogues = walk(authority).filter(file => path.basename(file) === 'catalogue.json'
      && JSON.parse(fs.readFileSync(file)).payload?.worktree === r.f.root);
    assert.equal(catalogues.length, 1);
    const [catalogue] = catalogues;
    assert.ok(catalogue); assert.ok(native);
    const originals = [...r.archives.slice(0, 3).map(pin => pin.absolute), receiptFile, native, stream, sourceObject, catalogue];
    for (const absolute of originals) {
      const bytes = fs.readFileSync(absolute), mode = fs.statSync(absolute).mode & 0o777;
      fs.chmodSync(absolute, 0o600);
      for (const mutation of ['missing', 'altered']) {
        assert.equal(r.cold().current.round, 3);
        if (mutation === 'missing') fs.unlinkSync(absolute);
        else fs.writeFileSync(absolute, Buffer.concat([bytes, Buffer.from('\nchanged original evidence')]));
        try {
          assert.equal(r.cold().current, null, absolute + ': ' + mutation);
          assert.throws(() => r.artifacts.validateJudgmentManifest({ ...third.input,
            artifactPath: third.sealed.artifact_ref, artifactDigest: third.sealed.artifact_digest }));
          assert.throws(() => r.artifacts.sealJudgment(third.input));
        } finally { fs.writeFileSync(absolute, bytes, { mode: 0o600 }); }
        assert.equal(r.cold().current.round, 3);
      }
      fs.chmodSync(absolute, mode);
    }
    r.assertOriginals();
  } finally { r.f.cleanup(); }
});

for (const kind of ['stored-identity', 'original-binding', 'wrong-association', 'model-origin', 'request-origin', 'snapshot-origin'])
test('D35T36 codex refuses authenticated carried snapshot provenance forgery: ' + kind, () => {
  const r = d35t36Review();
  try {
    r.next(2);
    assert.throws(() => r.next(3, {
      mutatePrior(prior) {
        if (kind === 'stored-identity') prior[0].stored_identity = r.original.identity;
        else if (kind === 'wrong-association') { prior[0].id = 'an-unrelated-archived-finding'; prior[0].summary = 'Same text, wrong sealed finding'; }
        else prior[0].disagreement_identity = r.core.lineIdentity({ path: 'source.js', lineText: 'return null;', ordinal: 2 });
        if (kind === 'snapshot-origin') Object.assign(prior[0], { origin_head: r.first.result.head, origin_dispatch: r.first.dispatchId });
      },
      mutateAnswer(answer) {
        if (kind === 'model-origin') Object.assign(answer, { origin_head: r.first.result.head, origin_dispatch: r.first.dispatchId,
          origin_artifact: r.firstSeal.artifact_ref });
      },
      mutateInput(input) {
        if (kind === 'request-origin') Object.assign(input, { origin_head: r.first.result.head, origin_dispatch: r.first.dispatchId,
          origin_artifact: r.firstSeal.artifact_ref });
      },
    }), error => error.code === 'REVIEW_NATIVE_INVALID');
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});

test('D35T36 codex arbitrary historical Git text and an unsealed native finding grant no origin authority', () => {
  const r = d35t36Review('deletion', { unsealed: true });
  try {
    assert.ok(r.f.git(['show', r.first.result.head + ':source.js']).includes('return null;'));
    assert.throws(() => r.next(2, { mutateAnswer(answer) {
      answer.review_completeness = 'incomplete'; answer.limitations = ['Controlled origin refusal'];
    } }), error => error.code === 'REVIEW_NATIVE_INVALID');
    assert.equal(r.cold().current, null);
  } finally { r.f.cleanup(); }
});

for (const inputOnly of [true, 'native'])
test('D35T36 codex input-only sealed history remains readable but supplies neither origin nor pass coverage: ' + inputOnly, () => {
  const r = d35t36Review('deletion', { inputOnly });
  try {
    const history = r.artifacts.priorCodeReviewVerdicts({ worktreePath: r.f.root,
      repository: r.targets.repositoryIdentity(r.f.root), phaseDir: r.f.phase });
    assert.equal(history.length, 1); assert.equal(history[0].answer_authenticated, false);
    assert.equal(history[0].coverage_range, null);
    assert.equal(r.core.coverageComplete({ verdict: history[0], priorVerdicts: [], mergeBase: r.f.base, isAncestor: () => true }), false);
    assert.throws(() => r.next(2, { mutateAnswer(answer) {
      answer.review_completeness = 'incomplete'; answer.limitations = ['Controlled input-only origin refusal'];
    } }), error => error.code === 'REVIEW_NATIVE_INVALID');
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});

test('D35T36 codex two distinct fully authenticated eligible predecessor lineages are ambiguous', () => {
  const r = d35t36Review();
  try {
    const duplicate = r.retain(r.f.input(r.firstBinding, 1, null, r.firstRaw));
    r.artifacts.sealJudgment(duplicate);
    assert.throws(() => r.next(2, { mutateAnswer(answer) {
      answer.review_completeness = 'incomplete'; answer.limitations = ['Controlled ambiguous origin refusal'];
    } }), error => error.code === 'REVIEW_NATIVE_INVALID' && /ambiguous/.test(error.message));
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});

test('D35T36 codex later same-head history cannot redirect an earlier frozen origin', () => {
  const r = d35t36Review();
  try {
    r.next(2); const third = r.next(3);
    const originalHead = r.f.git(['rev-parse', 'HEAD']);
    const graph = fs.readFileSync(path.join(r.f.graphDir, 'tickets.json'));
    const state = fs.readFileSync(path.join(r.f.graphDir, 'delivery-state.json'));
    const second = r.artifacts.priorCodeReviewVerdicts({ worktreePath: r.f.root,
      repository: r.targets.repositoryIdentity(r.f.root), phaseDir: r.f.phase })[1];
    r.f.git(['reset', '--hard', second.head]);
    const binding = r.targets.phaseBinding({ graph: r.f.graph, state: r.f.state, phase: 52,
      repository: r.targets.repositoryIdentity(r.f.root), pr: 52, head: second.head, base: r.f.base, branch: r.f.branch });
    const blank = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [] };
    const answer = { ...blank, findings: [{ ...r.firstRaw.findings[0], id: 'CR-later', line: 1, line_text: 'end();' }] };
    const input = r.f.input(binding, 2, r.first.result.head, blank);
    const carried = r.core.carryPriorFindings({ priorFindings: r.first.result,
      deltaDiff: r.f.git(['diff', '--unified=50', r.first.result.head, second.head]),
      readSource: file => fs.readFileSync(path.join(r.f.root, file), 'utf8'),
      disagreements: { [r.original.identity]: { reason: 'A different later operator reason', recorded_by: 'operator' } } });
    r.fixtures.setOriginalReview(input, answer, carried); r.retain(input);
    r.artifacts.sealJudgment(input);
    r.f.git(['reset', '--hard', originalHead]);
    fs.writeFileSync(path.join(r.f.graphDir, 'tickets.json'), graph); fs.writeFileSync(path.join(r.f.graphDir, 'delivery-state.json'), state);
    assert.equal(r.cold().current.dispatch_id, third.input.dispatchId);
    assert.equal(r.cold().current.disagreement_suppressed, 1); r.assertOriginals();
  } finally { r.f.cleanup(); }
});

for (const kind of ['native-answer-disagreement', 'normalized-substitution'])
test('D35T36 codex preserves completed-answer custody and complete-result equality: ' + kind, () => {
  const r = d35t36Review();
  try {
    assert.throws(() => r.next(2, kind === 'normalized-substitution' ? {
      mutateInput(input) { input.result.summary = 'Substituted after original native completion'; },
    } : { native: { mutateNative(rows) {
      if ('codex' === 'codex') {
        const final = rows.find(row => row.type === 'response_item' && row.payload?.role === 'assistant');
        const answer = JSON.parse(final.payload.content[0].text); answer.summary = 'Different original session answer';
        final.payload.content[0].text = JSON.stringify(answer);
      } else rows.find(row => row.type === 'assistant').message.content[0].input.summary = 'Different original session answer';
    } } }));
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});


test('D35T36 codex genuine same-text archive for a different finding cannot supply the original binding', () => {
  const r = d35t36Review('deletion', { lines: [2] });
  try {
    const history = r.artifacts.priorCodeReviewVerdicts({ worktreePath: r.f.root,
      repository: r.targets.repositoryIdentity(r.f.root), phaseDir: r.f.phase });
    assert.equal(history[0].answer_authenticated, true);
    assert.equal(history[0].findings[0].occurrence, 1);
    const fake = r.core.normalizeResult({ ...r.firstRaw, findings: [{ ...r.firstRaw.findings[0], line: 6 }] }, {
      round: 1, scope: 'full', readSource: file => fs.readFileSync(path.join(r.f.root, file), 'utf8'),
    });
    assert.equal(fake.findings[0].occurrence, 3);
    assert.throws(() => r.next(2, { predecessor: { ...r.first.result, findings: fake.findings } }),
      error => error.code === 'REVIEW_NATIVE_INVALID');
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});

for (const originScope of ['foreign-phase', 'foreign-pr'])
test('D35T36 codex a fully authenticated ' + originScope + ' archive cannot authorize this predecessor', () => {
  const r = d35t36Review('deletion', { originScope });
  try {
    const history = r.artifacts.priorCodeReviewVerdicts({ worktreePath: r.f.root,
      repository: r.targets.repositoryIdentity(r.f.root), phaseDir: originScope === 'foreign-phase' ? '53-foreign' : r.f.phase });
    assert.equal(history.length, 1); assert.equal(history[0].answer_authenticated, true);
    assert.throws(() => r.next(2, { mutateAnswer(answer) {
      answer.review_completeness = 'incomplete'; answer.limitations = ['Controlled foreign origin refusal'];
      Object.assign(answer, { origin_head: r.first.result.head, origin_dispatch: r.first.dispatchId,
        origin_artifact: r.firstSeal.artifact_ref });
    } }), error => error.code === 'REVIEW_NATIVE_INVALID');
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});

test('D35T36 codex a genuine foreign repository archive and request origin hints grant no lineage', () => {
  const foreign = d35t36Review();
  const r = d35t36Review('deletion', { unsealed: true });
  try {
    const history = foreign.artifacts.priorCodeReviewVerdicts({ worktreePath: foreign.f.root,
      repository: foreign.targets.repositoryIdentity(foreign.f.root), phaseDir: foreign.f.phase });
    assert.equal(history[0].answer_authenticated, true);
    assert.equal(foreign.original.identity, r.original.identity);
    assert.throws(() => r.next(2, { mutateAnswer(answer) {
      answer.review_completeness = 'incomplete'; answer.limitations = ['Controlled foreign repository refusal'];
    }, mutateInput(input) {
      Object.assign(input, { origin_head: foreign.first.result.head, origin_dispatch: foreign.first.dispatchId,
        origin_artifact: foreign.firstSeal.artifact_ref });
    } }), error => error.code === 'REVIEW_NATIVE_INVALID');
    assert.equal(r.cold().current, null); foreign.assertOriginals();
  } finally { r.f.cleanup(); foreign.f.cleanup(); }
});

test('D35T36 codex a valid original archive outside current source ancestry grants no lineage', () => {
  const r = d35t36Review();
  try {
    r.f.git(['reset', '--hard', r.f.base]);
    assert.throws(() => r.next(2, { mutateAnswer(answer) {
      answer.review_completeness = 'incomplete'; answer.limitations = ['Controlled unrelated ancestry refusal'];
    } }), error => error.code === 'REVIEW_NATIVE_INVALID' && /ancestry/.test(error.message));
    assert.equal(r.cold().current, null); r.assertOriginals();
  } finally { r.f.cleanup(); }
});
