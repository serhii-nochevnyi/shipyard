'use strict';

const cases = [];
function test(name, callback) { cases.push([name, callback]); }
function registerCases(runner, registeredCases) {
  if (typeof runner !== 'function') throw new TypeError('test runner is required');
  let pending = Promise.resolve();
  for (const [name, callback] of registeredCases) runner(name, () => {
    const current = pending.then(callback);
    pending = current.catch(() => {});
    return current;
  });
}
function registerTests(runner) { registerCases(runner, cases); }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testAuthorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-authority-')));
const testAuthorityModule = path.join(testAuthorityHome, 'fixture.cjs');
fs.writeFileSync(testAuthorityModule, "require('node:os').homedir = () => " + JSON.stringify(testAuthorityHome) + ";\n");
const testAuthorityArgs = ['--require', testAuthorityModule];
const testOriginalHomedir = os.homedir;
os.homedir = () => testAuthorityHome;
process.on('exit', () => { os.homedir = testOriginalHomedir; fs.rmSync(testAuthorityHome, {recursive:true,force:true}); });
const { execFileSync } = require('node:child_process');

const targetBin = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-gh-'));
fs.writeFileSync(path.join(targetBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const git = args => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write('main');
else if (args[0] === 'pr' && args[1] === 'view') {
  let base = 'main';
  try { base = JSON.parse(fs.readFileSync('.planning/config.json')).git?.base_branch || base; } catch {}
  let oid; try { oid = git(['rev-parse','refs/remotes/origin/' + base]); } catch { oid = git(['rev-parse','HEAD']); }
  process.stdout.write(JSON.stringify({number:Number(args[2]),state:'OPEN',headRefName:git(['branch','--show-current']),
    headRefOid:git(['rev-parse','HEAD']),baseRefName:base,baseRefOid:oid}));
} else process.exit(2);
`, {mode:0o755});
const targetOldPath = process.env.PATH;
process.env.PATH = targetBin + path.delimiter + targetOldPath;
process.on('exit', () => { process.env.PATH = targetOldPath; fs.rmSync(targetBin, {recursive:true,force:true}); });
const contextBuilder = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
const { TICKET, BRANCH, ADR, git, write, fixture, planPath, prepared, unitJudgment, cleanupJudgment } = require('./helpers/codex-arch-review-fixtures.cjs');


test('focused selector includes uncited governing modules and companions, excluding unrelated bodies', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'focused-selection-')));
  try {
    write(root, '.planning/architecture/ADR-101-governing.md', '# ADR-101\nGoverns `src/payments/`.\n');
    write(root, '.planning/architecture/ADR-101-INTERFACES.md', '# Contract\nPayment interface.\n');
    write(root, '.planning/architecture/ADR-102-unrelated.md', '# ADR-102\nUnrelated domain.\n');
    const selected = contextBuilder.selectFocusedArchitecture({ root, changedPaths: ['src/payments/api.cjs'] });
    assert.deepEqual(selected.refs.map(ref => ref.path), [
      '.planning/architecture/ADR-101-INTERFACES.md', '.planning/architecture/ADR-101-governing.md']);
    assert.equal(selected.inventory.find(ref => ref.path.includes('102')).selected, false);
    assert.ok(selected.inventory.every(ref => /^[a-f0-9]{64}$/.test(ref.sha256) && ref.reasons.length));
    assert.throws(() => contextBuilder.selectFocusedArchitecture({ root, changedPaths: [],
      plans: [{ content: 'ADR-999' }] }), /required architecture record is missing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('focused change inventory preserves binary, deletion and exact rename paths', () => {
  const inventory = contextBuilder.focusedChangeInventory(
    'R100\0src/old name.cjs\0src/new\nname.cjs\0D\0config/old.json\0A\0assets/logo.bin\0',
    '0\t0\t\0src/old name.cjs\0src/new\nname.cjs\0' + '5\t0\tconfig/old.json\0-\t-\tassets/logo.bin\0');
  assert.equal(inventory[0].old_path, 'src/old name.cjs');
  assert.equal(inventory[0].new_path, 'src/new\nname.cjs');
  assert.equal(inventory[1].new_path, null);
  assert.equal(inventory[2].binary, true);
  assert.equal(inventory[2].old_path, null);
  assert.throws(() => contextBuilder.focusedChangeInventory('M\0src/missing.cjs\0', ''), /lacks statistics/);
});

test('Codex arch-review builds and binds a complete graph- and PR-authenticated packet', () => {
  const f = fixture();
  try {
    const scope = { ticket: TICKET, phase: 38, worktree: f.root };
    const launch = { role: 'arch-review', context: {}, signals: {} };
    const result = contextBuilder.prepare(scope, launch, {
      refreshGit: false, graphDir: path.join(f.root, '.planning/graph'),
      listPullRequests: ({ branch, state }) => state === 'open' && branch === BRANCH ? [f.pr] : [],
      getPullRequest: ({ pr }) => pr === f.pr.number ? f.pr : null,
    });

    assert.equal(contextBuilder.isPreparedContext(result), true);
    assert.equal(result.prepared.ticket, TICKET);
    assert.equal(result.evidence.pr, f.pr.number);
    assert.equal(result.evidence.head, f.head);
    assert.ok(result.evidence.packet_bytes > 0);
    assert.equal(result.evidence.input_tokens, result.launch.signals.inputTokens);
    assert.ok(result.prepared.diffBytes > 0);
    assert.equal(result.evidence.input_tokens,
      Math.ceil((Buffer.byteLength(result.launch.context.prompt, 'utf8') + result.prepared.diffBytes) / 4),
      'routing counts the diff the reviewer reads through git');
    assert.ok(result.evidence.input_tokens > 0);
    assert.deepEqual(result.launch.signals, {
      risk: 'high', critical: false, checkpoint: true, contested: true,
      inputTokens: result.evidence.input_tokens,
    });
    assert.doesNotMatch(result.launch.context.prompt, /reviewed implementation change/, 'the diff is not in the prompt');
    assert.equal(result.prepared.packet.diff.content, undefined);
    assert.ok(result.launch.context.prompt.includes('"new_path":"src/reviewed.txt"'), 'the changed-path inventory is in the packet');
    assert.ok(result.launch.context.prompt.includes('git diff ' + result.prepared.packet.diff.merge_base + '...' + f.head + ' -- <path>'),
      'the prompt tells the reviewer to read git');
    assert.match(result.launch.context.prompt, /The judge must review the exact live PR diff and this decision/);
    assert.equal(result.prepared.packet.review_contract, contextBuilder.FOCUSED_CONTRACT);
    assert(!result.evidence.selected_refs.some((ref) => ref.path === planPath()));
    assert(result.evidence.selected_refs.some((ref) => ref.path === '.planning/architecture/ADR-014-host-bound-review.md'));
    assert.equal(Object.isFrozen(result.prepared), true);
    assert.equal(Object.isFrozen(result.prepared.packet.required_refs[0]), true);
    assert.equal(contextBuilder.isPreparedContext({ ...result }), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});


test('architecture collector retains every duplicate governing obligation', () => {
  const f = fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unique-reader-')));
  const api = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  try {
    const originalPath = '.planning/architecture/ADR-014-host-bound-review.md';
    const duplicatePath = '.planning/architecture/ADR-015-duplicate-governing.md';
    write(f.root, duplicatePath, fs.readFileSync(path.join(f.root, originalPath), 'utf8'));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: duplicate governing source']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    const result = prepared(f);
    const encoded = api.encodeUniqueContent(result.prepared.packet);
    const original = result.prepared.packet.refs.find(ref => ref.path === originalPath);
    const duplicate = result.prepared.packet.refs.find(ref => ref.path === duplicatePath);
    assert.equal(original.content, duplicate.content);
    assert.equal(encoded.dictionary.filter(entry => entry.sha256 === original.sha256).length, 1);
    assert.equal(encoded.obligations.filter(ref => ref.content_sha256 === original.sha256).length, 2);
    assert.equal(fs.readFileSync(path.join(f.root, originalPath), 'utf8'), original.content);
    const broken = JSON.parse(JSON.stringify(encoded)); broken.obligations.pop();
    assert.throws(() => api.decodeUniqueContent(broken));
  } finally { cleanupJudgment(f); fs.rmSync(storage, { recursive: true, force: true }); }
});

test('Codex arch-review refuses caller prompts and caller-selected signals', () => {
  const f = fixture();
  try {
    const scope = { ticket: TICKET, phase: 38, worktree: f.root };
    const options = {
      refreshGit: false, graphDir: path.join(f.root, '.planning/graph'),
      listPullRequests: () => [f.pr],
      getPullRequest: () => f.pr,
    };
    assert.throws(() => contextBuilder.prepare(scope, {
      role: 'arch-review', context: { prompt: 'Use my conclusions.' }, signals: {},
    }, options), /caller-supplied prompts or selectors are refused/);
    assert.throws(() => contextBuilder.prepare(scope, {
      role: 'arch-review', context: {}, signals: { risk: 'low' },
    }, options), /signals are host-derived/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});


test('architecture judgment admits an OPEN draft before undraft', () => {
  const f = fixture();
  try { f.pr.isDraft = true; assert.equal(prepared(f).prepared.draft, true); }
  finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const [name, edit] of [
  ['wrong head', f => { f.pr.headRefOid = 'f'.repeat(40); }],
  ['wrong branch', f => { f.pr.headRefName = 'other'; }],
  ['wrong PR number', f => { f.pr.number = 302; }],
  ['closed PR', f => { f.pr.state = 'CLOSED'; }],
  ['unknown draft state', f => { delete f.pr.isDraft; }],
  ['wrong base commit', f => { f.pr.baseRefOid = 'f'.repeat(40); }],
  ['unsafe base name', f => { f.pr.baseRefName = '../main'; }],
]) test('architecture preparation refuses ' + name, () => {
  const f = fixture();
  try { edit(f); assert.throws(() => prepared(f), /identity|base/); }
  finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('canonical plan is read from a different managed worktree of the same repository', () => {
  const f = fixture();
  const review = f.root + '-review';
  try {
    git(f.root, ['switch', 'main']);
    git(f.root, ['worktree', 'add', review, BRANCH]);
    f.reviewRoot = fs.realpathSync(review);
    fs.rmSync(path.join(review, planPath()));
    git(review, ['add', '.']);
    git(review, ['commit', '-m', 'fixture: ticket checkout omits canonical plan']);
    f.pr.headRefOid = git(review, ['rev-parse', 'HEAD']);
    const result = prepared(f);
    assert(result.launch.context.prompt.includes('Review the authenticated PR diff against ADR-014'));
    assert.equal(result.prepared.canonical.worktree, f.reviewRoot);
  } finally {
    try { git(f.root, ['worktree', 'remove', '--force', review]); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('an unrelated repository cannot supply the canonical graph', () => {
  const f = fixture(), other = fixture();
  try { assert.throws(() => prepared(f, { graphDir: path.join(other.root, '.planning/graph') }),
    /another repository/); }
  finally { for (const x of [f, other]) fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('missing mandatory architecture context and symlink substitution refuse', () => {
  const f = fixture();
  const adr = path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md');
  try {
    fs.renameSync(adr, adr + '.saved');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: missing ADR']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /architecture record is missing/);
    fs.symlinkSync(adr + '.saved', adr);
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: symlink ADR']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /symlink/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('collector bounds the complete input instead of silently truncating it', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', 'x'.repeat(16 * 1024 * 1024 + 1));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: oversized ADR']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /exceeds its bound/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('result consumer rejects fabricated receipt authority and cloned preparation objects', () => {
  const f = fixture();
  try {
    const value = prepared(f);
    assert.throws(() => contextBuilder.finish(value, {
      dispatch_id: 'forged', ticket: TICKET, role: 'arch-review', receipt: { compliance: 'verified' },
    }, { getVerifiedRecord: () => null }), /authenticated durable receipt/);
    assert.throws(() => contextBuilder.finish({ ...value }, {}, {}), /host-prepared/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});


test('document-relative decision links are collected completely and missing authority refuses', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/investigations/INV-014/DECISIONS.md', 'Complete linked decision.');
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR
      + '[Decision](../investigations/INV-014/DECISIONS.md)\n');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: link decision']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert(prepared(f).prepared.packet.refs.some(ref => ref.content === 'Complete linked decision.'));
    fs.unlinkSync(path.join(f.root, '.planning/investigations/INV-014/DECISIONS.md'));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: remove linked decision']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /ENOENT|missing/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

function canonicalReviewMember(f, aggregate = false) {
  const ticket = 'T-38-01';
  const branch = 'ticket/' + ticket;
  const graphPath = '.planning/graph/tickets.json';
  const statePath = '.planning/graph/delivery-state.json';
  const graph = JSON.parse(fs.readFileSync(path.join(f.root, graphPath)));
  const state = JSON.parse(fs.readFileSync(path.join(f.root, statePath)));
  graph.tickets[ticket] = { ...graph.tickets[TICKET], id: ticket, branch };
  delete graph.tickets[TICKET];
  state[ticket] = state[TICKET]; delete state[TICKET];
  if (aggregate) {
    graph.tickets[ticket].epic = 'epic/38-codex-arch-review';
    graph.tickets['T-38-02'] = { ...graph.tickets[ticket], id: 'T-38-02',
      plan: '.planning/phases/38-codex-arch-review/38-02-PLAN.md', branch: 'ticket/T-38-02-corrective',
      depends_on: [ticket] };
    write(f.root, graph.tickets['T-38-02'].plan, '# Corrective member\nADR-014\n');
  }
  write(f.root, graphPath, JSON.stringify(graph));
  write(f.root, statePath, JSON.stringify(state));
  git(f.root, ['branch', '-m', branch]);
  git(f.root, ['add', '.planning']); git(f.root, ['commit', '-m', 'fixture: canonical original review member']);
  f.ticket = ticket; f.head = git(f.root, ['rev-parse', 'HEAD']);
  Object.assign(f.pr, { headRefName: branch, headRefOid: f.head,
    title: 'feat(' + ticket + '): change reviewed source', body: 'Implements ' + ticket + '.' });
  return ticket;
}

for (const scenario of [
  { productBytes: 0, name: 'small packet' },
  { productBytes: 2600000, name: 'large diff stays out of the packet' },
]) test('fixture: public Codex host seals and consumes a complete aggregate phase architecture verdict (' + scenario.name + ')', async () => {
  const { productBytes = 0 } = scenario;
  const f = fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-architecture-host-')));
  try {
    const member = productBytes ? canonicalReviewMember(f, true) : TICKET;
    const originalTicketReview = await unitJudgment(f);
    assert.equal(originalTicketReview.result.subject, member);
    assert.equal(originalTicketReview.result.receipt.runtime_evidence.ticket, member);
    const graphDir = path.join(f.root, '.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
    graph.tickets[member].epic = 'epic/38-codex-arch-review';
    if (productBytes) assert.deepEqual(Object.keys(graph.tickets).sort(), [member, 'T-38-02']);
    write(f.root, '.planning/graph/tickets.json', JSON.stringify(graph));
    write(f.root, '.planning/phases/38-codex-arch-review/SUMMARY.md', 'Original native obligations remain HOLD.');
    git(f.root, ['switch', '-c', graph.tickets[member].epic]);
    if (productBytes) {
      write(f.root, 'complete-product.txt', 'COMPLETE PRODUCT HUNK\n'.repeat(Math.ceil(productBytes / 21)));
      git(f.root, ['add', 'complete-product.txt']);
    }
    git(f.root, ['add', '.planning']); git(f.root, ['commit', '-m', 'fixture: aggregate evidence']);
    f.head = git(f.root, ['rev-parse', 'HEAD']);
    f.pr.headRefName = graph.tickets[member].epic; f.pr.headRefOid = f.head;
    const request = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs').build(
      ['arch-review', '38-codex-arch-review', '--phase', '38', '--pr', String(f.pr.number), '--runtime', 'codex'],
      { cwd: f.root, graphDir });
    const requestPath = path.join(storage, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify(request));
    const hostModule = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const parsed = hostModule.readRequestFile(requestPath);
    const options = { graphDir, refreshGit: false, getPullRequest: () => f.pr };
    let value;
    assert.doesNotThrow(() => { value = contextBuilder.prepare(parsed.scope, parsed.launch, options); });
    const originalPacket = JSON.stringify(value.prepared.packet);
    if (productBytes) {
      assert.ok(!value.launch.context.prompt.includes('COMPLETE PRODUCT HUNK'), 'the diff is read through git, not embedded');
      assert.equal(value.prepared.packet.diff.content, undefined);
      assert.deepEqual(value.prepared.binding.ticketSet.map(record => record.id), [member, 'T-38-02']);
    }
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'arch-review', signals: value.launch.signals });
    const agentDir = path.join(storage, 'native-home', 'agents'); fs.mkdirSync(agentDir, { recursive: true });
    const text = ['# shipyard-policy-id = "' + policy.POLICY.id + '"',
      '# shipyard-policy-version = "' + selected.policy_version + '"',
      '# shipyard-policy-hash = "' + selected.policy_hash + '"',
      '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "arch-review"',
      '# shipyard-policy-rung = "' + selected.rung + '"',
      'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"',
      'model = "' + selected.model + '"', 'model_reasoning_effort = "' + selected.effort + '"',
      'sandbox_mode = "read-only"', "developer_instructions = '''", 'Judge the complete authenticated phase.', "'''", ''].join('\n');
    const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
    fs.writeFileSync(path.join(agentDir, selected.agent_file), text);
    const agentManifest = path.join(agentDir, '.shipyard-manifest.json');
    fs.writeFileSync(agentManifest, JSON.stringify({ policy_id: policy.POLICY.id,
      policy_version: selected.policy_version, policy_hash: selected.policy_hash,
      agent_files: [selected.agent_file], agent_digests: { [selected.agent_file]: digest(text) } }));
    const capabilities = { supportedModels: [selected.model], supportedEfforts: [selected.effort] };
    const recorder = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs').createDurableRecorder(path.join(storage, 'receipts'));
    let host = { scope: parsed.scope, capabilities, recorder,
      launchStatic(selection, context) {
        const session = require('node:crypto').randomUUID();
        const judgment = { id: request.scope.ticket, pr: f.pr.number, head: f.head,
          base_tree: value.prepared.mergeBaseTree, verdict: 'conform', summary: 'Unit aggregate judgment.',
          findings: [], blocking_count: 0, ticket_set: value.prepared.binding.ticketSet,
          ticket_set_digest: value.prepared.binding.membership, context_digest: value.prepared.packet.digest,
          launch_digest: context.prompt.match(/launch_digest=([a-f0-9]{64})/)[1], evidence_markdown: 'Complete unit aggregate review.' };
        const records = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        const streamRecords = ['thread.started', 'turn.started', 'item.completed', 'turn.completed'].map(type => structuredClone(records.find(record => record.type === type)));
        streamRecords[0].thread_id = session; streamRecords[2].item.text = JSON.stringify(judgment);
        const stream = streamRecords.map(record => JSON.stringify(record)).join('\n') + '\n';
        const transcript = path.join(storage, 'transcript.jsonl'); fs.writeFileSync(transcript, stream);
        return { launch_id: 'codex-' + session, applied_model: selection.model, applied_effort: selection.reasoning_effort,
          observed_model: selection.model, observed_effort: selection.reasoning_effort, agent_file_digest: selection.agent_file_digest,
          runtime_evidence: { schema: 'shipyard.codex-runtime-evidence.v1', version: 1, runtime: 'codex', provider: 'openai',
            session_id: session, worktree: f.root, ticket: request.scope.ticket, phase: 38,
            transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: digest(stream) } } };
      } };
    host = aggregateRuntimeFixture({ host, parsed, storage, capabilities, recorder, selected, text, agentDir, agentManifest,
      inspect(envelope) {
        assert.equal(envelope.schema, 'shipyard.semantic-content.v1');
        const content = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
        assert.deepEqual(envelope, JSON.parse(JSON.stringify(content.encodeUniqueContent(value.prepared.packet))));
        const packet = content.decodeUniqueContent(envelope);
        const expectedPacket = content.decodeUniqueContent(content.encodeUniqueContent(value.prepared.packet));
        assert.equal(packet.diff.content, undefined);
        assert.deepEqual(packet.ticket_set, value.prepared.packet.ticket_set);
        assert.equal(packet.ticket_set.length, productBytes ? 2 : 1);
        assert.deepEqual(packet.acceptance.map(item => item.path),
          value.prepared.rows.map(item => item.row.plan));
        assert.ok(packet.refs.some(ref => ref.path.endsWith('ADR-014-host-bound-review.md')));
        assert.deepEqual(packet.refs, expectedPacket.refs);
      } });
    let output = '';
    await hostModule.runCli(['--args-file', requestPath], { write: text => { output += text; } },
      { ...options, host, capabilities, recorder, agentDir, agentManifest, storageRoot: storage });
    const result = JSON.parse(output);
    assert.equal(result.subject, request.scope.ticket);
    assert.notEqual(result.receipt.dispatch_id, originalTicketReview.result.receipt.dispatch_id);
    assert.equal(result.receipt.runtime_evidence.focused_review.review_contract, contextBuilder.FOCUSED_CONTRACT);
    assert.equal(result.result.review_completeness, 'complete');
    assert.equal(result.receipt.runtime_evidence.input_consumption, undefined);
    assert.equal(result.receipt.runtime_evidence.completed_source, undefined);
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const current = { worktreePath: f.root, pr: f.pr.number, head: f.head, headBranch: f.pr.headRefName,
      baseName: 'main', baseCommit: f.base, graphDir };
    assert.equal(artifacts.currentArchitectureVerdict(current).subject, request.scope.ticket);

    assert.equal(artifacts.currentArchitectureVerdict({ ...current, head: 'f'.repeat(40) }), null);
    fs.appendFileSync(path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md'), '\nChanged governing decision.');
    assert.equal(artifacts.currentArchitectureVerdict(current), null);
  } finally {
    cleanupJudgment(f); fs.rmSync(storage, { recursive: true, force: true });
  }
});


module.exports = { fixture, unitJudgment, cleanupJudgment, registerTests, registerCases, testAuthorityArgs,
  canonicalReviewMember, aggregateRuntimeFixture };

test('large complete architecture context is included once within final prompt capacity', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR + 'a'.repeat(400000));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: final prompt capacity']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    const result = prepared(f);
    assert(result.launch.context.prompt.includes('a'.repeat(400000)));
    assert(Buffer.byteLength(result.launch.context.prompt) < 1024 * 1024);
    assert(result.prepared.packet.required_refs.every(ref => ref.content === undefined));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a supporting ADR sidecar cannot replace the required primary architecture decision', () => {
  const f = fixture();
  try {
    fs.renameSync(path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md'),
      path.join(f.root, '.planning/architecture/ADR-014-DATA-MODEL.md'));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: sidecar only']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /required architecture record is missing/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('missing reference-style decision authority refuses', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR
      + '[Decision][decision]\n[decision]: ../investigations/INV-MISSING/DECISIONS.md\n');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: missing reference decision']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /ENOENT|missing/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('transitive linked decisions are required, complete and traversed once', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR
      + '[Decision](../investigations/INV-A/DECISIONS.md)\n');
    write(f.root, '.planning/investigations/INV-A/DECISIONS.md', '[Next](../INV-B/DECISIONS.md)');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: missing transitive decision']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /ENOENT|missing/);
    write(f.root, '.planning/investigations/INV-B/DECISIONS.md', '[Back](../INV-A/DECISIONS.md)');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: complete decision closure']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    const refs = prepared(f).prepared.packet.required_refs.filter(ref => ref.path.endsWith('/DECISIONS.md'));
    assert.equal(refs.length, 2); assert.equal(new Set(refs.map(ref => ref.path)).size, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('nested architecture records participate in complete corpus identity', () => {
  const f = fixture();
  try {
    const original = prepared(f).prepared.packet.digest;
    write(f.root, '.planning/architecture/product/ADR-099-required.md', 'Required nested decision.');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: nested architecture']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    const next = prepared(f);
    assert.notEqual(next.prepared.packet.digest, original);
    assert(next.prepared.packet.required_refs.some(ref => ref.path.endsWith('product/ADR-099-required.md')));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('named review checkpoint remains an escalation signal', () => {
  const f = fixture();
  try {
    const name = path.join(f.root, '.planning/graph/tickets.json');
    const graph = JSON.parse(fs.readFileSync(name)); graph.tickets[TICKET].human_checkpoint = 'review';
    fs.writeFileSync(name, JSON.stringify(graph));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: named review checkpoint']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.equal(prepared(f).launch.signals.checkpoint, true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a result after the terminal native completion cannot authorize judgment', async () => {
  const f = fixture(); f.resultAfterCompletion = true;
  try { await assert.rejects(() => unitJudgment(f), /CLI final is outside its unique completed turn/); }
  finally { cleanupJudgment(f); }
});

test('generated installed instructions are included in prelaunch capacity admission', async () => {
  const f = fixture(); f.additionalInstructions = 'a'.repeat(1024 * 1024);
  try { await assert.rejects(() => unitJudgment(f), /exceeds its bound|exceed the launch bound/); }
  finally { cleanupJudgment(f); }
});

test('evidence replacement between result validation and sealing refuses before archival', async () => {
  const f = fixture(); const original = fs.readSync; const originalOpen = fs.openSync; let descriptor; let changed = false;
  try {
    await assert.rejects(() => unitJudgment(f, () => {
      fs.openSync = function(file, ...args) { const fd = originalOpen.call(fs, file, ...args); if (String(file) === path.join(f.root, '.shipyard-arch-review-evidence.md')) descriptor = fd; return fd; };
      fs.readSync = function(fd, ...args) {
        const bytes = original.call(fs, fd, ...args);
        if (!changed && fd === descriptor) { changed = true; fs.writeFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'), 'Unauthenticated replacement evidence.'); }
        return bytes;
      };
    }), /evidence changed before authenticated archival|changed while|grew beyond|changed before|changed during bounded reading/);
    assert(changed);
    const archive = path.join(f.root, '.shipyard-role-artifacts');
    function manifests(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? manifests(path.join(root, entry.name)) : [path.join(root, entry.name)]); }
    if (fs.existsSync(archive)) assert(!manifests(archive).some(file => file.endsWith('manifest.json')));
  } finally { fs.readSync = original; fs.openSync = originalOpen; cleanupJudgment(f); }
});

test('a reviewer-created evidence file is refused before sealing', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => unitJudgment(f, () => write(f.root, '.shipyard-arch-review-evidence.md', 'role wrote this')),
      { code: 'WORKTREE_MUTATED' });
    assert.deepEqual(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').authenticatedArchivePins(f.root), []);
  } finally { cleanupJudgment(f); }
});

test('unit adapter judgment seals through the actual authenticated recorder and artifact consumer', async () => {
  const f = fixture();
  try {
    const { result, recorder } = await unitJudgment(f);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.artifact.outcome, 'conform');
    assert.equal(result.result.findings.length, 0);
    assert(recorder.getVerifiedRecord(result.receipt.dispatch_id));
    assert(fs.readFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'), 'utf8')
      .includes('Complete evidence from the unit adapter.'));
  } finally { cleanupJudgment(f); }
});

for (const [name, mutate] of [
  ['live head', f => { f.pr.headRefOid = 'f'.repeat(40); }],
  ['live base', f => { f.pr.baseRefOid = 'f'.repeat(40); }],
  ['draft state', f => { f.pr.isDraft = !f.pr.isDraft; }],
  ['review decision', f => { f.pr.reviewDecision = 'APPROVED'; }],
  ['architecture source', f => { fs.appendFileSync(path.join(f.root,
    '.planning/architecture/ADR-014-host-bound-review.md'), 'Changed after launch.'); }],
  ['new architecture record', f => { write(f.root, '.planning/architecture/ADR-099-new.md', 'New decision.'); }],
  ['missing complete evidence', f => { fs.unlinkSync(path.join(f.root, '.shipyard-arch-review-evidence.md')); }],
  ['contradictory complete evidence', f => { write(f.root, '.shipyard-arch-review-evidence.md', 'Other findings.'); }],
  ['unrelated dispatch bookkeeping', f => {
    const name = path.join(f.root, '.planning/graph/dispatches.json');
    const store = JSON.parse(fs.readFileSync(name)); store.unrelated_tamper = true;
    fs.writeFileSync(name, JSON.stringify(store));
  }],
  ['dispatch provenance', f => {
    const root = path.join(f.root, '.planning/graph/provenance');
    const name = path.join(root, fs.readdirSync(root)[0]);
    const provenance = JSON.parse(fs.readFileSync(name)); provenance.plugin_revision = 'changed';
    fs.writeFileSync(name, JSON.stringify(provenance));
  }],
]) test('authenticated result consumer rejects changed ' + name, async () => {
  const f = fixture();
  try { await assert.rejects(() => unitJudgment(f, mutate), /identity|base|changed|local changes|evidence/); }
  finally { cleanupJudgment(f); }
});

test('receipt-bound result consumption rejects a changed transcript and substituted runtime evidence', async () => {
  const f = fixture();
  try {
    const { result, value, recorder, transcript } = await unitJudgment(f);
    const dispatch = result.dispatch;
    fs.appendFileSync(transcript, '{}\n');
    assert.throws(() => contextBuilder.finish(value, dispatch, recorder), /recorded bounded file|changed/);
    const substituted = { ...dispatch, application_evidence: { ...dispatch.application_evidence,
      runtime_evidence: { ...dispatch.application_evidence.runtime_evidence, session_id: 'forged' } } };
    assert.throws(() => contextBuilder.finish(value, substituted, recorder), /authenticated durable receipt/);
  } finally { cleanupJudgment(f); }
});

test('PR review decisions are typed and every supported value changes authenticated identity', () => {
  const f = fixture();
  try {
    const scope = { ticket: TICKET, phase: 38, worktree: f.root };
    const options = { refreshGit: false, getPullRequest: () => f.pr };
    const digests = new Set();
    for (const decision of ['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']) {
      f.pr.reviewDecision = decision;
      const value = contextBuilder.prepare(scope, { role: 'arch-review' }, options);
      assert.equal(value.prepared.packet.pr.review_decision, decision);
      assert.equal(value.launch.signals.contested, decision === 'CHANGES_REQUESTED');
      digests.add(value.prepared.packet.digest);
    }
    assert.equal(digests.size, 4);
    for (const invalid of [undefined, null, {}, [], true, 'UNKNOWN']) {
      f.pr.reviewDecision = invalid;
      assert.throws(() => contextBuilder.prepare(scope, { role: 'arch-review' }, options), /live PR identity/);
    }
  } finally { cleanupJudgment(f); }
});

test('fresh process rejects review decision drift after artifact sealing', async () => {
  const f = fixture();
  try {
    const { result, validationInput } = await unitJudgment(f);
    f.pr.reviewDecision = 'APPROVED';
    const input = { ...validationInput, recorder: undefined, io: undefined,
      boundaryStore: path.join(f.storage, 'receipts') };
    const consumer = `const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      input.validation.io = { execFileSync(exe, args, options) {
        if (exe === 'gh') return JSON.stringify(input.pr);
        if (exe === 'git' && args.includes('fetch')) return '';
        return execFileSync(exe, args, options);
      } };
      require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))})
        .validateJudgmentManifest(input.validation);`;
    assert.throws(() => execFileSync(process.execPath, [...testAuthorityArgs, '-e', consumer], {
      input: JSON.stringify({ validation: input, pr: f.pr }), encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }), /sealed architecture context changed/);
    assert.equal(result.artifact.outcome, 'conform');
  } finally { cleanupJudgment(f); }
});

test('the sealed host context must reproduce the launch attestation of the original receipt', async () => {
  const f = fixture();
  try {
    const { result, validationInput } = await unitJudgment(f);
    const validated = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').validateJudgmentManifest(validationInput);
    const input = { receipt: result.receipt, dispatchId: result.receipt.dispatch_id,
      evidence: Buffer.from(validated.evidence), worktree: f.root };
    const sealed = validated.findings, context = sealed.host_context;
    assert.equal(contextBuilder.validateHistoricalContext({ ...input, result: sealed }), true);
    for (const edit of [{ graph_dir: path.join(f.root, 'elsewhere') }, { bookkeeping: [] },
      { historical_archives: [{ path: 'forged', sha256: 'a'.repeat(64), bytes: 1 }] },
      { historical_bookkeeping: [{ path: 'forged', sha256: 'a'.repeat(64) }] },
      { installation: { ...context.installation, script_root: path.join(f.root, 'elsewhere') } }])
      assert.throws(() => contextBuilder.validateHistoricalContext({ ...input,
        result: { ...sealed, host_context: { ...context, ...edit } } }), { code: 'STALE_CONTEXT' }, Object.keys(edit)[0]);
    const { focused, ...unfocused } = context;
    assert.throws(() => contextBuilder.validateHistoricalContext({ ...input, result: { ...sealed, host_context: unfocused } }),
      { code: 'ARCH_REVIEW_CONTEXT_REQUIRED' });
  } finally { cleanupJudgment(f); }
});

test('fixture-only import does not load or register a node test suite', () => {
  const modulePath = path.join(__dirname, 'helpers/codex-arch-review-fixtures.cjs');
  const script = `const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'node:test') throw new Error('implicit node:test registration');
      return load.call(this, id, ...args);
    };
    const imported = require(${JSON.stringify(modulePath)});
    if (typeof imported.fixture !== 'function' || imported.registerTests !== undefined) process.exit(2);`;
  execFileSync(process.execPath, [...testAuthorityArgs, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
});


for (const dependency of ['plan-delivery.cjs', 'conveyor-scratch.cjs']) {
  for (const stage of ['launch', 'consumer', 'missing-pin']) test(
    `installed ${dependency} is mandatory and authenticated at ${stage}`, () => {
      const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-context-install-'));
      try {
        const plugin = path.resolve(__dirname, '../../plugins/delivery-pipeline');
        fs.cpSync(plugin, path.join(installed, 'plugins/delivery-pipeline'), { recursive: true });
        const tests = path.join(installed, 'tests/unit');
        fs.mkdirSync(tests, { recursive: true });
        fs.copyFileSync(__filename, path.join(tests, path.basename(__filename)));
        fs.mkdirSync(path.join(tests, 'helpers'), { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'helpers/codex-arch-review-fixtures.cjs'), path.join(tests, 'helpers/codex-arch-review-fixtures.cjs'));
        fs.mkdirSync(path.join(installed, 'tests/fixtures/captured'), { recursive: true });
        fs.copyFileSync(path.resolve(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'),
          path.join(installed, 'tests/fixtures/captured/codex-agent-stream-exec.jsonl'));
        for (const name of ['codex-agent-stream-parent.jsonl', 'codex-agent-stream-child.jsonl'])
          fs.copyFileSync(path.resolve(__dirname, '../fixtures/captured', name),
            path.join(installed, 'tests/fixtures/captured', name));
        const script = `const fs = require('node:fs'); const path = require('node:path');
          const assert = require('node:assert/strict');
          const { execFileSync } = require('node:child_process');
          const suite = require('./tests/unit/codex-arch-review-context.test.cjs');
          const testAuthorityArgs = suite.testAuthorityArgs;
          const dependency = ${JSON.stringify(dependency)}, stage = ${JSON.stringify(stage)};
          const f = suite.fixture();
          const helper = path.resolve('plugins/delivery-pipeline/scripts', dependency);
          (async () => { try {
            if (stage === 'launch') {
              await assert.rejects(() => suite.unitJudgment(f, () => fs.appendFileSync(helper, '\\n// changed installed authority\\n')),
                /installed launch source changed|installed source or instructions changed/);
            } else {
              const completed = await suite.unitJudgment(f);
              const manifest = JSON.parse(fs.readFileSync(completed.result.artifact.ref));
              const result = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
              const pins = result.host_context.installation.files;
              assert(pins.some(pin => pin.path === dependency));
              if (stage === 'consumer') fs.appendFileSync(helper, '\\n// changed installed authority\\n');
              else result.host_context.installation.files = pins.filter(pin => pin.path !== dependency);
              const input = { result, receipt: completed.result.receipt,
                dispatchId: completed.result.receipt.dispatch_id, worktree: f.root,
                ticket: completed.result.subject, pr: f.pr.number,
                evidence: fs.readFileSync(path.join(f.root, manifest.files.evidence.path)).toString('base64') };
              const consumer = "const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(0, 'utf8')); "
                + "input.evidence = Buffer.from(input.evidence, 'base64'); "
                + "require('./plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs').validateSealedContext(input);";
              assert.throws(() => execFileSync(process.execPath, [...testAuthorityArgs, '-e', consumer], {
                input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }),
                stage === 'consumer' ? /installed architecture source changed/ : /required installed source pin is missing/);
            }
          } finally { suite.cleanupJudgment(f); } })().catch(error => { console.error(error); process.exitCode = 1; });`;
        execFileSync(process.execPath, [...testAuthorityArgs, '-e', script], { cwd: installed, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      } finally { fs.rmSync(installed, { recursive: true, force: true }); }
    });
}

function committedBoardFixture() {
  const f = fixture();
  write(f.root, '.planning/graph/delivery-front.json', JSON.stringify({
    generated_at: '2026-01-01T00:00:00.000Z', parked_by_run: [], auto_merge: 'off',
    owner_note: 'Committed existing delivery board',
  }, null, 2) + '\n');
  git(f.root, ['add', '.planning/graph/delivery-front.json']);
  git(f.root, ['commit', '-m', 'Add existing delivery board']);
  f.head = git(f.root, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
  return f;
}

test('actual architecture record, seal, clear preserve an existing committed board and independent consumption', async () => {
  const f = committedBoardFixture();
  try {
    const board = path.join(f.root, '.planning/graph/delivery-front.json');
    const before = fs.readFileSync(board);
    const completed = await unitJudgment(f, () => {
      assert.deepEqual(fs.readFileSync(board), before);
      const dispatches = require('../../plugins/delivery-pipeline/scripts/dispatch-record.cjs').activeDispatches(f.root);
      assert.equal(dispatches[TICKET].role, 'arch-review');
      const tickets = JSON.parse(fs.readFileSync(path.join(f.root, '.planning/graph/tickets.json'))).tickets;
      const state = JSON.parse(fs.readFileSync(path.join(f.root, '.planning/graph/delivery-state.json')));
      const front = require('../../plugins/delivery-pipeline/scripts/front.cjs').computeFront(tickets, state, { dispatched: dispatches });
      assert(front.waiting.dispatched.includes(TICKET));
    });
    assert.deepEqual(fs.readFileSync(board), before);
    const store = JSON.parse(fs.readFileSync(path.join(f.root, '.planning/graph/dispatches.json')));
    assert.equal(store.inflight[completed.result.receipt.dispatch_id], undefined);
    assert.equal(require('../../plugins/delivery-pipeline/scripts/dispatch-record.cjs').activeDispatches(f.root)[TICKET], undefined);
    const input = { ...completed.validationInput, recorder: undefined, io: undefined,
      boundaryStore: path.join(f.storage, 'receipts') };
    const consumer = `const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
      const x = JSON.parse(fs.readFileSync(0, 'utf8')); x.input.io = { execFileSync(exe, args, opts) {
        if (exe === 'gh') return JSON.stringify(x.pr); if (exe === 'git' && args.includes('fetch')) return '';
        return execFileSync(exe, args, opts); } };
      require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))})
        .validateJudgmentManifest(x.input);`;
    const consume = () => execFileSync(process.execPath, [...testAuthorityArgs, '-e', consumer], {
      input: JSON.stringify({ input, pr: f.pr }), encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
    });
    consume();
    const changed = JSON.parse(before); changed.owner_note = 'Unauthorized after cleanup';
    fs.writeFileSync(board, JSON.stringify(changed));
    assert.throws(consume, /local changes/);
  } finally { cleanupJudgment(f); }
});

test('unrelated existing board mutation during native review refuses before sealing', async () => {
  const f = committedBoardFixture();
  try {
    await assert.rejects(() => unitJudgment(f, () => {
      const board = path.join(f.root, '.planning/graph/delivery-front.json');
      const changed = JSON.parse(fs.readFileSync(board)); changed.owner_note = 'Unauthorized during review';
      fs.writeFileSync(board, JSON.stringify(changed));
    }), /local changes/);
  } finally { cleanupJudgment(f); }
});

test('ordinary inflight record and clear keep their default existing-board refresh behavior', () => {
  const f = committedBoardFixture();
  try {
    const { recordInflight, clearInflight } = require('../../plugins/delivery-pipeline/scripts/dispatch-record.cjs');
    const board = path.join(f.root, '.planning/graph/delivery-front.json');
    const before = fs.readFileSync(board, 'utf8');
    const input = { graphDir: path.join(f.root, '.planning/graph'), ticket: TICKET,
      role: 'arch-review', host: 'codex', dispatch_id: 'default-board-refresh', pid: process.pid };
    recordInflight(input);
    assert.notEqual(fs.readFileSync(board, 'utf8'), before);
    assert(JSON.parse(fs.readFileSync(board)).dispatches_applied_at);
    assert.equal(clearInflight(input), true);
    assert(JSON.parse(fs.readFileSync(board)).dispatches_applied_at);
  } finally { cleanupJudgment(f); }
});

test('a genuine retained first review authenticates preparation, completion and consumption of a second review', async () => {
  const f = fixture(), stores = [];
  try {
    const first = await unitJudgment(f); stores.push(f.storage);
    const original = fs.readFileSync(first.result.artifact.ref);
    const second = await unitJudgment(f); stores.push(f.storage);
    assert.equal(second.result.artifact.outcome, 'conform');
    assert.notEqual(second.result.artifact.ref, first.result.artifact.ref);
    assert.deepEqual(fs.readFileSync(first.result.artifact.ref), original);
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    assert.equal(artifacts.authenticatedArchivePins(f.root).length, 6);
    artifacts.validateJudgmentManifest(second.validationInput);
  } finally { cleanupJudgment(f); for (const store of stores) fs.rmSync(store, { recursive: true, force: true }); }
});

for (const [name, mutate] of [
  ['changed old evidence', (f, first) => {
    const manifest = JSON.parse(fs.readFileSync(first.result.artifact.ref));
    fs.appendFileSync(path.join(f.root, manifest.files.evidence.path), 'unauthorized historical mutation');
  }],
  ['unknown archive file', f => write(f.root, '.shipyard-role-artifacts/unknown.json', '{}')],
  ['unknown archive directory', f => fs.mkdirSync(path.join(f.root, '.shipyard-role-artifacts/unknown'))],
  ['removed catalogue legacy archive', f => fs.rmSync(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs')
    .archiveAuthorityDirectory(f.root), { recursive: true, force: true })],
  ['forged catalogue', f => {
    const catalogue = path.join(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs')
      .archiveAuthorityDirectory(f.root), 'catalogue.json');
    const envelope = JSON.parse(fs.readFileSync(catalogue)); envelope.payload.records = {};
    fs.writeFileSync(catalogue, JSON.stringify(envelope));
  }],
]) test('historical archive admission refuses ' + name, async () => {
  const f = fixture();
  try {
    const first = await unitJudgment(f); mutate(f, first);
    assert.throws(() => contextBuilder.prepare({ ticket: TICKET, phase: 38, worktree: f.root },
      { role: 'arch-review' }, { refreshGit: false, getPullRequest: () => f.pr }),
      /archive|catalogue|historical/);
  } finally { cleanupJudgment(f); }
});

test('a genuine prior Codex repair archive cannot supply host bookkeeping and remains admitted by the following review', async () => {
  const f = fixture(), stores = [];
  try {
    const first = await unitJudgment(f); stores.push(f.storage);
    const crypto = require('node:crypto');
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const role = 'ci-fix', selected = policy.resolveDispatch({ runtime: 'codex', role, signals: {} });
    const agents = path.join(f.storage, 'agents');
    let instructions = fs.readFileSync(path.join(agents, first.result.receipt.agent_file), 'utf8');
    const prior = policy.resolveDispatch({ runtime: 'codex', role: 'arch-review', signals: first.value.launch.signals });
    instructions = instructions.replace('shipyard-policy-role = "arch-review"', 'shipyard-policy-role = "ci-fix"')
      .replace('shipyard-policy-rung = "' + prior.rung + '"', 'shipyard-policy-rung = "' + selected.rung + '"')
      .replace('name = "' + first.result.receipt.agent_file.replace(/\.toml$/, '') + '"',
        'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"')
      .replace('model = "' + prior.model + '"', 'model = "' + selected.model + '"')
      .replace('model_reasoning_effort = "' + prior.effort + '"', 'model_reasoning_effort = "' + selected.effort + '"');
    fs.writeFileSync(path.join(agents, selected.agent_file), instructions);
    const manifestFile = path.join(agents, '.shipyard-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.agent_files.push(selected.agent_file);
    manifest.agent_digests[selected.agent_file] = crypto.createHash('sha256').update(instructions).digest('hex');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const result = { id: TICKET, pr: f.pr.number, status: 'no-op', pushed: false,
      notes: 'Captured unit repair found no further change.', hypothesis: 'The earlier patch resolved the issue.',
      host_context: { bookkeeping: [{ path: '.planning/graph/dispatches.json', sha256: 'a'.repeat(64), cleared_sha256: 'b'.repeat(64) }] } };
    write(f.root, '.shipyard-repair-evidence.md', 'Complete retained Codex repair evidence.');
    const nativeHost = { scope: first.scope, recorder: first.recorder,
      capabilities: { supportedModels: [selected.model], supportedEfforts: [selected.effort] },
      launchStatic(selection) {
        const session = crypto.randomUUID();
        const capture = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        const records = ['thread.started', 'item.completed', 'turn.completed']
          .map(type => structuredClone(capture.find(record => record.type === type)));
        records[0].thread_id = session; records[1].item.text = JSON.stringify(result);
        const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
        const transcript = path.join(f.storage, 'repair-transcript.jsonl'); fs.writeFileSync(transcript, text);
        const runtimeEvidence = structuredClone(first.result.receipt.runtime_evidence);
        runtimeEvidence.session_id = session;
        runtimeEvidence.transcript = { path: transcript, bytes: Buffer.byteLength(text),
          sha256: crypto.createHash('sha256').update(text).digest('hex') };
        return { launch_id: 'codex-' + session, applied_model: selection.model,
          applied_effort: selection.reasoning_effort, observed_model: selection.model,
          observed_effort: selection.reasoning_effort, agent_file_digest: selection.agent_file_digest,
          runtime_evidence: runtimeEvidence };
      },
    };
    const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const repairScope = { ...first.scope, run_id: 'repair-' + crypto.randomUUID() };
    nativeHost.scope = repairScope;
    const requestFile = path.join(f.storage, 'repair-request.json');
    fs.writeFileSync(requestFile, JSON.stringify({ scope: repairScope,
      role, signals: {}, context: { prompt: 'Evaluate the existing repair.' } }));
    let relay = '';
    await delivery.runCli(['--args-file', requestFile], { write: text => { relay += text; } }, {
      host: nativeHost, capabilities: nativeHost.capabilities, recorder: first.recorder,
      agentDir: agents, agentManifest: manifestFile, storageRoot: f.storage, graphDir: path.join(f.root, '.planning/graph'),
    });
    const dispatch = JSON.parse(relay);
    const provenance = path.join(f.root, '.planning/graph/provenance/' + dispatch.dispatch_id + '.json');
    assert(fs.existsSync(provenance));
    assert(artifacts.historicalBookkeepingPins(f.root).some(pin => pin.path.endsWith(dispatch.dispatch_id + '.json')));
    const repair = artifacts.sealRole({ worktreePath: f.root, base: 'refs/remotes/origin/main', role,
      ticket: TICKET, pr: f.pr.number, recorder: first.recorder, dispatchId: dispatch.dispatch_id, result });
    const archived = fs.readFileSync(repair.artifact_path);
    assert(artifacts.historicalBookkeepingPins(f.root).every(pin => pin.sha256 !== 'a'.repeat(64) && pin.sha256 !== 'b'.repeat(64)));
    const second = await unitJudgment(f); stores.push(f.storage);
    assert.equal(second.result.artifact.outcome, 'conform');
    assert.deepEqual(fs.readFileSync(repair.artifact_path), archived);
    assert.equal(artifacts.authenticatedArchivePins(f.root).length, 9);
    artifacts.validateJudgmentManifest(second.validationInput);
  } finally { cleanupJudgment(f); for (const store of stores) fs.rmSync(store, { recursive: true, force: true }); }
});

test('both native profiles deny the entire trusted archive namespace across worktrees and reject child selectors', async () => {
  const first = fixture(), second = fixture();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-archive-profiles-'));
  try {
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const namespace = artifacts.archiveAuthorityNamespace();
    assert(artifacts.archiveAuthorityDirectory(first.root).startsWith(namespace + path.sep));
    assert(artifacts.archiveAuthorityDirectory(second.root).startsWith(namespace + path.sep));
    const cases = [
      ['codex', require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').createCodexCliLauncher,
        { model: 'gpt-6.1-sol', effort: 'low', sandbox_mode: 'read-only' }],
      ['claude', require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs').createClaudeCliLauncher,
        { model: 'claude-opus-5-5', effort: 'low' }],
    ];
    for (const [runtime, factory, selection] of cases) {
      let args;
      const scope = { run_id: 'archive-profile-' + runtime, ticket: TICKET, phase: 38, worktree: second.root };
      const launch = factory({ scope, transcriptDir: path.join(temporary, runtime, 'transcripts'),
        capabilities: { supportedModels: [selection.model], supportedEfforts: ['low'] },
        env: {}, spawn(_executable, captured) { args = captured; throw new Error('profile capture only'); } });
      let failure;
      await assert.rejects(() => launch('Capture a native profile without launching a provider.', selection), error => { failure = error; return true; });
      assert(Array.isArray(args), failure && failure.stack);
      if (runtime === 'codex') {
        const filesystem = args.find(arg => arg.startsWith('permissions.shipyard-runtime.filesystem='));
        assert(filesystem.includes(JSON.stringify(namespace) + '="deny"'));
        assert(filesystem.includes('.gnupg'));
      } else {
        const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
        assert.equal(args[args.indexOf('--setting-sources') + 1], '');
        assert.deepEqual(settings.sandbox.filesystem.denyRead, [namespace]);
        assert.deepEqual(settings.sandbox.filesystem.denyWrite, [namespace]);
        assert.deepEqual(settings.sandbox.filesystem.allowWrite, [second.root]);
        assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
        const glob = '//' + namespace.split(path.sep).filter(Boolean).join('/') + '/**';
        for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep'])
          assert(settings.permissions.deny.includes(tool + '(' + glob + ')'));
        assert(settings.permissions.deny.some(rule => rule.includes('shipyard-claude-session-start-')));
      }
      for (const key of ['archiveAuthorityPath', 'archiveCataloguePath', 'archive_authority_path', 'archive_catalogue_path'])
        await assert.rejects(() => launch('No child path authority.', { ...selection, [key]: temporary }), /fixed by the trusted host/);
    }
  } finally { cleanupJudgment(first); cleanupJudgment(second); fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('a missing authority namespace is created privately and symlink namespaces refuse', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-authority-namespace-'));
  try {
    const script = `const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
      require('node:os').homedir = () => ${JSON.stringify(temporary)};
      const artifacts = require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))});
      const namespace = artifacts.archiveAuthorityNamespace(true);
      assert.equal(fs.realpathSync(namespace), namespace);
      assert.equal(fs.statSync(namespace).mode & 0o077, 0);
      fs.rmdirSync(namespace); const other = path.join(${JSON.stringify(temporary)}, 'other'); fs.mkdirSync(other);
      fs.symlinkSync(other, namespace, 'dir');
      assert.throws(() => artifacts.archiveAuthorityNamespace(), /symlinks/);`;
    execFileSync(process.execPath, [...testAuthorityArgs, '-e', script], { stdio: ['ignore','pipe','pipe'] });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('a linked canonical graph preserves default board refresh during architecture record and clear', async () => {
  const f = committedBoardFixture(), review = f.root + '-linked';
  try {
    git(f.root, ['switch', 'main']);
    git(f.root, ['worktree', 'add', review, BRANCH]);
    f.reviewRoot = fs.realpathSync(review);
    const board = path.join(f.root, '.planning/graph/delivery-front.json');
    write(f.root, '.planning/graph/delivery-front.json', JSON.stringify({
      generated_at: '2026-01-01T00:00:00.000Z', parked_by_run: [], auto_merge: 'off',
    }) + '\n');
    const before = fs.readFileSync(board, 'utf8');
    const result = await unitJudgment(f, () => assert.notEqual(fs.readFileSync(board, 'utf8'), before));
    assert.equal(result.result.artifact.outcome, 'conform');
    assert(JSON.parse(fs.readFileSync(board)).dispatches_applied_at);
    assert.equal(require('../../plugins/delivery-pipeline/scripts/dispatch-record.cjs').activeDispatches(f.root)[TICKET], undefined);
  } finally {
    if (fs.existsSync(review)) {
      fs.rmSync(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').archiveAuthorityDirectory(review), { recursive: true, force: true });
      try { git(f.root, ['worktree', 'remove', '--force', review]); } catch {}
    }
    cleanupJudgment(f);
  }
});

test('historical archive size mismatch refuses before opening or allocating its complete content', async () => {
  const f = fixture();
  const lstat = fs.lstatSync, open = fs.openSync;
  try {
    const first = await unitJudgment(f);
    const manifest = JSON.parse(fs.readFileSync(first.result.artifact.ref));
    const target = path.join(f.root, manifest.files.evidence.path);
    let opened = 0;
    fs.lstatSync = function(file, ...args) {
      const stat = lstat.call(fs, file, ...args);
      return String(file) === target ? Object.assign(Object.create(stat), { size: 2 ** 40 }) : stat;
    };
    fs.openSync = function(file, ...args) { if (String(file) === target) opened++; return open.call(fs, file, ...args); };
    assert.throws(() => require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').authenticatedArchivePins(f.root), /size.*authenticated pin/);
    assert.equal(opened, 0);
  } finally { fs.lstatSync = lstat; fs.openSync = open; cleanupJudgment(f); }
});

test('historical bounded descriptor reads refuse atomic pathname replacement with identical bytes', async () => {
  const f = fixture();
  const open = fs.openSync, read = fs.readSync;
  try {
    const first = await unitJudgment(f);
    const manifest = JSON.parse(fs.readFileSync(first.result.artifact.ref));
    const target = path.join(f.root, manifest.files.evidence.path), replacement = target + '.replacement';
    const content = fs.readFileSync(target); let descriptor, replaced = false;
    fs.openSync = function(file, ...args) { const fd = open.call(fs, file, ...args); if (String(file) === target) descriptor = fd; return fd; };
    fs.readSync = function(fd, ...args) {
      const result = read.call(fs, fd, ...args);
      if (fd === descriptor && !replaced) { replaced = true; fs.writeFileSync(replacement, content); fs.renameSync(replacement, target); }
      return result;
    };
    assert.throws(() => require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').authenticatedArchivePins(f.root), /changed during bounded reading/);
    assert.equal(replaced, true);
  } finally { fs.openSync = open; fs.readSync = read; cleanupJudgment(f); }
});


function sourceApproval(f, additionalPaths = []) {
  const role = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const source = role.architectureSourceIdentity(f.root);
  const paths = fs.readdirSync(path.join(f.root, '.planning/architecture')).filter(name => name.endsWith('.md'))
    .map(name => '.planning/architecture/' + name).concat(additionalPaths).sort();
  const pins = paths.map(relative => {
    const bytes = fs.readFileSync(path.join(f.root, relative));
    return { path: relative, bytes: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
  });
  const approval = { schema: 'shipyard.architecture-source-approval.v1', approval_id: 'independent-fixture-approval', source, pins, exceptional_paths: paths.filter(relative => relative.includes('ADR-025')) };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-source-approval-'));
  const approvalTablePath = path.join(directory, 'approval.json');
  const bytes = Buffer.from(JSON.stringify(approval));
  fs.writeFileSync(approvalTablePath, bytes, { mode: 0o600 });
  return { role, approval, directory, input: { worktreePath: f.root, projectPath: f.root, approvalTablePath,
    expectedApprovalDigest: require('node:crypto').createHash('sha256').update(bytes).digest('hex') } };
}

test('linked canonical dirty ADR refuses while an uncommitted protected PLAN remains accepted', () => {
  const f = fixture(); let review;
  try {
    review = f.root + '-linked'; git(f.root, ['switch', 'main']); git(f.root, ['worktree', 'add', review, BRANCH]);
    write(f.root, planPath(), fs.readFileSync(path.join(f.root, planPath()), 'utf8') + '\nProtected handoff context\n');
    const scope = { ticket: TICKET, phase: 38, worktree: review };
    const options = { refreshGit: false, graphDir: path.join(f.root, '.planning/graph'), listPullRequests: () => [f.pr], getPullRequest: () => f.pr };
    const launch = { role: 'arch-review', context: {}, signals: {} };
    assert.ok(contextBuilder.prepare(scope, launch, options));
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR + 'unapproved bytes\n');
    assert.throws(() => contextBuilder.prepare(scope, launch, options), /dirty architecture source.*protected approval/);
  } finally { if (review) git(f.root, ['worktree', 'remove', '--force', review]); cleanupJudgment(f); }
});

test('independently approved untracked ADR joins committed corpus and survives fresh collection', async () => {
  const f = fixture(); let approval;
  try {
    git(f.root, ['switch', 'main']);
    write(f.root, '.planning/architecture/ADR-025-bootstrap.md', '# Independently approved bootstrap\n');
    approval = sourceApproval(f);
    approval.role.registerArchitectureAuthority(approval.input);
    git(f.root, ['update-index', '--skip-worktree', '.planning/architecture/ADR-014-host-bound-review.md']);
    const review = f.root + '-approved'; git(f.root, ['worktree', 'add', review, BRANCH]);
    try {
      const scope = { ticket: TICKET, phase: 38, worktree: review };
      const prepared = contextBuilder.prepare(scope, { role: 'arch-review', context: {}, signals: {} }, { refreshGit: false, graphDir: path.join(f.root, '.planning/graph'), listPullRequests: () => [f.pr], getPullRequest: () => f.pr });
      assert.equal(prepared.prepared.packet.source_authority.approval_id, 'independent-fixture-approval');
      const fresh = contextBuilder.prepare(scope, { role: 'arch-review', context: {}, signals: {} }, { refreshGit: false, graphDir: path.join(f.root, '.planning/graph'), listPullRequests: () => [f.pr], getPullRequest: () => f.pr });
      assert.equal(fresh.prepared.packet.source_authority.approval_digest, approval.input.expectedApprovalDigest);
    } finally { git(f.root, ['worktree', 'remove', '--force', review]); }
  } finally { if (approval) fs.rmSync(approval.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});

for (const [name, change] of [
  ['wrong independently retained digest', (f, a) => { a.input.expectedApprovalDigest = 'a'.repeat(64); }],
  ['wrong approved head', (f, a) => { a.approval.source.head = 'a'.repeat(40); }],
  ['unknown added ADR', (f) => write(f.root, '.planning/architecture/ADR-026-unknown.md', '# unknown\n')],
  ['deleted member', (f) => fs.unlinkSync(path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md'))],
  ['changed member', (f) => write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR + 'changed\n')],
  ['moved symlink member', (f) => { const original = path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md'); fs.renameSync(original, original + '.original'); fs.symlinkSync(original + '.original', original); }],
]) test('independent source admission refuses ' + name, () => {
  const f = fixture(); const a = sourceApproval(f);
  try {
    change(f, a);
    if (name === 'wrong approved head') {
      const bytes = Buffer.from(JSON.stringify(a.approval)); fs.writeFileSync(a.input.approvalTablePath, bytes);
      a.input.expectedApprovalDigest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    }
    assert.throws(() => a.role.registerArchitectureAuthority(a.input), /source|corpus|approval|symlink|missing|membership|ENOENT/);
  } finally { fs.rmSync(a.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});


for (const [name, mutate] of [
  ['removed protected registry', (f, a) => fs.unlinkSync(a.role.architectureAuthorityPath(f.root, a.approval.source, a.approval.pins))],
  ['forged protected registry', (f, a) => { const file = a.role.architectureAuthorityPath(f.root, a.approval.source, a.approval.pins); const value = JSON.parse(fs.readFileSync(file)); value.payload.approval_id = 'forged'; fs.writeFileSync(file, JSON.stringify(value)); }],
  ['canonical head advanced', (f) => { git(f.root, ['commit', '--allow-empty', '-m', 'fixture: advance approved canonical head']); f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']); }],
]) test('fresh consumer refuses ' + name + ' after sealed source approval', async () => {
  const f = fixture(), a = sourceApproval(f);
  try {
    a.role.registerArchitectureAuthority(a.input);
    const sealed = await unitJudgment(f);
    a.role.validateJudgmentManifest(sealed.validationInput);
    mutate(f, a);
    assert.throws(() => a.role.validateJudgmentManifest(sealed.validationInput), /source|approval|authentication|changed|stale|head/);
  } finally { fs.rmSync(a.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});


test('registry-only authority reads without a catalogue and a missing key never recreates authority', () => {
  const f = fixture(), a = sourceApproval(f);
  try {
    a.role.registerArchitectureAuthority(a.input);
    const directory = a.role.archiveAuthorityDirectory(f.root);
    assert.equal(fs.existsSync(path.join(directory, 'catalogue.json')), false);
    assert.equal(prepared(f).prepared.packet.source_authority.approval_id, a.approval.approval_id);
    fs.unlinkSync(path.join(directory, 'hmac.key'));
    const before = fs.readdirSync(directory).sort();
    assert.throws(() => prepared(f), /ENOENT|missing|authority/);
    assert.equal(fs.existsSync(path.join(directory, 'hmac.key')), false);
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
  } finally { fs.rmSync(a.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});


test('complete corpus aggregate budget refuses before opening the next oversized member', () => {
  const f = fixture(); const original = fs.openSync; let laterOpened = false;
  try {
    write(f.root, '.planning/architecture/ADR-015-first.md', 'a'.repeat(10 * 1024 * 1024));
    write(f.root, '.planning/architecture/ADR-016-later.md', 'b'.repeat(7 * 1024 * 1024));
    git(f.root, ['add', '.planning/architecture']); git(f.root, ['commit', '-m', 'fixture: aggregate bounded corpus']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    fs.openSync = function(file, ...args) {
      if (String(file) === path.join(f.root, '.planning/architecture/ADR-016-later.md')) laterOpened = true;
      return original.call(fs, file, ...args);
    };
    assert.throws(() => prepared(f), /exceeds its bound/);
    assert.equal(laterOpened, false);
  } finally { fs.openSync = original; cleanupJudgment(f); }
});

test('context fixed-size descriptor read refuses growth without allocating expanded content', () => {
  const f = fixture(); const originalOpen = fs.openSync, originalRead = fs.readSync;
  let descriptor, grew = false;
  try {
    const target = path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md');
    fs.openSync = function(file, ...args) { const fd = originalOpen.call(fs, file, ...args); if (String(file) === target) descriptor = fd; return fd; };
    fs.readSync = function(fd, ...args) {
      if (fd === descriptor && !grew) { grew = true; fs.appendFileSync(target, 'unapproved growth'); }
      return originalRead.call(fs, fd, ...args);
    };
    assert.throws(() => prepared(f), /grew beyond its bound|changed while reading/);
    assert.equal(grew, true);
  } finally { fs.openSync = originalOpen; fs.readSync = originalRead; cleanupJudgment(f); }
});


test('original approval table growth refuses before allocation and leaves no registered authority', () => {
  const f = fixture(), a = sourceApproval(f), original = fs.openSync;
  let changed = false;
  try {
    fs.openSync = function(file, ...args) {
      const fd = original.call(fs, file, ...args);
      if (String(file) === a.input.approvalTablePath && !changed) { changed = true; fs.appendFileSync(file, 'unapproved growth'); }
      return fd;
    };
    assert.throws(() => a.role.registerArchitectureAuthority(a.input), /changed before bounded reading/);
    assert.equal(changed, true);
    assert.equal(fs.existsSync(a.role.architectureAuthorityPath(f.root, a.approval.source, a.approval.pins)), false);
  } finally { fs.openSync = original; fs.rmSync(a.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});

test('original native transcript growth refuses before allocating expanded content', async () => {
  const f = fixture(), open = fs.openSync; let changed = false;
  try {
    await assert.rejects(() => unitJudgment(f, () => {
      fs.openSync = function(file, ...args) {
        const fd = open.call(fs, file, ...args);
        if (String(file) === f.transcript && !changed) { changed = true; fs.appendFileSync(file, 'unapproved growth'); }
        return fd;
      };
    }), /changed before reading|recorded bounded|transcript|changed while|grew beyond/);
    assert.equal(changed, true);
  } finally { fs.openSync = open; cleanupJudgment(f); }
});

test('committed-only collection with an absent authority namespace creates no namespace', () => {
  const f = fixture(); const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-absent-authority-'));
  const original = os.homedir;
  try {
    os.homedir = () => home;
    assert.ok(prepared(f));
    assert.equal(fs.existsSync(path.join(home, '.local')), false);
  } finally { os.homedir = original; fs.rmSync(home, { recursive: true, force: true }); cleanupJudgment(f); }
});


test('original native transcript same-byte replacement between original stat and bounded reader refuses', async () => {
  const f = fixture(), lstat = fs.lstatSync; let replaced = false;
  try {
    await assert.rejects(() => unitJudgment(f, () => {
      fs.lstatSync = function(file, ...args) {
        const stat = lstat.call(fs, file, ...args);
        if (String(file) === f.transcript && !replaced) {
          replaced = true; const replacement = String(file) + '.replacement';
          fs.writeFileSync(replacement, fs.readFileSync(file)); fs.renameSync(replacement, file);
        }
        return stat;
      };
    }), /changed before reading|changed while|transcript/);
    assert.equal(replaced, true);
  } finally { fs.lstatSync = lstat; cleanupJudgment(f); }
});


for (const kind of ['current manifest', 'current archive evidence', 'current archive findings', 'current source evidence'])
  for (const mode of ['oversized before open', 'growing after open'])
    test('fresh process bounds ' + kind + ' ' + mode, async () => {
      const f = fixture();
      try {
        const sealed = await unitJudgment(f), manifest = JSON.parse(fs.readFileSync(sealed.result.artifact.ref));
        const target = kind === 'current manifest' ? sealed.result.artifact.ref
          : kind === 'current archive evidence' ? path.join(f.root, manifest.files.evidence.path)
          : kind === 'current archive findings' ? path.join(f.root, manifest.files.findings.path)
          : path.join(f.root, '.shipyard-arch-review-evidence.md');
        const input = { ...sealed.validationInput, recorder: undefined, io: undefined, boundaryStore: path.join(f.storage, 'receipts') };
        const script = `const fs = require('node:fs'), assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
          const x = JSON.parse(fs.readFileSync(0, 'utf8')), lstat = fs.lstatSync, open = fs.openSync;
          let opened = false, changed = false;
          fs.lstatSync = function(file, ...args) { const stat = lstat.call(fs, file, ...args); if (String(file) === x.target && x.mode === 'oversized before open') return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 2 ** 40 }); return stat; };
          fs.openSync = function(file, ...args) { const fd = open.call(fs, file, ...args); if (String(file) === x.target) { opened = true; if (x.mode === 'growing after open' && !changed) { changed = true; fs.appendFileSync(file, 'unapproved growth'); } } return fd; };
          x.input.io = { execFileSync(exe, args, options) { if (exe === 'gh') return JSON.stringify(x.pr); if (exe === 'git' && args.includes('fetch')) return ''; return execFileSync(exe, args, options); } };
          assert.throws(() => require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))}).validateJudgmentManifest(x.input), /bound|changed/);
          if (x.mode === 'oversized before open') assert.equal(opened, false); else assert.equal(changed, true);`;
        execFileSync(process.execPath, [...testAuthorityArgs, '-e', script], { input: JSON.stringify({ input, pr: f.pr, target, mode }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } finally { cleanupJudgment(f); }
    });


test('public Codex architecture sealer bounds complete source evidence before opening it', async () => {
  const f = fixture(), lstat = fs.lstatSync, open = fs.openSync; let opened = false;
  try {
    const sealed = await unitJudgment(f), manifest = JSON.parse(fs.readFileSync(sealed.result.artifact.ref));
    const result = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
    const target = path.join(f.root, '.shipyard-arch-review-evidence.md');
    fs.lstatSync = function(file, ...args) { const stat = lstat.call(fs, file, ...args); return String(file) === target ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 2 ** 40 }) : stat; };
    fs.openSync = function(file, ...args) { if (String(file) === target) opened = true; return open.call(fs, file, ...args); };
    assert.throws(() => require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').sealJudgment({ ...sealed.validationInput, result }), /complete-byte bound/);
    assert.equal(opened, false);
  } finally { fs.lstatSync = lstat; fs.openSync = open; cleanupJudgment(f); }
});


for (const kind of ['evidence', 'findings', 'manifest'])
  for (const mode of ['existing', 'EEXIST race'])
    test('public Codex architecture retry bounds ' + kind + ' ' + mode + ' before opening it', async () => {
      const f = fixture(), lstat = fs.lstatSync, open = fs.openSync, exists = fs.existsSync;
      let opened = false, hidden = false;
      try {
        const sealed = await unitJudgment(f), manifest = JSON.parse(fs.readFileSync(sealed.result.artifact.ref));
        const result = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
        const target = kind === 'manifest' ? sealed.result.artifact.ref : path.join(f.root, manifest.files[kind].path);
        fs.lstatSync = function(file, ...args) { const stat = lstat.call(fs, file, ...args); return String(file) === target ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 2 ** 40 }) : stat; };
        fs.openSync = function(file, ...args) { if (String(file) === target) opened = true; return open.call(fs, file, ...args); };
        fs.existsSync = function(file) { if (mode === 'EEXIST race' && String(file) === target && !hidden) { hidden = true; return false; } return exists.call(fs, file); };
        assert.throws(() => require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').sealJudgment({ ...sealed.validationInput, result }), /complete-byte bound/);
        assert.equal(opened, false);
        if (mode === 'EEXIST race') assert.equal(hidden, true);
      } finally { fs.lstatSync = lstat; fs.openSync = open; fs.existsSync = exists; cleanupJudgment(f); }
    });


test('two independently approved linked decision closures coexist across sealed fresh consumers', async () => {
  const f = fixture(), other = { ...f, ticket: 'T-38-02-role-host' }; let a, b;
  const reviews = [f.root + '-first-review', f.root + '-second-review'];
  const decision = '.planning/investigations/INV-closure/DECISIONS.md';
  try {
    git(f.root, ['switch', 'main']);
    const graphPath = '.planning/graph/tickets.json', statePath = '.planning/graph/delivery-state.json';
    const graph = JSON.parse(fs.readFileSync(path.join(f.root, graphPath))), state = JSON.parse(fs.readFileSync(path.join(f.root, statePath)));
    const plan = '.planning/phases/38-codex-arch-review/38-02-PLAN.md', branch = 'ticket/' + other.ticket;
    graph.tickets[other.ticket] = { ...graph.tickets[TICKET], plan, branch };
    state[other.ticket] = { status: 'pr-open', pr: 302 };
    write(f.root, graphPath, JSON.stringify(graph)); write(f.root, statePath, JSON.stringify(state));
    write(f.root, decision, '# Independent linked decision\n');
    write(f.root, plan, fs.readFileSync(path.join(f.root, planPath()), 'utf8') + '\nSee [' + decision + '](' + decision + ')\n');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: two independent protected planning closures']);
    write(f.root, '.planning/architecture/ADR-025-bootstrap.md', '# Independently approved bootstrap\n');
    git(f.root, ['worktree', 'add', reviews[0], BRANCH]);
    git(f.root, ['worktree', 'add', '-b', branch, reviews[1], f.head]);
    f.reviewRoot = reviews[0]; other.reviewRoot = reviews[1];
    other.pr = { ...f.pr, number: 302, headRefName: branch };
    a = sourceApproval(f); b = sourceApproval(f, [decision]);
    a.role.registerArchitectureAuthority(a.input);
    const first = await unitJudgment(f), originalDigest = first.value.prepared.packet.digest;
    const secondRegistration = b.role.registerArchitectureAuthority(b.input);
    const second = await unitJudgment(other);
    assert.notEqual(a.role.architectureAuthorityPath(f.root, a.approval.source, a.approval.pins), secondRegistration.recordPath);
    assert.deepEqual(a.role.authenticateArchitectureSources(reviews[0], f.root, first.value.prepared.packet.source_authority.pins), first.value.prepared.packet.source_authority);
    assert.equal(first.value.prepared.packet.digest, originalDigest);
    for (const [fixture, sealed] of [[f, first], [other, second]]) {
      const input = { ...sealed.validationInput, recorder: undefined, io: undefined, boundaryStore: path.join(fixture.storage, 'receipts') };
      const script = `const fs = require('node:fs'), { execFileSync } = require('node:child_process'); const x = JSON.parse(fs.readFileSync(0, 'utf8'));
        x.input.io = { execFileSync(exe,args,options) { if(exe==='gh')return JSON.stringify(x.pr);if(exe==='git'&&args.includes('fetch'))return '';return execFileSync(exe,args,options); } };
        require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))}).validateJudgmentManifest(x.input);`;
      execFileSync(process.execPath, [...testAuthorityArgs, '-e', script], { input: JSON.stringify({ input, pr: fixture.pr }), encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    }
    fs.unlinkSync(secondRegistration.recordPath);
    assert.throws(() => a.role.validateJudgmentManifest(second.validationInput), /uncommitted architecture source.*protected approval/);
    a.role.validateJudgmentManifest(first.validationInput);
  } finally {
    for (const fixture of [f, other]) {
      if (fixture.reviewRoot && fs.existsSync(fixture.reviewRoot)) fs.rmSync(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').archiveAuthorityDirectory(fixture.reviewRoot), { recursive: true, force: true });
      if (fixture.storage) fs.rmSync(fixture.storage, { recursive: true, force: true });
    }
    for (const review of reviews) { try { git(f.root, ['worktree', 'remove', '--force', review]); } catch {} }
    for (const approval of [a,b]) if (approval) fs.rmSync(approval.directory, { recursive: true, force: true });
    cleanupJudgment(f);
  }
});

test('same inventory authority publication is idempotent and refuses a changed independently approved payload', () => {
  const f = fixture(), a = sourceApproval(f);
  try {
    const first = a.role.registerArchitectureAuthority(a.input), bytes = fs.readFileSync(first.recordPath);
    assert.deepEqual(a.role.registerArchitectureAuthority(a.input), first);
    a.approval.approval_id = 'different-independent-approval';
    const updated = Buffer.from(JSON.stringify(a.approval)); fs.writeFileSync(a.input.approvalTablePath, updated);
    a.input.expectedApprovalDigest = require('node:crypto').createHash('sha256').update(updated).digest('hex');
    assert.throws(() => a.role.registerArchitectureAuthority(a.input), /cannot replace.*original/);
    assert.deepEqual(fs.readFileSync(first.recordPath), bytes);
  } finally { fs.rmSync(a.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});


test('source approval envelope bound refuses before publishing any temporary or final record', () => {
  const f = fixture(), a = sourceApproval(f), original = fs.writeFileSync; let recordWrites = 0;
  try {
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...a.approval, approval_id: '' }));
    a.approval.approval_id = 'x'.repeat(4 * 1024 * 1024 - baseBytes - 5);
    const approvedBytes = Buffer.from(JSON.stringify(a.approval));
    assert(approvedBytes.length < 4 * 1024 * 1024);
    fs.writeFileSync(a.input.approvalTablePath, approvedBytes);
    a.input.expectedApprovalDigest = require('node:crypto').createHash('sha256').update(approvedBytes).digest('hex');
    const recordPath = a.role.architectureAuthorityPath(f.root, a.approval.source, a.approval.pins);
    fs.writeFileSync = function(file, ...args) { if (String(file) === recordPath || String(file).startsWith(recordPath + '.')) recordWrites++; return original.call(fs, file, ...args); };
    assert.throws(() => a.role.registerArchitectureAuthority(a.input), /serialized source approval exceeds.*bound/);
    assert.equal(recordWrites, 0);
    assert.equal(fs.readdirSync(a.role.archiveAuthorityDirectory(f.root)).some(name => name.startsWith('architecture-sources-')), false);
  } finally { fs.writeFileSync = original; fs.rmSync(a.directory, { recursive: true, force: true }); cleanupJudgment(f); }
});


test('actual serial registration returns a rejected case and executes the following awaited case', async () => {
  const recorded = []; let completed = false;
  registerCases((name, callback) => recorded.push({ name, promise: callback() }), [
    ['fails after await', async () => { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('serial-case-failure'); }],
    ['continues after failure', async () => { await new Promise(resolve => setTimeout(resolve, 10)); completed = true; return 'continued'; }],
  ]);
  assert.deepEqual(recorded.map(item => item.name), ['fails after await', 'continues after failure']);
  await assert.rejects(recorded[0].promise, /serial-case-failure/);
  assert.equal(await recorded[1].promise, 'continued');
  assert.equal(completed, true);
});



test('ignored physical archive additions during completion are refused before publication', async () => {
  const f = fixture();
  try {
    write(f.root, '.gitignore', '*.log\n');
    git(f.root, ['add', '.gitignore']); git(f.root, ['commit', '-m', 'fixture: ignored log']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    await assert.rejects(unitJudgment(f, current => write(current.root, '.shipyard-role-artifacts/unknown.log', 'unknown')),
      /archive membership|inventory/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, '.shipyard-role-artifacts')), ['unknown.log']);
  } finally { cleanupJudgment(f); }
});

test('fresh consumption refuses ignored archive members while preserving the retained judgment', async () => {
  const f = fixture();
  try {
    write(f.root, '.gitignore', '*.log\n');
    git(f.root, ['add', '.gitignore']); git(f.root, ['commit', '-m', 'fixture: ignored log']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    const sealed = await unitJudgment(f);
    const unknown = path.join(f.root, '.shipyard-role-artifacts/unknown.log');
    fs.writeFileSync(unknown, 'unknown');
    const role = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    assert.throws(() => role.validateJudgmentManifest(sealed.validationInput), /archive membership|inventory/);
    fs.unlinkSync(unknown);
    assert.doesNotThrow(() => role.validateJudgmentManifest(sealed.validationInput));
  } finally { cleanupJudgment(f); }
});

function aggregateRuntimeFixture({ host: fixtureHost, parsed, storage, capabilities, recorder, selected, text, agentDir, agentManifest, inspect }) {
  const { EventEmitter } = require('node:events');
  const home = path.join(storage, 'native-home');
  process.env.CODEX_HOME = home;
  assert.equal(fs.realpathSync(agentDir), fs.realpathSync(path.join(home, 'agents')));
  assert.equal(fs.realpathSync(agentManifest), path.join(fs.realpathSync(agentDir), '.shipyard-manifest.json'));
  const installedManifestBytes = fs.readFileSync(agentManifest);
  const installedAgentPath = path.join(agentDir, selected.agent_file);
  assert.equal(fs.readFileSync(installedAgentPath, 'utf8'), text);
  const installedAdapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs')
    .createCodexDispatchAdapter({ agentsDir: agentDir, agentManifest, capabilities });
  assert.equal(installedAdapter.validate(selected), true);
  const batchSession = require('node:crypto').randomUUID();
  let batchLaunches = 0;
  return require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').createCodexRuntimeHost({
    scope: parsed.scope, capabilities, recorder, env: { CODEX_HOME: home }, agentDir, agentManifest,
    probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
    transcriptDir: path.join(storage, 'native-streams'),
    spawn(executable, args) {
      assert.deepEqual(fs.readFileSync(agentManifest), installedManifestBytes,
        'original probe and fresh final retain the same installed manifest');
      assert.equal(fs.readFileSync(installedAgentPath, 'utf8'), text,
        'original probe and fresh final retain the same installed instruction bytes');
      assert.equal(args[args.indexOf('--model') + 1], selected.model);
      assert.equal(args.find(arg => arg.startsWith('model_reasoning_effort=')),
        'model_reasoning_effort=' + JSON.stringify(selected.effort));
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 23001;
      let stdin = '';
      child.stdin = { write(value) { stdin += value; }, end() {
        try {
          const focusedFields = /^Repeat these focused subject fields: (.+)$/m.exec(stdin);
          if (focusedFields) {
            assert.equal(++batchLaunches, 1, 'focused architecture has one original launch and no capacity probe');
            const binding = JSON.parse(focusedFields[1]);
            const envelope = JSON.parse(stdin.split('<AUTHENTICATED_CONTEXT_PACKET>')[1].split('</AUTHENTICATED_CONTEXT_PACKET>')[0].trim());
            inspect(envelope);
            const packet = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs').decodeUniqueContent(envelope);
            const result = { ...binding, id: parsed.scope.ticket, pr: packet.pr.number, head: packet.pr.head,
              base_tree: packet.diff.merge_base_tree, review_completeness: 'complete', limitations: [], unresolved_sources: [],
              verdict: 'conform', summary: 'Independent fixture focused aggregate judgment.', findings: [], blocking_count: 0,
              ticket_set: packet.ticket_set, ticket_set_digest: packet.ticket_set_digest,
              context_digest: packet.digest, launch_digest: stdin.match(/launch_digest=([a-f0-9]{64})/)[1],
              evidence_markdown: 'Complete unit aggregate review.' };
            const resultText = JSON.stringify(result);
            const native = require('./helpers/codex-arch-review-fixtures.cjs').focusedNativeSession({ session: batchSession,
              worktree: parsed.scope.worktree, model: selected.model, effort: selected.effort, text: resultText, prompt: stdin });
            const now = new Date(), directory = path.join(home, 'sessions', String(now.getFullYear()),
              String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
            fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, batchSession + '.jsonl'), native);
            const templates = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
              .trim().split('\n').map(JSON.parse);
            const cli = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
              .map(type => structuredClone(templates.find(row => row.type === type)));
            cli[0].thread_id = batchSession; cli[2].item.text = resultText;
            process.nextTick(() => { child.stdout.emit('data', Buffer.from(cli.map(JSON.stringify).join('\n') + '\n')); child.emit('close', 0, null); });
            return;
          }
          assert.fail('focused architecture review has no file-input transport');
        } catch (error) { process.nextTick(() => child.emit('error', error)); }
      } };
      return child;
    },
  });
}

test('focused architecture review never relays files: instruction bytes over the launch bound refuse', () => {
  const f = fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-fallback-')));
  try {
    canonicalReviewMember(f);
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR + 'a'.repeat(250000));
    git(f.root, ['add', '-A']); git(f.root, ['commit', '-m', 'large review context']);
    f.head = git(f.root, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    const value = contextBuilder.prepare({ ticket: f.ticket, phase: 38, worktree: f.root },
      { role: 'arch-review', context: {}, signals: {} }, { refreshGit: false,
        graphDir: path.join(f.root, '.planning/graph'), getPullRequest: () => f.pr,
        storageRoot: storage, inflightDispatchId: 'instruction-fallback' });
    assert.ok(Buffer.byteLength(value.launch.context.prompt) < 1048576);
    const agents = path.join(storage, 'agents'); fs.mkdirSync(agents);
    write(agents, 'review.toml', ["developer_instructions = '''", 'b'.repeat(900000), "'''", ''].join('\n'));
    write(agents, 'manifest.json', '{}');
    assert.throws(() => contextBuilder.admitInstalledLaunch(value, { agentDir: agents, agentFile: 'review.toml',
      agentManifest: path.join(agents, 'manifest.json'), capabilities: {} }), { code: 'CONTEXT_OVER_BOUND' });
    assert.deepEqual(fs.readdirSync(storage).filter(name => name.startsWith('input-')), []);
  } finally { cleanupJudgment(f); fs.rmSync(storage, { recursive: true, force: true }); }
});

test('Codex arch-review refuses a head that moves after preparation', () => {
  const f = fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moved-head-')));
  try {
    const value = prepared(f);
    write(f.root, 'src/reviewed.txt', 'moved after preparation\n');
    git(f.root, ['commit', '-am', 'fixture: moved head']);
    const agents = path.join(storage, 'agents'); fs.mkdirSync(agents);
    write(agents, 'review.toml', "developer_instructions = '''\nreview\n'''\n");
    write(agents, 'manifest.json', '{}');
    assert.throws(() => contextBuilder.admitInstalledLaunch(value, { agentDir: agents, agentFile: 'review.toml',
      agentManifest: path.join(agents, 'manifest.json'), capabilities: {} }), { code: 'STALE_CONTEXT' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true }); }
});

test('complete development inventory preserves Unicode, quotes, tabs and newlines in Git paths', () => {
  const f = fixture();
  try {
    const paths = ['docs/audits/é.md', 'docs/audits/quote".md', 'docs/audits/tab\t.md', 'docs/audits/line\n.md'];
    paths.forEach((name, index) => write(f.root, name, 'development evidence ' + index));
    const objectDirectory = path.resolve(f.root, git(f.root, ['rev-parse', '--git-path', 'objects']));
    assert.ok(fs.statSync(objectDirectory).isDirectory(), 'fixture object directory exists before unusual-path indexing');
    try { git(f.root, ['add', '-A']); } catch (error) {
      error.fixture_git_environment = { root: f.root, objectDirectory,
        objects_present: fs.existsSync(objectDirectory), tmpdir: os.tmpdir(),
        tmpdir_present: fs.existsSync(os.tmpdir()),
        inherited: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(?:TMPDIR|TMP|TEMP|GIT_DIR|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_INDEX_FILE|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM)$/.test(key))) };
      throw error;
    }
    git(f.root, ['commit', '-m', 'unusual development paths']);
    f.head = git(f.root, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    const value = prepared(f);
    for (const name of paths) {
      assert.ok(value.prepared.packet.development.paths.includes(name));
      assert.ok(value.prepared.packet.change_metadata.changes.some(change => change.new_path === name && change.classification === 'development'));
    }
  } finally { cleanupJudgment(f); }
});


async function relocatedAggregate(parentName) {
  const f = fixture();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-parent-')));
  const moved = path.join(parent, parentName, 'repo');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(f.root, moved);
  f.root = moved;
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-storage-')));
  const member = canonicalReviewMember(f, true);
  const original = await unitJudgment(f);
  const graphDir = path.join(f.root, '.planning/graph');
  const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
  graph.tickets[member].epic = 'epic/38-codex-arch-review';
  write(f.root, '.planning/graph/tickets.json', JSON.stringify(graph));
  write(f.root, '.planning/phases/38-codex-arch-review/SUMMARY.md', 'Original native obligations remain HOLD.');
  git(f.root, ['switch', '-c', graph.tickets[member].epic]);
  git(f.root, ['add', '.planning']); git(f.root, ['commit', '-m', 'fixture: aggregate evidence']);
  f.head = git(f.root, ['rev-parse', 'HEAD']);
  f.pr.headRefName = graph.tickets[member].epic; f.pr.headRefOid = f.head;
  const dispatch = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const buildRequest = () => dispatch.build(
    ['arch-review', '38-codex-arch-review', '--phase', '38', '--pr', String(f.pr.number), '--runtime', 'codex'],
    { cwd: f.root, graphDir });
  return { f, parent, storage, original, graphDir, buildRequest, member };
}

function cleanupRelocated(c) {
  cleanupJudgment(c.f);
  fs.rmSync(c.storage, { recursive: true, force: true });
  fs.rmSync(c.parent, { recursive: true, force: true });
}

for (const [label, parentName] of [['plain', 'plain'], ['space', 'with space'], ['non-ASCII', 'répertoire-ü']]) {
  test('aggregate producer builds its repository identity through repositoryIdentity (' + label + ' path)', async () => {
    const architecture = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const c = await relocatedAggregate(parentName);
    try {
      const request = c.buildRequest();
      const requestPath = path.join(c.storage, 'request.json');
      fs.writeFileSync(requestPath, JSON.stringify(request));
      const parsed = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').readRequestFile(requestPath);
      const calls = [];
      const recorder = (...args) => { calls.push(args); return execFileSync(...args); };
      const value = contextBuilder.prepare(parsed.scope, parsed.launch,
        { graphDir: c.graphDir, refreshGit: false, getPullRequest: () => c.f.pr, execFileSync: recorder });
      const identity = architecture.repositoryIdentity(c.f.root);
      assert.ok(calls.some(args => args[0] === 'git' && args[1].includes('--git-common-dir')),
        'the injected runner serves the identity call');
      assert.equal(parsed.scope.ticket, value.prepared.binding.subject);
      const parts = architecture.parseSubject('architecture-review', parsed.scope.ticket);
      assert.ok(JSON.stringify(parts).includes(identity));
      const { normalizeTicketIdentity } = require('../../plugins/delivery-pipeline/scripts/run-contract.cjs');
      assert.equal(normalizeTicketIdentity(parsed.scope.ticket, { role: 'arch-review', phase: 38 }).ticket, parsed.scope.ticket);
    } finally { cleanupRelocated(c); }
  });
}

test('aggregate producer refuses a repository path containing a semicolon at the producer', () => {
  const f = fixture();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-parent-')));
  try {
    const moved = path.join(parent, 'semi;colon', 'repo');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(f.root, moved); f.root = moved;
    assert.throws(() => prepared(f), { code: 'REPOSITORY_IDENTITY_INVALID' });
    const aggregate = contextBuilder.prepare({ ticket: 'phase=38-codex-arch-review;repository=x', phase: 38, worktree: moved },
      { role: 'arch-review', context: {}, signals: {} },
      { graphDir: path.join(moved, '.planning/graph'), refreshGit: false, getPullRequest: () => f.pr });
    assert.fail('unreachable ' + aggregate);
  } catch (error) {
    assert.equal(error.code, 'REPOSITORY_IDENTITY_INVALID');
  } finally { cleanupJudgment(f); fs.rmSync(parent, { recursive: true, force: true }); }
});

test('Codex limits remain INPUT_MAX_BYTES 1048576 bytes and FILE_LIMITS.material 16777216 material bytes', () => {
  assert.equal(contextBuilder.INPUT_MAX_BYTES, 1048576, 'inline and launch bound in bytes');
  assert.equal(contextBuilder.FILE_LIMITS.material, 16777216, 'complete material bound in material bytes');
  assert.equal(contextBuilder.EVIDENCE_MAX_BYTES, 98304, 'evidence bound in bytes');
});

test('exported Codex helpers retain bounded file and receipt behavior', () => {
  const f = fixture();
  try {
    const value = contextBuilder.file(f.root, 'src/reviewed.txt');
    assert.equal(value.content, fs.readFileSync(path.join(f.root, value.path), 'utf8'));
    assert.equal(value.bytes, Buffer.byteLength(value.content), 'file size in bytes');
    assert.equal(contextBuilder.boundedBytes(fs, path.join(f.root, value.path), value.bytes).toString(), value.content);
    assert.throws(() => contextBuilder.boundedBytes(fs, path.join(f.root, value.path), value.bytes - 1), /bound/);
    assert.throws(() => contextBuilder.codexResultText({}), { code: 'MISSING_RECEIPT' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

if (require.main === module) registerTests(require('node:test'));
