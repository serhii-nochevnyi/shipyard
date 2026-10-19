'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const contextBuilder = require('../../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');

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

function planPath() {
  return '.planning/phases/38-codex-arch-review/38-01-PLAN.md';
}

function prepared(f, extra = {}) {
  return contextBuilder.prepare({ ticket: TICKET, phase: 38, worktree: f.reviewRoot || f.root },
    { role: 'arch-review', context: {}, signals: {} }, {
      refreshGit: false, graphDir: path.join(f.root, '.planning/graph'),
      getPullRequest: () => f.pr, ...extra,
    });
}

async function unitJudgment(f, afterLaunch) {
  const ticket = f.ticket || TICKET;
  const worktree = f.reviewRoot || f.root;
  const graphDir = path.join(f.root, '.planning/graph');
  const crypto = require('node:crypto');
  const policy = require('../../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const { createDurableRecorder } = require('../../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const { createCodexDeliveryHost } = require('../../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-arch-unit-')));
  f.storage = storage;
  const builder = require('../../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const request = builder.build(['arch-review', ...(f.phaseName ? [f.phaseName, '--phase', String(f.phase)] : [ticket]), '--runtime', 'codex', '--pr', String(f.pr.number),
    '--graph', graphDir], { cwd: worktree, refreshGit: false, getPullRequest: () => f.pr, defaultBranch: f.pr.baseRefName });
  const requestPath = path.join(storage, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const parsed = require('../../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').readRequestFile(requestPath);
  const { scope, launch } = parsed;
  assert.equal(parsed.graphDir, graphDir);
  const dispatchId = 'unit-focused-' + crypto.randomUUID();
  const value = contextBuilder.prepare(scope, launch, { inflightDispatchId: dispatchId, storageRoot: storage, graphDir: parsed.graphDir,
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
      const judgment = { ...contextBuilder.authenticateFocusedLaunch(launchContext.focused_prepared, launchContext.prompt, {
        ticket, phase: scope.phase, worktree, dispatch_id: launchContext.dispatch_id }),
        review_completeness: 'complete', limitations: [], unresolved_sources: [],
        ...(value.prepared.binding ? { ticket_set: value.prepared.binding.ticketSet,
          ticket_set_digest: value.prepared.binding.membership } : {}),
        id: ticket, pr: f.pr.number, head: value.prepared.canonical.head,
        base_tree: value.prepared.mergeBaseTree, verdict: 'conform', summary: 'Unit adapter judgment',
        findings: [], blocking_count: 0, context_digest: launchContext.focused_prepared.prepared.packet.digest,
        launch_digest: launchContext.prompt.match(/launch_digest=([a-f0-9]{64})/)[1],
        evidence_markdown: 'Complete evidence from the unit adapter.' };
      write(worktree, '.shipyard-arch-review-evidence.md', judgment.evidence_markdown);
      const capture = fs.readFileSync(path.join(__dirname,
        '../../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
        .map(type => structuredClone(capture.find(record => record.type === type)));
      records[0].thread_id = session;
      records[2].item.text = JSON.stringify(judgment);
      records[3].usage.input_tokens = 1;
      records[3].usage.cached_input_tokens = 0;
      records[3].usage.output_tokens = 1;
      if (f.resultAfterCompletion) [records[2], records[3]] = [records[3], records[2]];
      const stream = records.map(x => JSON.stringify(x)).join('\n') + '\n';
      f.originalCodexHome ??= { value: process.env.CODEX_HOME };
      process.env.CODEX_HOME = path.join(storage, 'codex-home');
      const native = focusedNativeSession({ session, worktree, model: selection.model,
        effort: selection.reasoning_effort, text: JSON.stringify(judgment), prompt: launchContext.prompt });
      const now = new Date();
      const nativeDir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
      fs.mkdirSync(nativeDir, { recursive: true });
      fs.writeFileSync(path.join(nativeDir, session + '.jsonl'), native);
      const runtime = require('../../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs')
        .createCodexRuntimeHost({ scope, recorder, capabilities, env: { CODEX_HOME: process.env.CODEX_HOME },
          transcriptDir: path.join(storage, 'runtime-transcripts'),
          probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities },
          spawn() {
            const child = new EventEmitter(); child.pid = process.pid;
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            child.stdin = { write() {}, end() { process.nextTick(() => {
              child.stdout.emit('data', Buffer.from(stream)); child.emit('close', 0);
            }); } };
            return child;
          } });
      const launched = runtime.launchStatic({ model: selection.model, effort: selection.reasoning_effort,
        sandbox_mode: 'read-only', agent_file: file, agent_file_content: content, agent_file_digest: agentDigest },
        launchContext);
      return launched.then(result => {
        transcript = result.runtime_evidence.transcript.path;
        f.transcript = transcript;
        if (afterLaunch) afterLaunch(f);
        return result;
      });
    },
  };
  let relay = '';
  await require('../../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').runCli(
    ['--args-file', requestPath], { write: text => { relay += text; } }, {
      host, capabilities, recorder, agentDir, agentManifest: manifest,
      dispatchId, storageRoot: storage, refreshGit: false, getPullRequest: () => f.pr,
    });
  const result = JSON.parse(relay);
  const validationInput = { worktreePath: worktree, role: 'arch-review', ticket: ticket,
    pr: f.pr.number, base: value.prepared.base, recorder, dispatchId: result.receipt.dispatch_id,
    artifactPath: result.artifact.ref, artifactDigest: result.artifact.digest,
    io: { execFileSync(executable, args, options) {
      if (executable === 'gh') return JSON.stringify(f.pr);
      if (executable === 'git' && args.includes('fetch')) return '';
      return execFileSync(executable, args, options);
    } },
  };
  return { result, value, recorder, transcript, validationInput, scope };
}

function retainedLegacyReviewModules(root, revision = 'b3eab6c12ecebed1b14947fe5e037f93b549c524') {
  const directory = path.join(root, 'retained-original-producer');
  const repository = path.resolve(__dirname, '../../..');
  const files = git(repository, ['ls-tree', '-r', '--name-only', revision, '--',
    'plugins/delivery-pipeline/scripts', 'plugins/delivery-pipeline/references']).split('\n').filter(Boolean);
  assert.ok(files.length > 0, 'retained original producer tree is required');
  for (const file of files) {
    const bytes = execFileSync('git', ['-C', repository, 'show', revision + ':' + file], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(require('node:crypto').createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0'))
      .update(bytes).digest('hex'), git(repository, ['rev-parse', revision + ':' + file]));
    write(directory, file, bytes);
  }
  const load = name => require(path.join(directory, 'plugins/delivery-pipeline/scripts', name + '.cjs'));
  return { collector: load('codex-arch-review-context'), runtime: load('codex-runtime-host'),
    authority: load('role-artifact'), boundary: load('dispatch-boundary'), directory, revision };
}

async function legacyUnitJudgment(f, afterLaunch) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-legacy-producer-')));
  f.legacyProducerRoot = root;
  const revision = 'b3eab6c12ecebed1b14947fe5e037f93b549c524';
  const repository = path.resolve(__dirname, '../../..');
  const names = git(repository, ['ls-tree', '-r', '--name-only', revision, '--',
    'plugins/delivery-pipeline/scripts', 'tests/unit/helpers/codex-arch-review-fixtures.cjs',
    'tests/fixtures/captured/codex-agent-stream-exec.jsonl']).split('\n');
  for (const name of names) {
    const bytes = execFileSync('git', ['-C', repository, 'show', revision + ':' + name], { maxBuffer: 16 * 1024 * 1024 });
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const original = require(path.join(root, 'tests/unit/helpers/codex-arch-review-fixtures.cjs'));
  const result = await original.unitJudgment(f, afterLaunch);
  result.recorder = require('../../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs')
    .createDurableRecorder(path.join(f.storage, 'receipts'));
  result.validationInput.recorder = result.recorder;
  assert.equal(result.result.result.review_contract, undefined);
  assert.equal(result.result.receipt.runtime_evidence.focused_review, undefined);
  return result;
}

function focusedNativeSession({ session, worktree, model, effort, text, prompt }) {
  const capture = fs.readFileSync(path.join(__dirname, '../../fixtures/captured/codex-agent-stream-parent.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const get = predicate => structuredClone(capture.find(predicate));
  const meta = get(row => row.type === 'session_meta');
  Object.assign(meta.payload, { id: session, session_id: session, cwd: worktree, runtime_workspace_roots: [worktree] });
  const context = get(row => row.type === 'turn_context');
  Object.assign(context.payload, { model, effort, cwd: worktree, workspace_roots: [worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model, reasoning_effort: effort });
  const start = get(row => row.payload?.type === 'task_started');
  context.payload.turn_id = start.payload.turn_id;
  const final = get(row => row.type === 'response_item' && row.payload.phase === 'final_answer');
  final.payload.content.forEach(block => { block.text = text; });
  final.payload.internal_chat_message_metadata_passthrough.turn_id = start.payload.turn_id;
  const completion = get(row => row.payload?.type === 'task_complete');
  Object.assign(completion.payload, { turn_id: start.payload.turn_id, last_agent_message: text });
  const user = prompt === undefined ? [] : [get(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user')];
  if (user.length) {
    user[0].payload.content = [{ type: 'input_text', text: prompt }];
    user[0].payload.internal_chat_message_metadata_passthrough.turn_id = start.payload.turn_id;
  }
  return [meta, context, ...user, start, final, completion].map(row => JSON.stringify(row) + '\n').join('');
}

function cleanupJudgment(f) {
  if (f.originalCodexHome) {
    if (f.originalCodexHome.value === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = f.originalCodexHome.value;
  }
  if (fs.existsSync(f.root)) fs.rmSync(require('../../../plugins/delivery-pipeline/scripts/role-artifact.cjs')
    .archiveAuthorityDirectory(f.root), { recursive: true, force: true });
  fs.rmSync(f.root, { recursive: true, force: true });
  if (f.legacyProducerRoot) fs.rmSync(f.legacyProducerRoot, { recursive: true, force: true });
  if (f.storage) fs.rmSync(f.storage, { recursive: true, force: true });
}

function partitionPacket(root, head, { role = 'code-review', diffBytes = 3 * 1024 * 1024, references = [], paddingBytes = 0 } = {}) {
  const packets = require('../../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const line = '+ ' + 'x'.repeat(125) + '\n';
  const content = line.repeat(Math.floor(diffBytes / line.length)) + 'x'.repeat(diffBytes % line.length);
  return packets.buildContextPacket({ root, role, subject: 'partition-fixture', sourceRevision: head,
    policy: policy.POLICY, policyHash: policy.POLICY_HASH, scope: { files_modified: ['src/reviewed.txt'] },
    requiredRefs: references, tokenCeiling: 550000,
    roleContext: { exact_diff: { content }, reference_digest: { bytes: 100 }, focused: {},
      integration_base: 'main', ticket_set: [], plan_acceptance: [], prior_findings: [], padding: 'p'.repeat(paddingBytes),
      adr_refs: [], phase_contracts: [], acceptance_criteria: [] } });
}

function rewriteInputManifest(input, mutate) {
  const manifest = structuredClone(input.manifest);
  mutate(manifest);
  let raw;
  for (let i = 0; i < 10; i++) {
    raw = JSON.stringify(manifest) + '\n';
    if (manifest.accounting.manifest_bytes === Buffer.byteLength(raw)) break;
    manifest.accounting.manifest_bytes = Buffer.byteLength(raw);
  }
  const filename = input.input_bundle.manifest_path;
  fs.chmodSync(filename, 0o600);
  fs.writeFileSync(filename, raw);
  fs.chmodSync(filename, 0o400);
  const stat = fs.statSync(filename);
  return { ...input.input_bundle,
    manifest_sha256: require('node:crypto').createHash('sha256').update(raw).digest('hex'),
    manifest_identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode'].map(key => [key, stat[key]])) };
}

module.exports = { partitionPacket, rewriteInputManifest, retainedLegacyReviewModules, TICKET, BRANCH, ADR, git, write, fixture, planPath, prepared, unitJudgment, legacyUnitJudgment, focusedNativeSession, cleanupJudgment };
