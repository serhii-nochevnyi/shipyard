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
    assert.equal(result.evidence.input_tokens,
      Math.ceil(Buffer.byteLength(result.launch.context.prompt, 'utf8') / 4));
    assert.ok(result.evidence.input_tokens > 0);
    assert.deepEqual(result.launch.signals, {
      risk: 'high', critical: false, checkpoint: true, contested: true,
      inputTokens: result.evidence.input_tokens,
    });
    assert.match(result.launch.context.prompt, /reviewed implementation change/);
    assert.match(result.launch.context.prompt, /The judge must review the exact live PR diff and this decision/);
    assert(result.evidence.selected_refs.some((ref) => ref.path === planPath()));
    assert(result.evidence.selected_refs.some((ref) => ref.path === '.planning/architecture/ADR-014-host-bound-review.md'));
    assert.equal(Object.isFrozen(result.prepared), true);
    assert.equal(Object.isFrozen(result.prepared.packet.required_refs[0]), true);
    assert.equal(contextBuilder.isPreparedContext({ ...result }), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
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

function guardExcludedArchives(foreignPaths) {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const previous = { openSync: fs.openSync, readFileSync: fs.readFileSync, realpathSync: fs.realpathSync };
  const authority = foreignPaths.map(root => crypto.createHash('sha256').update(root).digest('hex'));
  let deniedReads = 0;
  const check = (file, physical) => {
    if (typeof file !== 'string') return;
    if ((physical && foreignPaths.some(root => file === root || file.startsWith(root + '/')))
        || authority.some(id => file.includes('/role-artifact-authority/' + id))
        || foreignPaths.some(root => file.startsWith(root + '/') && /(?:evidence\.md|findings\.json)$/.test(file))) {
      deniedReads++; throw new Error('Excluded foreign archive was accessed: ' + file);
    }
  };
  fs.openSync = function(file, ...args) { check(file, false); return previous.openSync.call(this, file, ...args); };
  fs.readFileSync = function(file, ...args) { check(file, false); return previous.readFileSync.call(this, file, ...args); };
  fs.realpathSync = function(file, ...args) { check(file, true); return previous.realpathSync.call(this, file, ...args); };
  return () => { Object.assign(fs, previous); return deniedReads; };
}

function registerAggregateRoster(f, original, graphDir, storage) {
  const role = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
  const raw = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json')));
  const binding = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').phaseBinding({ graph,
    state: raw.tickets || raw, phase: 38, repository: git(f.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    branch: f.pr.headRefName, pr: f.pr.number, head: f.head, base: f.base });
  const pins = role.authenticatedArchivePins(f.root);
  const inventory = { rows: [{ worktree: f.root, ticket: TICKET,
    dispatch_id: original.result.receipt.dispatch_id, receipt: original.result.receipt,
    receipt_store: path.join(f.storage, 'receipts'), pins }] };
  const inventoryPath = path.join(storage, 'phase-inventory.json');
  fs.writeFileSync(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
  return role.registerPhaseArchiveRoster({ worktreePath: f.root, binding, graphDir, inventoryPath,
    expectedInventoryDigest: require('node:crypto').createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex') });
}

for (const scenario of [
  { productBytes: 0, name: 'small packet' },
  { productBytes: 2600000, name: 'large packet' },
  { scoped: true, mutation: 'foreign', name: 'foreign bodies preserve current evidence' },
  { scoped: true, mutation: 'bytes', name: 'selected bytes refuse' },
  { scoped: true, mutation: 'membership', name: 'selected membership refuses' },
  { scoped: true, mutation: 'omission', name: 'relabelled current manifest and removed authority refuse before discovery' },
  { scoped: true, mutation: 'family', name: 'removed current family refuses before discovery' },
  { scoped: true, mutation: 'roster', name: 'missing protected roster refuses public aggregate preparation' },
]) test((scenario.scoped ? 'phase-local archive scope: ' : 'fixture: ') +
    'public Codex host seals and consumes a complete aggregate phase architecture verdict (' + scenario.name + ')', async () => {
  const { scoped = false, productBytes = 0, mutation } = scenario;
  let restoreForeignGuard;
  const f = fixture();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-architecture-host-'));
  try {
    const originalTicketReview = await unitJudgment(f);
    const graphDir = path.join(f.root, '.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
    graph.tickets[TICKET].epic = 'epic/38-codex-arch-review';
    if (productBytes) {
      graph.tickets['T-38-02'] = { ...graph.tickets[TICKET], id: 'T-38-02',
        plan: '.planning/phases/38-codex-arch-review/38-02-PLAN.md', branch: 'ticket/T-38-02-corrective',
        depends_on: [TICKET] };
      write(f.root, graph.tickets['T-38-02'].plan, '# Corrective member\nADR-014\n');
    }
    write(f.root, '.planning/graph/tickets.json', JSON.stringify(graph));
    write(f.root, '.planning/phases/38-codex-arch-review/SUMMARY.md', 'Original native obligations remain HOLD.');
    git(f.root, ['switch', '-c', graph.tickets[TICKET].epic]);
    if (productBytes) {
      write(f.root, 'complete-product.txt', 'COMPLETE PRODUCT HUNK\n'.repeat(Math.ceil(productBytes / 21)));
      git(f.root, ['add', 'complete-product.txt']);
    }
    git(f.root, ['add', '.planning']); git(f.root, ['commit', '-m', 'fixture: aggregate evidence']);
    f.head = git(f.root, ['rev-parse', 'HEAD']);
    f.pr.headRefName = graph.tickets[TICKET].epic; f.pr.headRefOid = f.head;
    const request = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs').build(
      ['arch-review', '38-codex-arch-review', '--phase', '38', '--pr', String(f.pr.number), '--runtime', 'codex'],
      { cwd: f.root, graphDir });
    const requestPath = path.join(storage, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify(request));
    const hostModule = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const parsed = hostModule.readRequestFile(requestPath);
    const options = { graphDir, refreshGit: false, getPullRequest: () => f.pr };
    const roster = registerAggregateRoster(f, originalTicketReview, graphDir, storage);
    if (mutation === 'roster') {
      fs.unlinkSync(roster.record_path);
      assert.throws(() => contextBuilder.prepare(parsed.scope, parsed.launch, options),
        { code: 'ARCHIVE_AUTHORITY_REQUIRED', message: /independently retained current phase roster is missing/ });
      return;
    }
    const foreignPaths = [];
    if (scoped) {
      write(f.root, '.shipyard-role-artifacts/foreign-history/.shipyard-role-artifact.json', JSON.stringify({ ticket: 'T-37-01', boundary_subject: 'T-37-01' }));
      write(f.root, '.shipyard-role-artifacts/foreign-history/evidence.md', 'Foreign evidence');
      write(f.root, '.shipyard-role-artifacts/foreign-history/findings.json', 'Foreign findings');
      const foreignRoot = path.join(fs.realpathSync(storage), 'foreign-worktree');
      git(f.root, ['worktree', 'add', '--detach', foreignRoot, 'HEAD']);
      write(foreignRoot, '.shipyard-role-artifacts/foreign-history/.shipyard-role-artifact.json', JSON.stringify({ ticket: 'T-37-01' }));
      write(foreignRoot, '.shipyard-role-artifacts/foreign-history/evidence.md', 'Foreign evidence');
      write(foreignRoot, '.shipyard-role-artifacts/foreign-history/findings.json', 'Foreign findings');
      foreignPaths.push(path.join(f.root, '.shipyard-role-artifacts/foreign-history'), foreignRoot);
      restoreForeignGuard = guardExcludedArchives(foreignPaths);
    }
    if (mutation === 'omission' || mutation === 'family') {
      const manifestPin = roster.records[0].pins.find(pin => pin.path.endsWith('/.shipyard-role-artifact.json'));
      if (mutation === 'omission') {
        write(f.root, manifestPin.path, JSON.stringify({ ticket: 'T-37-01', boundary_subject: 'T-37-01' }));
        fs.unlinkSync(path.join(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').archiveAuthorityDirectory(f.root), 'catalogue.json'));
      } else fs.rmSync(path.dirname(path.join(f.root, manifestPin.path)), { recursive: true });
      assert.throws(() => contextBuilder.prepare(parsed.scope, parsed.launch, options), /selected|catalogue|archive|family|ENOENT/i);
      return;
    }
    let value;
    assert.doesNotThrow(() => { value = contextBuilder.prepare(parsed.scope, parsed.launch, options); });
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'arch-review', signals: value.launch.signals });
    const agentDir = path.join(storage, 'agents'); fs.mkdirSync(agentDir);
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
        const checked = context.input_bundle ? contextBuilder.verifyFileInput(context.input_bundle, { sealed: true }) : null;
        const judgment = { id: request.scope.ticket, pr: f.pr.number, head: f.head,
          ...(checked ? { input_manifest_sha256: context.input_bundle.manifest_sha256, input_material_bytes: context.input_bundle.total_bytes,
            input_asset_count: context.input_bundle.asset_count, input_chunk_reads: checked.chunk_reads } : {}),
          base_tree: value.prepared.mergeBaseTree, verdict: 'conform', summary: 'Unit aggregate judgment.',
          findings: [], blocking_count: 0, ticket_set: value.prepared.binding.ticketSet,
          ticket_set_digest: value.prepared.binding.membership, context_digest: value.prepared.packet.digest,
          launch_digest: context.prompt.match(/launch_digest=([a-f0-9]{64})/)[1], evidence_markdown: 'Complete unit aggregate review.' };
        write(f.root, '.shipyard-arch-review-evidence.md', judgment.evidence_markdown);
        const records = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        const streamRecords = ['thread.started', 'item.completed', 'turn.completed'].map(type => structuredClone(records.find(record => record.type === type)));
        streamRecords[0].thread_id = session; streamRecords[1].item.text = JSON.stringify(judgment);
        const stream = streamRecords.map(record => JSON.stringify(record)).join('\n') + '\n';
        const transcript = path.join(storage, 'transcript.jsonl'); fs.writeFileSync(transcript, stream);
        return { launch_id: 'codex-' + session, applied_model: selection.model, applied_effort: selection.reasoning_effort,
          observed_model: selection.model, observed_effort: selection.reasoning_effort, agent_file_digest: selection.agent_file_digest,
          runtime_evidence: { schema: 'shipyard.codex-runtime-evidence.v1', version: 1, runtime: 'codex', provider: 'openai',
            session_id: session, worktree: f.root, ticket: request.scope.ticket, phase: 38,
            transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: digest(stream) } } };
      } };
    if (productBytes) host = aggregateRuntimeFixture({ host, parsed, storage, capabilities, recorder, selected, text,
      inspect(packet) {
        assert.ok(Buffer.byteLength(packet.diff.content) > 2553952);
        assert.deepEqual(packet.ticket_set, value.prepared.packet.ticket_set);
        assert.equal(packet.ticket_set.length, 2);
        assert.ok(packet.refs.some(ref => ref.path.endsWith('38-02-PLAN.md')));
        assert.deepEqual(packet.refs, value.prepared.packet.refs);
        assert.deepEqual(packet.retained_evidence, value.prepared.packet.retained_evidence);
      } });
    let output = '';
    await hostModule.runCli(['--args-file', requestPath], { write: text => { output += text; } },
      { ...options, host, capabilities, recorder, agentDir, agentManifest, storageRoot: storage });
    const result = JSON.parse(output);
    assert.equal(result.subject, request.scope.ticket);
    assert(value.prepared.packet.retained_evidence.some(item => item.dispatch_id === originalTicketReview.result.receipt.dispatch_id));
    assert.notEqual(result.receipt.dispatch_id, originalTicketReview.result.receipt.dispatch_id);
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const current = { worktreePath: f.root, pr: f.pr.number, head: f.head, headBranch: f.pr.headRefName,
      baseName: 'main', baseCommit: f.base, graphDir };
    assert.equal(artifacts.currentArchitectureVerdict(current).subject, request.scope.ticket);
    if (scoped) {
      assert.equal(value.prepared.packet.retained_evidence.length, 1);
      assert.equal(value.prepared.packet.retained_evidence[0].files.length, 3);
      assert.deepEqual(value.prepared.packet.retained_evidence[0].receipt, originalTicketReview.result.receipt);
      assert.notEqual(JSON.parse(value.prepared.packet.retained_evidence[0].files.find(pin => pin.path.endsWith(artifacts.MANIFEST_NAME)).content).head, f.head);
      const input = { worktreePath: f.root, role: 'arch-review', ticket: request.scope.ticket, pr: f.pr.number,
        base: 'refs/remotes/origin/main', ticketSet: value.prepared.binding.ticketSet,
        ticketSetDigest: value.prepared.binding.membership, boundaryStore: path.join(storage, 'receipts'),
        dispatchId: result.receipt.dispatch_id, artifactPath: result.artifact.ref, artifactDigest: result.artifact.digest };
      const consumer = `const fs=require('node:fs'), cp=require('node:child_process');
        const x=JSON.parse(fs.readFileSync(0,'utf8'));
        const restore=(${guardExcludedArchives.toString()})(x.foreignPaths);
        x.input.io={execFileSync(exe,args,opts){if(exe==='gh')return JSON.stringify(x.pr);
          if(exe==='git'&&args.includes('fetch'))return '';return cp.execFileSync(exe,args,opts);}};
        const role=require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))});
        if(x.verdict) require('node:assert/strict').equal(role.currentArchitectureVerdict(x.current).subject,x.input.ticket);
        else role.validateJudgmentManifest(x.input);
        require('node:assert/strict').equal(restore(),0);`;
      const fresh = verdict => execFileSync(process.execPath, [...testAuthorityArgs, '-e', consumer], {
        input: JSON.stringify({ input, current, pr: f.pr, verdict, foreignPaths }), stdio: ['pipe', 'pipe', 'pipe'] });
      fresh(false); fresh(true);
      const selectedDigest = artifacts.phaseArchitectureEvidenceDigest(value.prepared.packet.retained_evidence);
      if (mutation === 'foreign') {
        for (const foreign of foreignPaths) {
          const family = foreign === foreignPaths[0] ? foreign : path.join(foreign, '.shipyard-role-artifacts/foreign-history');
          fs.appendFileSync(path.join(family, 'evidence.md'), 'changed foreign body');
          fs.appendFileSync(path.join(family, 'findings.json'), 'changed foreign body');
        }
        assert.equal(artifacts.phaseArchitectureEvidenceDigest(artifacts.phaseArchitectureEvidence(f.root, value.prepared.binding,
          { graphDir, phaseArchiveSelection: value.prepared.packet.phase_archive_selection })), selectedDigest);
        fresh(false); fresh(true);
      } else {
        const pin = roster.records[0].pins.find(pin => pin.path.endsWith('/findings.json'));
        if (mutation === 'bytes') fs.appendFileSync(path.join(f.root, pin.path), 'changed selected bytes');
        else fs.writeFileSync(path.join(path.dirname(path.join(f.root, pin.path)), 'unexpected-member'), 'changed selected membership');
        assert.throws(() => fresh(false), /selected|archive|family|pin|membership/i);
        assert.throws(() => fresh(true), /selected|archive|family|pin|membership/i);
        assert.throws(() => artifacts.currentArchitectureVerdict(current), /selected|archive|family|pin|membership/i);
        return;
      }
    }

    if (productBytes) {
      const program = `const assert=require('node:assert/strict'); const c=require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs'))});
        assert.equal(c.currentArchitectureVerdict(JSON.parse(process.argv[1])).subject,${JSON.stringify(request.scope.ticket)});`;
      execFileSync(process.execPath, [...testAuthorityArgs, '-e', program, JSON.stringify(current)]);
      const manifest = JSON.parse(fs.readFileSync(result.receipt.runtime_evidence.input_bundle.manifest_path));
      fs.chmodSync(manifest.assets[0].path, 0o600); fs.appendFileSync(manifest.assets[0].path, 'changed');
      assert.equal(artifacts.currentArchitectureVerdict(current), null);
    }

    assert.equal(artifacts.currentArchitectureVerdict({ ...current, head: 'f'.repeat(40) }), null);
    fs.appendFileSync(path.join(f.root, '.planning/phases/38-codex-arch-review/SUMMARY.md'), '\nChanged evidence.');
    assert.equal(artifacts.currentArchitectureVerdict(current), null);
  } finally {
    if (restoreForeignGuard) assert.equal(restoreForeignGuard(), 0);
    cleanupJudgment(f); fs.rmSync(storage, { recursive: true, force: true });
  }
});

module.exports = { fixture, unitJudgment, cleanupJudgment, registerTests, registerCases, testAuthorityArgs };

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
  try { await assert.rejects(() => unitJudgment(f), /outside a completed native turn/); }
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
    }), /evidence changed before authenticated archival|changed while|grew beyond|changed before/);
    assert(changed);
    const archive = path.join(f.root, '.shipyard-role-artifacts');
    function manifests(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? manifests(path.join(root, entry.name)) : [path.join(root, entry.name)]); }
    if (fs.existsSync(archive)) assert(!manifests(archive).some(file => file.endsWith('manifest.json')));
  } finally { fs.readSync = original; fs.openSync = originalOpen; cleanupJudgment(f); }
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
                /installed launch source changed/);
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

function stableReceiptDigest(receipt) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return require('node:crypto').createHash('sha256').update(JSON.stringify(canonical(receipt))).digest('hex');
}

async function legacyAdmissionFixture(f) {
  const first = await unitJudgment(f);
  const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const admission = { worktreePath: f.root, recorder: first.recorder, dispatchId: first.result.receipt.dispatch_id,
    expectedManifestDigest: first.result.artifact.digest,
    expectedReceiptDigest: stableReceiptDigest(first.result.receipt),
    expectedArchivePins: structuredClone(artifacts.authenticatedArchivePins(f.root)) };
  const preserved = admission.expectedArchivePins.map(pin => ({ ...pin, content: fs.readFileSync(path.join(f.root, pin.path)) }));
  fs.rmSync(artifacts.archiveAuthorityDirectory(f.root), { recursive: true, force: true });
  return { first, artifacts, admission, preserved };
}

test('explicit trusted legacy admission preserves original complete bytes and receipt while permitting later source review', async () => {
  const f = fixture(), stores = [];
  try {
    const { first, artifacts, admission, preserved } = await legacyAdmissionFixture(f); stores.push(f.storage);
    assert.throws(() => artifacts.authenticatedArchivePins(f.root), /lack valid host authority/);
    write(f.root, 'src/reviewed.txt', 'A later source revision requiring a fresh review.');
    git(f.root, ['add', 'src/reviewed.txt']); git(f.root, ['commit', '-m', 'Advance source after historical review']);
    f.head = git(f.root, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    const admitted = artifacts.admitHistoricalArchive(admission);
    assert.equal(admitted.manifest_digest, first.result.artifact.digest);
    for (const pin of preserved) assert.deepEqual(fs.readFileSync(path.join(f.root, pin.path)), pin.content);
    assert.equal(stableReceiptDigest(first.recorder.getVerifiedRecord(admission.dispatchId).receipt), admission.expectedReceiptDigest);
    const second = await unitJudgment(f); stores.push(f.storage);
    assert.equal(second.result.artifact.outcome, 'conform');
    artifacts.validateJudgmentManifest(second.validationInput);
  } finally { cleanupJudgment(f); for (const store of stores) fs.rmSync(store, { recursive: true, force: true }); }
});

for (const [name, mutate] of [
  ['wrong retained manifest digest', (_, x) => { x.admission.expectedManifestDigest = '0'.repeat(64); }],
  ['wrong retained receipt digest', (_, x) => { x.admission.expectedReceiptDigest = '0'.repeat(64); }],
  ['missing original authenticated receipt', (_, x) => { x.admission.dispatchId = 'missing-original-dispatch'; }],
  ['missing complete pin', (_, x) => { x.admission.expectedArchivePins.pop(); }],
  ['unknown archive member', f => write(f.root, '.shipyard-role-artifacts/unknown.json', '{}')],
  ['changed historical complete evidence', (f, x) => {
    const pin = x.admission.expectedArchivePins.find(pin => pin.path.endsWith('.shipyard-arch-review-evidence.md'));
    fs.appendFileSync(path.join(f.root, pin.path), 'Changed old complete bytes');
  }],
]) test('trusted legacy admission refuses ' + name, async () => {
  const f = fixture();
  try {
    const x = await legacyAdmissionFixture(f); mutate(f, x);
    assert.throws(() => x.artifacts.admitHistoricalArchive(x.admission), /archive|historical|retained|receipt|record|pin|manifest/i);
    assert.equal(fs.existsSync(path.join(x.artifacts.archiveAuthorityDirectory(f.root), 'catalogue.json')), false);
    assert(fs.existsSync(x.first.result.artifact.ref));
  } finally { cleanupJudgment(f); }
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

for (const targetKind of ['original native transcript', 'complete reviewer evidence'])
  test(targetKind + ' growth refuses before allocating expanded content', async () => {
    const f = fixture(), open = fs.openSync; let changed = false;
    try {
      await assert.rejects(() => unitJudgment(f, () => {
        fs.openSync = function(file, ...args) {
          const fd = open.call(fs, file, ...args);
          const target = targetKind === 'original native transcript'
            ? String(file) === path.join(f.storage, 'transcript.jsonl') : String(file) === path.join(f.root, '.shipyard-arch-review-evidence.md');
          if (target && !changed) { changed = true; fs.appendFileSync(file, 'unapproved growth'); }
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


for (const targetKind of ['original native transcript', 'complete reviewer evidence'])
  test(targetKind + ' same-byte replacement between original stat and bounded reader refuses', async () => {
    const f = fixture(), lstat = fs.lstatSync; let replaced = false;
    try {
      await assert.rejects(() => unitJudgment(f, () => {
        fs.lstatSync = function(file, ...args) {
          const stat = lstat.call(fs, file, ...args);
          const target = targetKind === 'original native transcript'
            ? String(file) === path.join(f.storage, 'transcript.jsonl') : String(file) === path.join(f.root, '.shipyard-arch-review-evidence.md');
          if (target && !replaced) {
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
    assert.deepEqual(a.role.authenticateArchitectureSources(reviews[0], f.root, first.value.prepared.packet.required_refs.filter(ref => ref.path !== planPath())), first.value.prepared.packet.source_authority);
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

function aggregateRuntimeFixture({ host: fixtureHost, parsed, storage, capabilities, recorder, selected, text, inspect }) {
  const { EventEmitter } = require('node:events');
  const home = path.join(storage, 'native-home');
  return require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').createCodexRuntimeHost({
    scope: parsed.scope, capabilities, recorder, env: { CODEX_HOME: home },
    probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
    transcriptDir: path.join(storage, 'native-streams'),
    spawn(executable, args) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 23001;
      let stdin = '';
      child.stdin = { write(value) { stdin += value; }, end() {
        try {
          assert.ok(stdin.startsWith('Judge the complete authenticated phase.\n\n'));
          const manifestPath = /^INPUT_MANIFEST=(.*)$/m.exec(stdin)[1];
          const manifest = JSON.parse(fs.readFileSync(manifestPath)); const stat = fs.statSync(manifestPath);
          const descriptor = { manifest_path: manifestPath, manifest_sha256: /^INPUT_MANIFEST_SHA256=(.*)$/m.exec(stdin)[1],
            total_bytes: manifest.accounting.material_bytes, asset_count: manifest.assets.length,
            chunk_bytes: manifest.chunk_bytes, max_chunk_reads: manifest.max_chunk_reads,
            manifest_identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode'].map(key => [key, stat[key]])) };
          const checked = contextBuilder.verifyFileInput(descriptor, { sealed: true });
          inspect(JSON.parse(Buffer.concat(checked.material)));
          const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
          const produced = fixtureHost.launchStatic({ model: selected.model, reasoning_effort: selected.effort,
            agent_file_digest: digest(text) }, { prompt: stdin, input_bundle: descriptor });
          const session = produced.runtime_evidence.session_id;
          const parent = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-parent.jsonl'), 'utf8')
            .split('\n').filter(line => line && !line.startsWith('{"shipyard_fixture"')).map(line => {
              const record = JSON.parse(line.replaceAll('<SESSION-2>', session));
              if (record.type === 'turn_context') Object.assign(record.payload, { model: selected.model, effort: selected.effort });
              return record;
            });
          const assets = [{ path: manifestPath, bytes: checked.manifest_bytes },
            ...manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))];
          const response = parent.find(record => record.type === 'response_item');
          const wrap = payload => ({ ...structuredClone(response), payload });
          const reads = [];
          let ordinal = 0;
          for (const asset of assets) for (let index = 0; index < Math.ceil(asset.bytes.length / manifest.chunk_bytes); index++) {
            const callId = 'fixture-read-' + ordinal++;
            reads.push(wrap({ type: 'function_call', name: 'exec_command', call_id: callId,
              arguments: JSON.stringify({ cmd: "dd if='" + asset.path + "' bs=" + manifest.chunk_bytes + ' skip=' + index + ' count=1 2>/dev/null | base64' }) }),
            wrap({ type: 'function_call_output', call_id: callId,
              output: JSON.stringify({ exit_code: 0, output: asset.bytes.subarray(index * manifest.chunk_bytes, (index + 1) * manifest.chunk_bytes).toString('base64') }) }));
          }
          const resultText = fs.readFileSync(produced.runtime_evidence.transcript.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(record => record.item?.type === 'agent_message').item.text;
          for (const record of parent) if (record.payload?.type === 'task_complete') record.payload.last_agent_message = resultText;
          for (const record of parent) if (record.payload?.type === 'message' && record.payload.phase === 'final_answer') record.payload.content.forEach(block => { block.text = resultText; });
          parent.splice(parent.findIndex(record => (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
            || (record.payload?.type === 'item_completed' && record.payload.item?.phase === 'final_answer')), 0, ...reads);
          const now = new Date();
          const directory = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'rollout-' + session + '.jsonl'), parent.map(record => JSON.stringify(record)).join('\n') + '\n');
          process.nextTick(() => { child.stdout.emit('data', fs.readFileSync(produced.runtime_evidence.transcript.path)); child.emit('close', 0, null); });
        } catch (error) { process.nextTick(() => child.emit('error', error)); }
      } };
      return child;
    },
  });
}

function fileInputFixture(material = 'é'.repeat(600000), overrides = {}) {
  const f = fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-input-fixture-')));
  const scope = { worktree: f.root, ticket: TICKET, phase: 38, run_id: 'file-input-run' };
  const options = { role: 'integrator', dispatchId: 'original-file-input', storageRoot: storage, ...overrides };
  return { f, storage, scope, options, create: () => contextBuilder.prepareFileInput(scope, material, options),
    clean() { cleanupJudgment(f); fs.rmSync(storage, { recursive: true, force: true }); } };
}

for (const [role, changedPath] of [
  ['integrator', '.planning/phases/38-codex-arch-review/other.md'],
  ['integrator', '.planning/phases/38-codex-arch-review/38-01-PLAN.md'],
  ['integrator', '.planning/architecture/ADR-014-host-bound-review.md'],
  ['integrator', 'src/reviewed.txt'],
  ['arch-review', '.planning/phases/38-codex-arch-review/INTEGRATION.md'],
]) test('integration output authority refuses ' + role + ' mutation of ' + changedPath, () => {
  const f = fileInputFixture(undefined, { role, outputPath: changedPath });
  try {
    const input = f.create();
    write(f.f.root, changedPath, 'unauthorized mutation');
    assert.throws(() => contextBuilder.verifyFileInput(input), /current source or policy changed/);
  } finally { f.clean(); }
});

test('bounded file input retains exact multibyte bytes, full accounting and private preparation authority', () => {
  const f = fileInputFixture();
  try {
    const input = f.create();
    assert.equal(contextBuilder.isPreparedFileInput(input), true);
    assert.equal(contextBuilder.isPreparedFileInput({ ...input }), false);
    assert.throws(() => contextBuilder.verifyFileInput({ ...input }), /private producer authority/);
    const checked = contextBuilder.verifyFileInput(input);
    assert.equal(Buffer.concat(checked.material).length, 1200000);
    assert.equal(Buffer.concat(checked.material).toString(), 'é'.repeat(600000));
    assert.equal(input.inputTokens, Math.ceil(Object.values(checked.manifest.accounting).reduce((sum, bytes) => sum + bytes, 0) / 4));
    assert.equal(checked.chunk_reads, checked.manifest.assets[0].chunk_count + 1);
    assert.equal(checked.manifest.dispatch_id, 'original-file-input');
    assert.ok(checked.manifest.snapshot.sources.some(pin => pin.path === 'development-artifacts.cjs'));
    assert.equal(checked.manifest.snapshot.policy_hash, require('../../plugins/delivery-pipeline/scripts/model-policy.cjs').POLICY_HASH);
    assert.ok(input.input_bundle.total_bytes > Buffer.byteLength(input.prompt));
  } finally { f.clean(); }
});

for (const [name, material, options] of [
  ['material maximum plus one', 'x'.repeat(16 * 1024 * 1024 + 1), {}],
  ['multibyte maximum plus one', 'é'.repeat(8 * 1024 * 1024) + 'x', {}],
  ['invalid UTF-8', Buffer.from([0xc3, 0x28]), {}],
  ['unpaired high surrogate', 'x'.repeat(1048576) + '\ud800', {}],
  ['unpaired low surrogate', '\udc00' + 'x'.repeat(1048576), {}],
  ['asset maximum plus one', Array(2001).fill('x'), {}],
  ['relay maximum plus one', 'x', { relayPrefix: 'x'.repeat(64 * 1024 + 1) }],
]) test('file producer refuses ' + name + ' before publishing a bundle', () => {
  const f = fileInputFixture(material, options);
  try {
    assert.throws(f.create, /bound|UTF-8/);
    assert.deepEqual(fs.readdirSync(f.storage), []);
  } finally { f.clean(); }
});

for (const [name, mutate] of [
  ['asset growth', value => { fs.chmodSync(value.manifest.assets[0].path, 0o600); fs.appendFileSync(value.manifest.assets[0].path, 'x'); }],
  ['asset truncation', value => { fs.chmodSync(value.manifest.assets[0].path, 0o600); fs.truncateSync(value.manifest.assets[0].path, 1); }],
  ['same-byte replacement', value => { const file = value.manifest.assets[0].path; const raw = fs.readFileSync(file); fs.unlinkSync(file); fs.writeFileSync(file, raw, { mode: 0o400 }); }],
  ['symlink leaf', value => { const file = value.manifest.assets[0].path; fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }],
  ['public leaf mode', value => fs.chmodSync(value.manifest.assets[0].path, 0o644)],
  ['public directory mode', value => fs.chmodSync(path.dirname(value.input_bundle.manifest_path), 0o755)],
  ['missing asset', value => fs.unlinkSync(value.manifest.assets[0].path)],
  ['manifest replacement', value => { const file = value.input_bundle.manifest_path; const raw = fs.readFileSync(file); fs.unlinkSync(file); fs.writeFileSync(file, raw, { mode: 0o400 }); }],
]) test('private file admission refuses ' + name, () => {
  const f = fileInputFixture();
  try { const value = f.create(); mutate(value); assert.throws(() => contextBuilder.verifyFileInput(value), /changed|private|trusted|ENOENT|symlink|bounded/); }
  finally { f.clean(); }
});

for (const [name, mutate] of [
  ['head', f => git(f.f.root, ['commit', '--allow-empty', '-m', 'moved head'])],
  ['member inventory', f => write(f.f.root, '.planning/graph/tickets.json', '{}')],
  ['configuration', f => write(f.f.root, '.planning/config.json', '{"changed":true}')],
  ['live product', f => write(f.f.root, 'product-new.cjs', 'changed')],
  ['live plan', f => write(f.f.root, '.planning/phases/new-PLAN.md', 'changed')],
  ['live architecture', f => write(f.f.root, '.planning/architecture/new.md', 'changed')],
]) test('fresh file consumer refuses current ' + name + ' drift despite the original immutable manifest', () => {
  const f = fileInputFixture();
  try {
    const value = f.create();
    const descriptorFile = path.join(f.storage, 'descriptor.json'); fs.writeFileSync(descriptorFile, JSON.stringify(value.input_bundle));
    mutate(f);
    const program = `const assert=require('node:assert/strict');const fs=require('node:fs');
      const c=require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))});
      assert.throws(()=>c.verifyFileInput(JSON.parse(fs.readFileSync(process.argv[1])),{sealed:true}),/current source or policy changed/);`;
    execFileSync(process.execPath, ['-e', program, descriptorFile]);
  } finally { f.clean(); }
});

test('file bundle binds original run, role, dispatch and installed instructions', () => {
  const f = fileInputFixture();
  try {
    const value = f.create();
    for (const field of ['run_id', 'role', 'dispatch_id', 'ticket']) assert.throws(() => contextBuilder.verifyFileInput(value, {
      association: { [field]: 'foreign' },
    }), /original launch identity/);
  } finally { f.clean(); }
});

for (const [name, mutate] of [
  ['reordered assets', manifest => manifest.assets.reverse()],
  ['duplicate ordinal', manifest => { manifest.assets[1].ordinal = 0; }],
  ['missing asset row', manifest => { manifest.assets.pop(); }],
  ['wrong chunk count', manifest => { manifest.assets[0].chunk_count++; }],
  ['exhausted budget', manifest => { manifest.max_chunk_reads = 2065; }],
  ['wrong material accounting', manifest => { manifest.accounting.material_bytes++; }],
]) test('fresh structural consumer refuses ' + name + ' even with a self-consistent descriptor hash', () => {
  const f = fileInputFixture(['first', 'second']);
  try {
    const value = f.create();
    const manifest = JSON.parse(fs.readFileSync(value.input_bundle.manifest_path)); mutate(manifest);
    let raw;
    for (let i = 0; i < 10; i++) {
      raw = JSON.stringify(manifest) + '\n';
      if (manifest.accounting.manifest_bytes === Buffer.byteLength(raw)) break;
      manifest.accounting.manifest_bytes = Buffer.byteLength(raw);
    }
    fs.chmodSync(value.input_bundle.manifest_path, 0o600);
    fs.writeFileSync(value.input_bundle.manifest_path, raw); fs.chmodSync(value.input_bundle.manifest_path, 0o400);
    const stat = fs.statSync(value.input_bundle.manifest_path);
    const descriptor = { ...value.input_bundle,
      manifest_sha256: require('node:crypto').createHash('sha256').update(raw).digest('hex'),
      manifest_identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode'].map(key => [key, stat[key]])) };
    assert.throws(() => contextBuilder.verifyFileInput(descriptor, { sealed: true }), /inventory|accounting|reordered|asset|budget/);
    assert.throws(() => contextBuilder.verifyFileInput(descriptor), /private producer authority/);
  } finally { f.clean(); }
});



test('file snapshot accepts canonical graph bytes above the input manifest limit', () => {
  const f = fileInputFixture('small');
  try {
    write(f.f.root, '.planning/graph/tickets.json', JSON.stringify({ padding: 'x'.repeat(600000) }));
    assert.doesNotThrow(f.create);
  } finally { f.clean(); }
});

test('selected instruction bytes upgrade a below-limit architecture prompt to authenticated file input', () => {
  const f = fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-fallback-')));
  try {
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR + 'a'.repeat(250000));
    git(f.root, ['add', '-A']); git(f.root, ['commit', '-m', 'large review context']);
    f.head = git(f.root, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    const value = prepared(f, { storageRoot: storage, inflightDispatchId: 'instruction-fallback' });
    assert.ok(Buffer.byteLength(value.launch.context.prompt) < 1048576);
    assert.ok(!contextBuilder.admittedFileInput(value));
    const agents = path.join(storage, 'agents'); fs.mkdirSync(agents);
    write(agents, 'review.toml', ["developer_instructions = '''", 'b'.repeat(900000), "'''", ''].join('\n'));
    write(agents, 'manifest.json', '{}');
    const installation = contextBuilder.admitInstalledLaunch(value, { agentDir: agents, agentFile: 'review.toml',
      agentManifest: path.join(agents, 'manifest.json'), capabilities: {} });
    const input = contextBuilder.admittedFileInput(value);
    assert.ok(input); assert.equal(input.manifest.dispatch_id, 'instruction-fallback');
    assert.ok(input.input_bytes > 1048576);
    assert.equal(installation.capacity.complete_upper_bound_bytes, input.input_bytes);
    assert.ok(input.manifest.accounting.generated_instruction_bytes >= 900000);
    assert.deepEqual(JSON.parse(Buffer.concat(contextBuilder.verifyFileInput(input).material)), value.prepared.packet);
    const directories = fs.readdirSync(storage).filter(name => name.startsWith('input-'));
    const rawManifest = fs.readFileSync(input.input_bundle.manifest_path);
    const admission = { agentDir: agents, agentFile: 'review.toml', agentManifest: path.join(agents, 'manifest.json'), capabilities: {} };
    contextBuilder.admitInstalledLaunch(value, admission);
    assert.strictEqual(contextBuilder.admittedFileInput(value), input);
    assert.deepEqual(fs.readdirSync(storage).filter(name => name.startsWith('input-')), directories);
    assert.deepEqual(fs.readFileSync(input.input_bundle.manifest_path), rawManifest);
    contextBuilder.admitInstalledLaunch(value, { ...admission, capabilities: { changed: true } });
    const variant = contextBuilder.admittedFileInput(value);
    assert.notStrictEqual(variant, input);
    assert.notEqual(variant.input_bundle.manifest_path, input.input_bundle.manifest_path);
    const variantDirectories = fs.readdirSync(storage).filter(name => name.startsWith('input-'));
    contextBuilder.admitInstalledLaunch(value, admission);
    assert.deepEqual(fs.readdirSync(storage).filter(name => name.startsWith('input-')), variantDirectories);
    assert.strictEqual(contextBuilder.admittedFileInput(value), input);
    write(agents, 'other.toml', fs.readFileSync(path.join(agents, 'review.toml'), 'utf8') + '\n# alternate installation');
    contextBuilder.admitInstalledLaunch(value, { ...admission, agentFile: 'other.toml' });
    assert.notStrictEqual(contextBuilder.admittedFileInput(value), input);
    contextBuilder.admitInstalledLaunch(value, admission);
    assert.strictEqual(contextBuilder.admittedFileInput(value), input);
    fs.appendFileSync(path.join(agents, 'review.toml'), '\n# changed instruction');
    assert.throws(() => contextBuilder.admitInstalledLaunch(value, admission), /installed launch source changed|instructions changed/);

  } finally { cleanupJudgment(f); fs.rmSync(storage, { recursive: true, force: true }); }
});



test('complete development inventory preserves Unicode, quotes, tabs and newlines in Git paths', () => {
  const f = fixture();
  try {
    const paths = ['docs/audits/é.md', 'docs/audits/quote".md', 'docs/audits/tab\t.md', 'docs/audits/line\n.md'];
    paths.forEach((name, index) => write(f.root, name, 'development evidence ' + index));
    git(f.root, ['add', '-A']); git(f.root, ['commit', '-m', 'unusual development paths']);
    f.head = git(f.root, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    const value = prepared(f);
    for (const [index, name] of paths.entries()) {
      assert.ok(value.prepared.packet.development.paths.includes(name));
      assert.ok(value.prepared.packet.development.content.includes('development evidence ' + index));
    }
  } finally { cleanupJudgment(f); }
});


{
const { EventEmitter } = require('node:events');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { EFFORTS, createCodexRuntimeHost } = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const SCOPE = {
  run_id: 'run-37-04',
  ticket: 'T-37-04',
  phase: 37,
  worktree: '/tmp/shipyard-t3704',
  runtime: 'codex',
  provider: 'openai',
};

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'],
  supportedEfforts: EFFORTS,
  observedModel: true,
  observedEffort: true,
};

const EXEC_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-exec.jsonl';
const PARENT_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-parent.jsonl';

const PARENT_ID = '01a0e224-6642-7f20-b2a3-68b283d429b9';
const CHILD_ID = '01a0e224-80bb-7d33-b57d-8c44061ac85d';
const CAPTURED_TASK = 'Reply with the single word OK and take no other action.';
const CAPTURED_SHA256 = 'de94a486861cedd3587db16ba051e5c5bf80e0ab05fa44ed50ad48688e6f8b4c';

function captured(rel, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>|<TMP>/g,
      (token) => (values[token] === undefined ? token : JSON.stringify(values[token]).slice(1, -1))))
    .join('\n') + '\n';
}

function stream(session = '11111111-1111-4111-8111-111111111111') {
  return captured(EXEC_FIXTURE, { '<SESSION-1>': session });
}

function sessionTranscript(session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  return transformJsonl(captured(PARENT_FIXTURE, { '<SESSION-2>': session }), (record) => {
    if (record.type === 'session_meta') record.payload.model_provider = provider;
    if (record.type === 'turn_context') Object.assign(record.payload, { model, effort });
    return record;
  });
}

function writeSession(codeHome, session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  const date = new Date();
  const directory = path.join(codeHome, 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'rollout-' + Date.now() + '-' + session + '.jsonl');
  fs.writeFileSync(file, sessionTranscript(session, model, effort, provider));
  return file;
}

function transformJsonl(raw, transform) { return raw.split('\n').filter(Boolean).map(JSON.parse).map(transform).map(JSON.stringify).join('\n') + '\n'; }
function probe() { return { schema: 'shipyard.codex-runtime-probe.v1', version: 1, status: 'available', executable: 'codex', runtime_version: '0.155.1', capabilities }; }
for (const transport of ['function'])
for (const tamper of [null, 'source-drift']) { const materialBytes = 1996419;
test('fixture: ' + transport + ' ' + (tamper || 'complete') + ' ' + materialBytes + '-byte input traverses delivery, static native relay and fresh consumer', async () => {
  const { execFileSync } = require('node:child_process');
  const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const { createCodexDeliveryHost } = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const { codexStaticVariants } = require('../../plugins/delivery-pipeline/scripts/gsd-tune.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'complete-input-fixture-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'complete-input-store-')));
  const scope = { ...SCOPE, worktree: root, run_id: 'complete-input-' + materialBytes };
  const material = 'BEGIN COMPLETE INPUT\n' + 'é'.repeat(Math.floor((materialBytes - 43) / 2))
    + 'x'.repeat((materialBytes - 43) % 2) + '\nEND COMPLETE INPUT!!\n';
  try {
    assert.equal(Buffer.byteLength(material), materialBytes);
    fs.mkdirSync(path.join(root, '.planning/phases/37-integrator'), { recursive: true });
    fs.mkdirSync(path.join(root, '.planning/phases/38-foreign'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning/config.json'), '{}');
    for (const args of [['init', '-q'],
      ['config', '--local', 'user.name', 'Shipyard Test'],
      ['config', '--local', 'user.email', 'shipyard-test@example.invalid'],
      ['add', '-A'], ['commit', '-qm', 'fixture']])
      execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args]);
    const agents = path.join(store, 'agents'); fs.mkdirSync(agents, { mode: 0o700 });
    const variants = codexStaticVariants().filter(value => value.role === 'integrator');
    const agentDigests = {};
    for (const variant of variants) {
      const content = ['# shipyard-policy-id = "' + policy.POLICY.id + '"',
        '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
        '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
        '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "integrator"',
        '# shipyard-policy-rung = "' + variant.rung + '"', 'name = "' + variant.file.replace(/\.toml$/, '') + '"',
        'model = "' + variant.model + '"', 'model_reasoning_effort = "' + variant.effort + '"',
        'sandbox_mode = "workspace-write"', "developer_instructions = '''",
        'GENERATED INTEGRATOR INSTRUCTIONS', "'''", ''].join('\n');
      fs.writeFileSync(path.join(agents, variant.file), content);
      agentDigests[variant.file] = require('node:crypto').createHash('sha256').update(content).digest('hex');
    }
    const agentManifest = path.join(agents, '.shipyard-manifest.json');
    fs.writeFileSync(agentManifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION,
      policy_hash: policy.POLICY_HASH, agent_files: Object.keys(agentDigests), agent_digests: agentDigests }));
    let consumed, stdin, launchedArgs;
    const home = path.join(store, 'codex-home');
    const nativeOptions = { scope, capabilities, env: { CODEX_HOME: home },
      transcriptDir: path.join(store, 'transcripts'), spawn(executable, args) {
        launchedArgs = args;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 24037;
        child.stdin = { write(text) { stdin = text; }, end() {
          try {
            const manifestPath = /^INPUT_MANIFEST=(.*)$/m.exec(stdin)[1];
            const manifest = JSON.parse(fs.readFileSync(manifestPath));
            const bundle = { manifest_path: manifestPath, manifest_sha256: /^INPUT_MANIFEST_SHA256=(.*)$/m.exec(stdin)[1],
              total_bytes: manifest.accounting.material_bytes, asset_count: manifest.assets.length,
              chunk_bytes: manifest.chunk_bytes, max_chunk_reads: manifest.max_chunk_reads,
              manifest_identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode'].map(key => [key, fs.statSync(manifestPath)[key]])) };
            consumed = collector.verifyFileInput(bundle, { sealed: true });
            assert.deepEqual(Buffer.concat(consumed.material), Buffer.from(material));
            const selectedModel = args[args.indexOf('--model') + 1];
            const selectedEffort = args.find(value => value.startsWith('model_reasoning_effort=')).split('"')[1];
            const session = '11111111-1111-4111-8111-111111111111';
            const native = writeSession(home, session, selectedModel, selectedEffort);
            const assets = [{ path: manifestPath, bytes: consumed.manifest_bytes },
              ...manifest.assets.map((asset, index) => ({ path: asset.path, bytes: consumed.material[index] }))];
            const templates = captured(PARENT_FIXTURE).split('\n').filter(Boolean).map(JSON.parse);
            const response = templates.find(record => record.type === 'response_item');
            const wrap = payload => ({ ...structuredClone(response), payload });
            const records = [];
            let ordinal = 0;
            for (const asset of assets) for (let index = 0; index < Math.ceil(asset.bytes.length / manifest.chunk_bytes); index++) {
              const cmd = "dd if='" + asset.path + "' bs=" + manifest.chunk_bytes + ' skip=' + index + ' count=1 2>/dev/null | base64';
              const callId = 'fixture-read-' + ordinal++;
              const encoded = asset.bytes.subarray(index * manifest.chunk_bytes, (index + 1) * manifest.chunk_bytes).toString('base64');
              if (transport === 'custom') records.push(wrap({
                type: 'custom_tool_call', name: 'exec', call_id: callId,
                input: 'text(await tools.exec_command(' + JSON.stringify({ cmd, max_output_tokens: 10000 }) + '));',
              }), wrap({ type: 'custom_tool_call_output', call_id: callId,
                output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' },
                  { type: 'input_text', text: JSON.stringify({ chunk_id: callId, wall_time_seconds: 0.1,
                    exit_code: 0, output: encoded }) }],
              }));
              else records.push(wrap({ type: 'function_call', name: 'exec_command', call_id: callId,
                arguments: JSON.stringify({ cmd }) }), wrap({ type: 'function_call_output', call_id: callId,
                output: JSON.stringify({ exit_code: 0, output: encoded }) }));
            }
            if (tamper === 'missing-read') records.pop();
            if (tamper === 'unsafe-wrapper') records[0].payload.input += '\ntext("untrusted extra statement");';
            if (tamper === 'failed-read' || tamper === 'surplus-output') {
              if (transport === 'custom') {
                const block = records.at(-1).payload.output[1];
                const captured = JSON.parse(block.text);
                block.text = JSON.stringify(tamper === 'failed-read'
                  ? { ...captured, exit_code: 1 } : { ...captured, output: captured.output + 'AAAA' });
              } else records.at(-1).payload.output = JSON.stringify({
                exit_code: tamper === 'failed-read' ? 1 : 0,
                output: JSON.parse(records.at(-1).payload.output).output + (tamper === 'surplus-output' ? 'AAAA' : ''),
              });
            }
            if (tamper === 'truncated') {
              if (transport === 'custom') {
                const block = records.at(-1).payload.output[1];
                block.text = JSON.stringify({ ...JSON.parse(block.text), output: 'truncated' });
              } else records.at(-1).payload.output = records.at(-1).payload.output.slice(0, 8);
            }
            fs.writeFileSync(path.join(root, tamper ? '.planning/phases/38-foreign/INTEGRATION.md' : '.planning/phases/37-integrator/INTEGRATION.md'), 'legitimate integration output');

            const output = transformJsonl(stream(session), record => {
              if (record.type === 'item.completed' && record.item.type === 'agent_message') record.item.text = JSON.stringify({
                input_manifest_sha256: tamper === 'wrong-echo' ? 'f'.repeat(64) : bundle.manifest_sha256,
                input_material_bytes: bundle.total_bytes, input_asset_count: bundle.asset_count, input_chunk_reads: consumed.chunk_reads,
              });
              return record;
            });
            const resultText = output.split('\n').filter(Boolean).map(JSON.parse).find(record => record.item?.type === 'agent_message').item.text;
            const parentRecords = fs.readFileSync(native, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
            for (const record of parentRecords) if (record.payload?.type === 'task_complete') record.payload.last_agent_message = tamper === 'foreign-completion' ? 'foreign result' : resultText;
            for (const record of parentRecords) if (record.payload?.type === 'message' && record.payload.phase === 'final_answer') record.payload.content.forEach(block => { block.text = resultText; });
            const boundary = parentRecords.findIndex(record => (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
              || (record.payload?.type === 'item_completed' && record.payload.item?.phase === 'final_answer'));
            parentRecords.splice(tamper === 'after-complete' ? parentRecords.length : boundary, 0, ...records);
            fs.writeFileSync(native, parentRecords.map(JSON.stringify).join('\n') + '\n');
            process.nextTick(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0, null); });
          } catch (error) { process.nextTick(() => child.emit('error', error)); }
        } };
        return child;
      } };
    const host = createCodexRuntimeHost({ ...nativeOptions, probe: probe(),
      recorderDir: path.join(store, 'receipts') });
    const run = () => createCodexDeliveryHost({ scope, host, agentDir: agents, agentManifest, storageRoot: store })
      .run({ role: 'integrator', context: { prompt: material }, dispatch_id: 'complete-input-dispatch' });
    if (tamper) {
      await assert.rejects(run, error => tamper === 'source-drift'
        ? error.code === 'RUNTIME_EVIDENCE_INVALID' && /current source or policy changed/.test(error.message)
        : ['RUNTIME_EVIDENCE_MISMATCH', 'STALE_CONTEXT'].includes(error.code));
      assert.equal(host.recorder.getVerifiedRecord('complete-input-dispatch'), null);
      return;
    }
    let result;
    await assert.doesNotReject(async () => { result = await run(); },
      'complete input must traverse the supported ' + transport + ' tool ABI');
    assert.ok(stdin.startsWith('GENERATED INTEGRATOR INSTRUCTIONS\n\n'));
    assert.ok(Buffer.byteLength(stdin) < collector.FILE_LIMITS.relay + 100);
    assert.equal(result.receipt.runtime_evidence.input_transport, 'host-files');
    const accounting = result.receipt.runtime_evidence.input_accounting;
    assert.equal(accounting.material_bytes, materialBytes);
    assert.equal(accounting.generated_instruction_bytes, Buffer.byteLength('GENERATED INTEGRATOR INSTRUCTIONS\n\n'));
    assert.equal(result.signals.inputTokens, Math.ceil(Object.values(accounting).reduce((sum, bytes) => sum + bytes, 0) / 4));
    assert.equal(launchedArgs[launchedArgs.indexOf('--model') + 1], result.receipt.applied_model);
    const descriptor = result.receipt.runtime_evidence.input_bundle;
    const inputFile = path.join(store, 'fresh-input.json'); fs.writeFileSync(inputFile, JSON.stringify(descriptor));
    const output = execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))});
      const fs=require('node:fs'); const v=c.verifyFileInput(JSON.parse(fs.readFileSync(process.argv[1])),{sealed:true});
      process.stdout.write(require('node:crypto').createHash('sha256').update(Buffer.concat(v.material)).digest('hex'));`, inputFile], { encoding: 'utf8' });
    assert.equal(output, require('node:crypto').createHash('sha256').update(material).digest('hex'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});

}

}

if (require.main === module) registerTests(require('node:test'));
