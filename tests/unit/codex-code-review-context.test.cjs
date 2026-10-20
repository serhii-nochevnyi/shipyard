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

function dispatchFixture(f, value, mutate = () => {}, evidence = true, mutateEvidence = () => {}) {
  const boundaryModule = require(path.join(scripts, 'dispatch-boundary.cjs'));
  const recorder = boundaryModule.createDurableRecorder(path.join(f.storage, 'receipts-' + crypto.randomUUID()));
  const association = { ticket: value.prepared.ticket, phase: 38, worktree: f.root,
    dispatch_id: value.launch.dispatch_id };
  const binding = context.authenticateLaunch(value, context.admittedPrompt(value), association);
  const raw = { ...binding, ticket_set: value.prepared.binding.ticketSet, findings: [], dispositions: [],
    summary: 'Reviewed the complete phase change.', review_completeness: 'complete', limitations: [], unresolved_sources: [],
    evidence_markdown: 'Exact role-owned evidence.\n' };
  const input = context.admittedFileInput(value);
  if (input) raw.coverage = input.manifest.assets.filter(asset => asset.source_partition)
    .map(asset => ({ partition: asset.ordinal, status: 'reviewed' }));
  mutate(raw);
  if (evidence) write(f.root, '.shipyard-code-review-evidence.md', raw.evidence_markdown);
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
  const runtimeEvidence = { schema: 'shipyard.codex-runtime-evidence.v1', runtime: 'codex', provider: 'openai',
    session_id: session, worktree: f.root, ticket: value.prepared.ticket, phase: 38,
    ...(input ? { input_transport: 'host-files', input_bundle: input.input_bundle } : {}),
    code_review: binding, transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: hash(stream) } };
  mutateEvidence(runtimeEvidence);
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
  return { dispatch, recorder, raw, runtimeEvidence };
}

function review(f, mutate = () => {}) {
  const id = crypto.randomUUID();
  const value = f.prepare({ inflightDispatchId: id }, { dispatch_id: id });
  admit(f, value); context.recheckInstalledLaunch(value);
  const d = dispatchFixture(f, value, mutate);
  return { value, ...d, result: context.finish(value, d.dispatch, d.recorder) };
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
    assert.ok(packet.exact_diff.content.includes('src/reviewed.txt'));
    assert.ok(!packet.exact_diff.content.includes('.planning/'));
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
    assert.ok(v.prepared.packet.role_context.exact_diff.content.includes('@@'));
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

test('complete large input relays as code-review partitions with coverage and tamper checks', () => {
  const f = fixture();
  try {
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), ('large line ' + 'x'.repeat(240) + '\n').repeat(5000)));
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id });
    assert.equal(v.launch.context.input_transport, 'host-files');
    const before = context.admittedFileInput(v);
    assert.equal(before.manifest.binding.review_contract, partitions.CODE_REVIEW_CONTRACT);
    assert.ok(before.manifest.assets.some(a => a.source_partition));
    const material = partitions.verifyFileInput(before).material[0];
    const packets = require(path.join(scripts, 'context-packet.cjs'));
    const packet = packets.decodeUniqueContent(JSON.parse(material));
    assert.equal(Object.hasOwn(packet, 'digest'), false);
    assert.equal(hash(material), v.prepared.packet.digest);
    packets.validateContextPacket(packet, { role: 'code-review', subject: v.prepared.ticket,
      sourceRevision: v.prepared.canonical.head });
    admit(f, v); const input = context.admittedFileInput(v);
    for (const mutate of [r => { r.coverage.pop(); }, r => { r.coverage[0].status = 'not-reviewed'; }]) {
      const invalid = dispatchFixture(f, v, mutate);
      assert.throws(() => context.finish(v, invalid.dispatch, invalid.recorder), { code: 'INVALID_RESULT' });
    }
    const d = dispatchFixture(f, v);
    assert.equal(context.finish(v, d.dispatch, d.recorder).artifact.outcome, 'pass');
  } finally { f.cleanup(); }
});

test('tampered source partition refuses both launch recheck and finish before any archive is written', () => {
  const f = fixture();
  try {
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), ('x'.repeat(240) + '\n').repeat(5000)));
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    const d = dispatchFixture(f, v), input = context.admittedFileInput(v);
    const p = input.manifest.assets[1].path;
    fs.chmodSync(p, 0o600); fs.appendFileSync(p, 'x');
    assert.throws(() => context.recheckInstalledLaunch(v));
    assert.throws(() => context.finish(v, d.dispatch, d.recorder));
    assert.equal(artifact.authenticatedArchivePins(f.root).length, 0);
  } finally { f.cleanup(); }
});

test('complete material over the host per-launch ceiling refuses before admission', () => {
  const f = fixture();
  try {
    f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), ('x'.repeat(250) + '\n').repeat(40000)));
    assert.throws(() => f.prepare(), error => ['CONTEXT_PACKET_OVER_BOUND', 'CONTEXT_OVER_BOUND'].includes(error.code));
  } finally { f.cleanup(); }
});

test('generated instructions plus an inline prompt over the bound refuse admission', () => {
  const f = fixture();
  try {
    const v = f.prepare();
    assert.equal(context.admittedFileInput(v), null);
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

test('only the two admitted host bookkeeping files tolerate local mutation', () => {
  const f = fixture('bookkeeping', true);
  try {
    const id = crypto.randomUUID(), v = f.prepare({ inflightDispatchId: id }, { dispatch_id: id }); admit(f, v);
    write(f.root, '.planning/graph/dispatches.json', JSON.stringify({ inflight: { [id]: {
      ticket: v.prepared.ticket, role: 'code-review', host: 'codex', pid: process.pid } } }));
    const provenance = '.planning/graph/provenance/' + id + '.json';
    write(f.root, provenance, JSON.stringify({ dispatch_id: id, ticket: v.prepared.ticket, role: 'code-review' }));
    context.admitBookkeeping(v); context.recheckInstalledLaunch(v);
    const originalDigest = context.launchDigest(v);
    for (const name of ['.planning/graph/dispatches.json', provenance]) {
      const p = path.join(f.root, name), original = fs.readFileSync(p); fs.appendFileSync(p, ' ');
      assert.throws(() => context.recheckInstalledLaunch(v)); fs.writeFileSync(p, original);
    }
    assert.equal(context.launchDigest(v), originalDigest);
  } finally { f.cleanup(); }
});

function foreignFixture(partitioned = false) {
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
  if (partitioned) f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'),
    ('large line ' + 'x'.repeat(240) + '\n').repeat(5000)));
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

for (const partitioned of [false, true]) for (const incomplete of [false, true])
  test('configured foreign builder through seal and hold: partitions=' + partitioned + ', incomplete=' + incomplete, () => {
    const f = foreignFixture(partitioned);
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
      assert.equal(!!context.admittedFileInput(r.value), partitioned);
      if (partitioned) {
        const input = context.admittedFileInput(r.value);
        assert.deepEqual(input.manifest.snapshot.planning_reference, p.packet.role_context.planning_reference);
        assert.equal(input.manifest.snapshot.worktree, f.root);
        assert.equal(input.manifest.snapshot.repository, target.repositoryIdentity(f.root));
        partitions.verifyFileInput(input);
      }
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

for (const partitioned of [false, true]) for (const changed of ['graph', 'config', 'plan', 'source', 'head', 'base', 'root'])
  test('foreign launch and finish reject original identity drift: partitions=' + partitioned + ', ' + changed, () => {
    const f = foreignFixture(partitioned);
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

for (const partitioned of [false, true]) test('foreign current lookup refuses changed sealed planning bytes: partitions=' + partitioned, () => {
  const f = foreignFixture(partitioned);
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

test('foreign full and delta lineage retain original membership across coordinator graph evolution', () => {
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
