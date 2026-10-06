'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  const request = builder.build(['arch-review', ticket, '--runtime', 'codex', '--pr', String(f.pr.number),
    '--graph', graphDir], { cwd: worktree });
  const requestPath = path.join(storage, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const parsed = require('../../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').readRequestFile(requestPath);
  const { scope, launch } = parsed;
  assert.equal(parsed.graphDir, graphDir);
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
      const judgment = { id: ticket, pr: f.pr.number, head: value.prepared.canonical.head,
        base_tree: value.prepared.mergeBaseTree, verdict: 'conform', summary: 'Unit adapter judgment',
        findings: [], blocking_count: 0, context_digest: value.prepared.packet.digest,
        launch_digest: launchContext.prompt.match(/launch_digest=([a-f0-9]{64})/)[1],
        evidence_markdown: 'Complete evidence from the unit adapter.' };
      write(worktree, '.shipyard-arch-review-evidence.md', judgment.evidence_markdown);
      const capture = fs.readFileSync(path.join(__dirname,
        '../../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
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
        worktree: worktree, ticket: ticket, phase: 38,
        transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: hash(stream) } };
      if (afterLaunch) afterLaunch(f);
      return { launch_id: 'codex-' + session, applied_model: selection.model,
        applied_effort: selection.reasoning_effort, observed_model: selection.model,
        observed_effort: selection.reasoning_effort, agent_file_digest: selection.agent_file_digest,
        runtime_evidence: runtimeEvidence };
    },
  };
  let relay = '';
  await require('../../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').runCli(
    ['--args-file', requestPath], { write: text => { relay += text; } }, {
      host, capabilities, recorder, agentDir, agentManifest: manifest,
      storageRoot: storage, refreshGit: false, getPullRequest: () => f.pr,
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

function cleanupJudgment(f) {
  if (fs.existsSync(f.root)) fs.rmSync(require('../../../plugins/delivery-pipeline/scripts/role-artifact.cjs')
    .archiveAuthorityDirectory(f.root), { recursive: true, force: true });
  fs.rmSync(f.root, { recursive: true, force: true });
  if (f.storage) fs.rmSync(f.storage, { recursive: true, force: true });
}

module.exports = { TICKET, BRANCH, ADR, git, write, fixture, planPath, prepared, unitJudgment, cleanupJudgment };
