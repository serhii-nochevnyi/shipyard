'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const contextBuilder = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');

const TICKET = 'T-38-01-role-host';
const BRANCH = `ticket/${TICKET}`;
const ADR = '# ADR-014: Host-bound architecture review\nThe judge must review the exact live PR diff and this decision.\n';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-arch-review-')));
  const plan = '.planning/phases/38-codex-arch-review/38-01-PLAN.md';
  const row = {
    title: 'Codex host-built architecture review', plan, phase: '38', repo: null, wave: 1,
    depends_on: [], cross_phase_deps: [], cross_repo_deps: [], files: ['src/reviewed.txt'],
    risk: 'high', type: 'implementation', human_checkpoint: true, critical: false,
    branch: BRANCH, pr_base: 'main',
  };
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Shipyard Test']);
  git(root, ['config', 'user.email', 'shipyard-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  write(root, '.planning/architecture/ADR-014-host-bound-review.md', ADR);
  write(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
  write(root, plan, [
    '---', 'phase: 38', 'plan: 01', 'title: "Codex host-built architecture review"', '---', '',
    '## Context', '- Follows ADR-014.', '',
    '## Acceptance criteria', '- Review the authenticated PR diff against ADR-014.', '',
    '## Verification commands', '- node --test tests/unit/codex-arch-review-context.test.cjs', '',
  ].join('\n'));
  write(root, '.planning/graph/tickets.json', JSON.stringify({ tickets: { [TICKET]: row } }));
  write(root, '.planning/graph/delivery-state.json', JSON.stringify({ [TICKET]: { status: 'pr-open', pr: 301 } }));
  write(root, 'src/reviewed.txt', 'base version\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'chore: seed Codex arch-review fixture']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  git(root, ['checkout', '-b', BRANCH]);
  write(root, 'src/reviewed.txt', 'reviewed implementation change\n');
  git(root, ['add', 'src/reviewed.txt']);
  git(root, ['commit', '-m', 'feat: change reviewed source']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const pr = {
    number: 301, state: 'OPEN', isDraft: false,
    title: `feat(${TICKET}): change reviewed source`, body: `Implements ${TICKET}.`,
    headRefName: BRANCH, headRefOid: head, baseRefName: 'main', baseRefOid: base,
    mergedAt: null, mergeCommit: null, reviewDecision: 'CHANGES_REQUESTED',
  };
  return { root, base, head, pr };
}

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

function planPath() {
  return '.planning/phases/38-codex-arch-review/38-01-PLAN.md';
}

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

function prepared(f, extra = {}) {
  return contextBuilder.prepare({ ticket: TICKET, phase: 38, worktree: f.reviewRoot || f.root },
    { role: 'arch-review', context: {}, signals: {} }, {
      refreshGit: false, graphDir: path.join(f.root, '.planning/graph'),
      getPullRequest: () => f.pr, ...extra,
    });
}

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
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', 'x'.repeat(1024 * 1024 + 1));
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

async function unitJudgment(f, afterLaunch) {
  const crypto = require('node:crypto');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const { createCodexDeliveryHost } = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-arch-unit-')));
  f.storage = storage;
  const builder = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const request = builder.build(['arch-review', TICKET, '--runtime', 'codex', '--pr', String(f.pr.number),
    '--graph', path.join(f.root, '.planning/graph')], { cwd: f.root });
  const requestPath = path.join(storage, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const parsed = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').readRequestFile(requestPath);
  const { scope, launch } = parsed;
  assert.equal(parsed.graphDir, path.join(f.root, '.planning/graph'));
  const value = contextBuilder.prepare(scope, launch, { graphDir: parsed.graphDir,
    refreshGit: false, getPullRequest: () => f.pr });
  const selected = policy.resolveDispatch({ runtime: 'codex', role: 'arch-review', signals: value.launch.signals });
  const agentDir = path.join(storage, 'agents');
  fs.mkdirSync(agentDir);
  const file = selected.agent_file;
  const content = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + selected.policy_version + '"',
    '# shipyard-policy-hash = "' + selected.policy_hash + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "arch-review"',
    '# shipyard-policy-rung = "' + selected.rung + '"',
    'name = "' + file.replace(/\.toml$/, '') + '"',
    'model = "' + selected.model + '"',
    'model_reasoning_effort = "' + selected.effort + '"',
    'sandbox_mode = "read-only"',
    "developer_instructions = '''",
    'Judge the supplied authenticated context.' + (f.additionalInstructions || ''),
    "'''", '',
  ].join('\n');
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const agentDigest = hash(content);
  fs.writeFileSync(path.join(agentDir, file), content);
  const manifest = path.join(agentDir, '.shipyard-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ policy_id: policy.POLICY.id,
    policy_version: selected.policy_version, policy_hash: selected.policy_hash,
    agent_files: [file], agent_digests: { [file]: agentDigest } }));
  const recorder = createDurableRecorder(path.join(storage, 'receipts'));
  const capabilities = { supportedModels: [selected.model], supportedEfforts: [selected.effort] };
  contextBuilder.admitInstalledLaunch(value, { agentDir, agentFile: file,
    agentManifest: manifest, capabilities });
  let transcript;
  const host = {
    scope, recorder, capabilities,
    launchStatic(selection, launchContext) {
      const session = crypto.randomUUID();
      const judgment = { id: TICKET, pr: f.pr.number, head: value.prepared.canonical.head,
        base_tree: value.prepared.mergeBaseTree, verdict: 'conform', summary: 'Unit adapter judgment',
        findings: [], blocking_count: 0, context_digest: value.prepared.packet.digest,
        launch_digest: launchContext.prompt.match(/launch_digest=([a-f0-9]{64})/)[1],
        evidence_markdown: 'Complete evidence from the unit adapter.' };
      write(f.root, '.shipyard-arch-review-evidence.md', judgment.evidence_markdown);
      const capture = fs.readFileSync(path.join(__dirname,
        '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      const records = ['thread.started', 'item.completed', 'turn.completed']
        .map(type => structuredClone(capture.find(record => record.type === type)));
      records[0].thread_id = session;
      records[1].item.text = JSON.stringify(judgment);
      records[2].usage.input_tokens = 1;
      records[2].usage.cached_input_tokens = 0;
      records[2].usage.output_tokens = 1;
      if (f.resultAfterCompletion) [records[1], records[2]] = [records[2], records[1]];
      const stream = records.map(x => JSON.stringify(x)).join('\n') + '\n';
      transcript = path.join(storage, 'transcript.jsonl');
      fs.writeFileSync(transcript, stream);
      const runtimeEvidence = { schema: 'shipyard.codex-runtime-evidence.v1', version: 1,
        runtime: 'codex', provider: 'openai', session_id: session,
        worktree: f.root, ticket: TICKET, phase: 38,
        transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: hash(stream) } };
      if (afterLaunch) afterLaunch(f);
      return { launch_id: 'codex-' + session, applied_model: selection.model,
        applied_effort: selection.reasoning_effort, observed_model: selection.model,
        observed_effort: selection.reasoning_effort, agent_file_digest: selection.agent_file_digest,
        runtime_evidence: runtimeEvidence };
    },
  };
  let relay = '';
  await require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').runCli(
    ['--args-file', requestPath], { write: text => { relay += text; } }, {
      host, capabilities, recorder, agentDir, agentManifest: manifest,
      storageRoot: storage, refreshGit: false, getPullRequest: () => f.pr,
    });
  const result = JSON.parse(relay);
  const validationInput = { worktreePath: f.root, role: 'arch-review', ticket: TICKET,
    pr: f.pr.number, base: value.prepared.base, recorder, dispatchId: result.receipt.dispatch_id,
    artifactPath: result.artifact.ref, artifactDigest: result.artifact.digest,
    io: { execFileSync(executable, args, options) {
      if (executable === 'gh') return JSON.stringify(f.pr);
      if (executable === 'git' && args.includes('fetch')) return '';
      return execFileSync(executable, args, options);
    } },
  };
  return { result, value, recorder, transcript, validationInput };
}

function cleanupJudgment(f) {
  fs.rmSync(f.root, { recursive: true, force: true });
  if (f.storage) fs.rmSync(f.storage, { recursive: true, force: true });
}

test('document-relative decision links are collected completely and missing authority refuses', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/investigations/INV-014/DECISIONS.md', 'Complete linked decision.');
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR
      + '[Decision](../investigations/INV-014/DECISIONS.md)\n');
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: link decision']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert(prepared(f).prepared.packet.required_refs.some(ref => ref.content === 'Complete linked decision.'));
    fs.unlinkSync(path.join(f.root, '.planning/investigations/INV-014/DECISIONS.md'));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: remove linked decision']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /ENOENT|missing/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

module.exports = { fixture, unitJudgment, cleanupJudgment };

test('final generated prompt capacity is checked after all complete context is assembled', () => {
  const f = fixture();
  try {
    write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', ADR + 'a'.repeat(400000));
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'fixture: final prompt capacity']);
    f.pr.headRefOid = git(f.root, ['rev-parse', 'HEAD']);
    assert.throws(() => prepared(f), /final review prompt exceeds its bound/);
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
  const f = fixture(); const original = fs.readFileSync; let changed = false;
  try {
    await assert.rejects(() => unitJudgment(f, () => {
      fs.readFileSync = function(file, ...args) {
        const bytes = original.call(this, file, ...args);
        if (!changed && String(file) === path.join(f.root, '.shipyard-arch-review-evidence.md')) {
          changed = true; fs.writeFileSync(file, 'Unauthenticated replacement evidence.');
        }
        return bytes;
      };
    }), /evidence changed before authenticated archival|changed while/);
    assert(changed);
    const archive = path.join(f.root, '.shipyard-role-artifacts');
    function manifests(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? manifests(path.join(root, entry.name)) : [path.join(root, entry.name)]); }
    if (fs.existsSync(archive)) assert(!manifests(archive).some(file => file.endsWith('manifest.json')));
  } finally { fs.readFileSync = original; cleanupJudgment(f); }
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
