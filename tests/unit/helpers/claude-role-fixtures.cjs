'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const runtimeMarkerNames = ['SHIPYARD_RUNTIME', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
const originalRuntimeMarkers = new Map(runtimeMarkerNames.map(name => [name, process.env[name]]));
for (const name of runtimeMarkerNames) delete process.env[name];
process.on('exit', () => {
  for (const [name, value] of originalRuntimeMarkers) if (value !== undefined) process.env[name] = value;
});

const testAuthorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-authority-')));
const testOriginalHomedir = os.homedir;
os.homedir = () => testAuthorityHome;
process.on('exit', () => { os.homedir = testOriginalHomedir; fs.rmSync(testAuthorityHome, { recursive: true, force: true }); });
const { createDurableRecorder } = require('../../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { REQUEST_SCHEMA } = require('../../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');

const POLICY_MD = '# ADR-014 test\nExplicit model and effort are required.\n';
const PHASE = '38-role-host-test';
const TICKET = 'T-38-01-role-host';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fileSha(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', '..', '..', relative))).digest('hex');
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function planText(extra = []) {
  return [
    '---', 'phase: 38', 'plan: 01', `title: ${JSON.stringify('Test role host')}`, '---', '',
    '## Context', '- Follows ADR-014.', ...extra, '',
    '## Acceptance criteria', '- host authenticates each role result', '',
    '## Verification commands', '- node --test tests/unit/claude-role-host.test.cjs', '',
  ].join('\n');
}

function writeCorpus(root, { adrs = [], backlogFiles = [], investigations = [] } = {}) {
  for (const adr of adrs) write(root, `.planning/architecture/${adr.name}`, adr.content);
  for (const item of backlogFiles) write(root, `.planning/backlog/${item.name}`, item.content);
  for (const item of investigations) write(root, item.path, item.content);
}

function setupRepository(kind, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), options.spaced ? 'shipyard claude role ' : 'shipyard-claude-role-')));
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-role-state-')));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Shipyard Test']);
  git(root, ['config', 'user.email', 'shipyard-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  const planPath = `.planning/phases/${PHASE}/38-01-PLAN.md`;
  const branch = kind === 'arch-review' ? `ticket/${TICKET}` : `epic/${PHASE}`;
  const ticketBranch = `ticket/${TICKET}`;
  const row = {
    title: 'Test role host', plan: planPath, phase: '38', repo: null, wave: 1,
    depends_on: [], cross_phase_deps: [], cross_repo_deps: [], files: ['src/role.txt'],
    risk: 'high', type: 'implementation', human_checkpoint: true, branch,
    pr_base: kind === 'integrator' ? branch : 'main', epic: kind === 'integrator' ? branch : null,
  };
  if (kind === 'integrator') row.branch = ticketBranch;
  write(root, '.planning/architecture/ADR-014-test.md', POLICY_MD);
  write(root, planPath, planText(options.planExtra));
  write(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
  write(root, '.planning/graph/tickets.json', JSON.stringify({ tickets: { [TICKET]: row } }));
  write(root, '.planning/graph/delivery-state.json', JSON.stringify({
    [TICKET]: { status: kind === 'integrator' ? 'merged' : 'pr-open', pr: 101,
      branch: kind === 'integrator' ? ticketBranch : branch, base: kind === 'integrator' ? branch : 'main' },
  }));
  write(root, 'src/role.txt', 'base\n');
  if (options.corpus) writeCorpus(root, options.corpus);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'chore: seed test repository']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  git(root, ['checkout', '-b', branch]);
  write(root, 'src/role.txt', options.sourceContent || 'reviewed change\n');
  git(root, ['add', 'src/role.txt']);
  if (options.planningBytes) {
    write(root, `.planning/phases/${PHASE}/PROJECTION.md`, 'p'.repeat(options.planningBytes));
    git(root, ['add', '.planning']);
  }
  git(root, ['commit', '-m', 'feat: change role source']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const headTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (kind === 'integrator') {
    git(root, ['branch', ticketBranch, head]);
    git(root, ['update-ref', `refs/remotes/origin/${ticketBranch}`, head]);
  } else {
    git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  }
  if (kind === 'integrator') git(root, ['update-ref', `refs/remotes/origin/${branch}`, head]);
  const mergeBase = kind === 'arch-review' ? base : git(root, ['merge-base', 'main', head]);
  const mergeBaseTree = git(root, ['rev-parse', `${mergeBase}^{tree}`]);
  return { root, storageRoot, branch, ticketBranch, prBranch: ticketBranch, base, baseTree, head, headTree, mergeBase, mergeBaseTree, planPath, kind };
}

function livePr(fixture) {
  return {
    number: 101,
    state: fixture.kind === 'integrator' ? 'MERGED' : 'OPEN',
    isDraft: false,
    title: `feat(${TICKET}): change role source`,
    body: `Implements ${TICKET}.`,
    headRefName: fixture.kind === 'integrator' ? fixture.prBranch : fixture.branch,
    headRefOid: fixture.head,
    baseRefName: fixture.kind === 'integrator' ? fixture.branch : 'main',
    baseRefOid: fixture.kind === 'integrator' ? fixture.head : fixture.base,
    mergedAt: fixture.kind === 'integrator' ? '2026-09-23T12:00:00Z' : null,
    mergeCommit: fixture.kind === 'integrator' ? { oid: fixture.head } : null,
    reviewDecision: null,
  };
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

function packetFromPrompt(prompt) {
  const startTag = '<AUTHENTICATED_CONTEXT_PACKET>\n\n';
  const endTag = '\n\n</AUTHENTICATED_CONTEXT_PACKET>';
  const start = prompt.indexOf(startTag);
  const end = prompt.indexOf(endTag, start + startTag.length);
  assert.ok(start >= 0 && end > start);
  const packet = JSON.parse(prompt.slice(start + startTag.length, end));
  return packet.schema === 'shipyard.semantic-content.v1'
    ? require('../../../plugins/delivery-pipeline/scripts/context-packet.cjs').decodeUniqueContent(packet) : packet;
}

function fakeEvidence(model, effort, usage) {
  const sessionId = `session-${crypto.randomUUID()}`;
  const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
  let transcript;
  if (usage) {
    const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`);
    const line = JSON.stringify({ type: 'assistant', sessionId,
      message: { role: 'assistant', id: 'm1', model: observedModel, usage, stop_reason: 'end_turn' } });
    fs.writeFileSync(transcriptPath, `${line}\n`);
    const buffer = fs.readFileSync(transcriptPath);
    transcript = { path: transcriptPath, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  } else {
    transcript = { path: path.join(os.tmpdir(), `${sessionId}.jsonl`), bytes: 64, sha256: 'a'.repeat(64) };
  }
  return {
    launch_id: `claude-${sessionId}`,
    session_id: sessionId,
    process_id: process.pid,
    runtime_version: '2.1.280',
    applied_model: model,
    applied_effort: effort,
    observed_model: observedModel,
    observed_effort: effort,
    selection_evidence: { source: 'claude-session-assistant-transcript', session_id: sessionId,
      assistant_records: 1, model: observedModel, effort, transcript },
    stream_evidence: { format: 'stream-json', records: 1, assistant_messages: 1 },
    transcript,
  };
}

function fakeEvidenceLines(model, effort, lines) {
  const sessionId = `session-${crypto.randomUUID()}`;
  const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
  const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`);
  const text = `${lines.map((line) => JSON.stringify({ sessionId, ...line })).join('\n')}\n`;
  fs.writeFileSync(transcriptPath, text);
  const buffer = fs.readFileSync(transcriptPath);
  const transcript = { path: transcriptPath, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  return {
    launch_id: `claude-${sessionId}`,
    session_id: sessionId,
    process_id: process.pid,
    runtime_version: '2.1.280',
    applied_model: model,
    applied_effort: effort,
    observed_model: observedModel,
    observed_effort: effort,
    selection_evidence: { source: 'claude-session-assistant-transcript', session_id: sessionId,
      assistant_records: lines.length, model: observedModel, effort, transcript },
    stream_evidence: { format: 'stream-json', records: lines.length, assistant_messages: lines.length },
    transcript,
  };
}

function fakeRuntimeFactory(fixture, options = {}) {
  const live = fixture.kind === 'pr-sentinel' ? null : livePr(fixture);
  return ({ scope, controller, recorderDir, transcriptDir, recorder: partitionRecorder }) => {
    const recorder = partitionRecorder || createDurableRecorder(recorderDir);
    const runtime = {
      scope: { worktree: scope.worktree.path },
      controller,
      recorder,
      capabilities: {
        supportedModels: ['claude-opus-5-5', 'claude-fable-5', 'claude-sonnet-5-5'],
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        observedModel: true,
        observedEffort: true,
      },
      async agent(prompt, selection) {
        options.onLaunch?.(prompt, selection);
        const packet = packetFromPrompt(prompt);
        const context = packet.role_context;
        let result;
        let evidencePath;
        if (packet.role === 'code-review' && context.part) {
          result = { part: context.part.id, review_completeness: 'complete', limitations: [], unresolved_sources: [],
            summary: 'Reviewed ' + context.part.paths.join(', '), findings: [] };
        } else if (packet.role === 'code-review') {
          result = { ...context.focused, id: packet.subject, ticket_set: context.ticket_set,
            ticket_set_digest: context.focused.ticket_set_digest,
            context_digest: crypto.createHash('sha256').update(stable(packet)).digest('hex'),
            launch_digest: crypto.createHash('sha256').update(stable({
              packet_digest: crypto.createHash('sha256').update(stable(packet)).digest('hex'),
              reference_digest: context.reference_digest })).digest('hex'),
            review_completeness: 'complete', limitations: [], unresolved_sources: [],
            summary: 'Reviewed the product changes.', findings: [], dispositions: [] };
          result.evidence_markdown = `Reviewed ${fixture.head}; base tree ${fixture.mergeBaseTree}.\n`;
        } else if (packet.role === 'arch-review') {
          result = { ...context.focused, review_completeness: 'complete', limitations: [], unresolved_sources: [],
            context_digest: crypto.createHash('sha256').update(stable(packet)).digest('hex'),
            launch_digest: crypto.createHash('sha256').update(stable({ packet_digest: crypto.createHash('sha256').update(stable(packet)).digest('hex'),
              reference_digest: context.reference_digest })).digest('hex'),
            id: packet.subject, ...(context.ticket_set ? { ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest } : {}), pr: live.number, verdict: 'conform', head: fixture.head,
            base_tree: fixture.mergeBaseTree, blocking_count: 0, summary: 'No architecture conflict.', findings: [] };
          result.evidence_markdown = `Reviewed ${fixture.head}; base tree ${fixture.mergeBaseTree}.\n`;
        } else if (packet.role === 'pr-sentinel') {
          const ticketSet = context.ticket_set;
          const readOnlySmoke = selection.readOnly === true;
          result = {
            outcome: readOnlySmoke ? 'awaiting-human' : 'clear',
            ticket_set: ticketSet,
            ticket_set_digest: context.ticket_set_digest,
            head: fixture.head,
            head_tree: fixture.headTree,
            performed: readOnlySmoke ? [] : ticketSet.map((entry) => ({ ticket: entry.id, duty: 'check-current-front', status: 'complete' })),
            refused: readOnlySmoke ? ticketSet.map((entry) => ({ ticket: entry.id, duty: 'read-only-smoke',
              status: 'refused', reason: 'Read-only runtime smoke.' })) : [],
            blocking_count: readOnlySmoke ? ticketSet.length : 0,
            summary: readOnlySmoke ? 'Read-only runtime smoke; no PR duties were attempted.' : 'All guarded PRs are clear.',
          };
          evidencePath = path.join(fixture.root, '.shipyard-sentinel-evidence.md');
          fs.writeFileSync(evidencePath, `Checked ${ticketSet.length} guarded PRs for this round.\n`);
        } else if (context.part) {
          result = { part: context.part.id, review_completeness: 'complete', limitations: [], unresolved_sources: [],
            summary: 'Reviewed ' + context.part.id, findings: [] };
        } else {
          result = { outcome: 'passed', phase: context.phase, head: context.combined_diff.head,
            head_tree: context.combined_diff.head_tree, base: context.integration_base.ref, base_tree: context.integration_base.tree,
            ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest,
            blocking_count: 0, summary: 'Phase is coherent.', findings: [],
            evidence_markdown: `Integration check at ${context.combined_diff.head}.\n` };
        }
        options.mutateResult?.(result, packet);
        if (options.originalStream) return { output: result };
        const applicationEvidence = options.badEvidence ? fakeEvidence(selection.model, 'low')
          : options.firstResponseLines ? fakeEvidenceLines(selection.model, selection.effort, options.firstResponseLines)
          : fakeEvidence(selection.model, selection.effort, options.firstResponseUsage);
        if (options.corruptDigest && applicationEvidence.transcript) applicationEvidence.transcript.sha256 = 'b'.repeat(64);
        return { output: result, applicationEvidence };
      },
      applicationEvidence({ result }) { return result.applicationEvidence; },
    };
    if (options.originalStream) {
      const claudeRuntime = require('../../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
      const captureStart = require('../../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs').capture;
      const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/captured/boundaries/claude-stream.json')));
      const streamPath = registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
      assert.ok(streamPath, 'registered original Claude stream is required');
      const records = fs.readFileSync(path.resolve(__dirname, '../../..', streamPath), 'utf8').trim().split('\n')
        .map(JSON.parse).filter(record => !record.shipyard_fixture);
      const template = predicate => structuredClone(records.find(predicate));
      const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
      const session = crypto.randomUUID();
      return claudeRuntime.createClaudeRuntimeHost({ scope, controller, recorder, recorderDir, transcriptDir,
        startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
        uuid: () => session, sessionTranscriptRoot: path.join(fixture.storageRoot, 'native'),
        probe: { status: 'available', executable: 'claude-fixture', runtime_version: registry.cli_version,
          capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
        spawn(_file, args) {
          const { EventEmitter } = require('node:events');
          const child = new EventEmitter(); child.pid = process.pid;
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          let framedInput = '';
          child.stdin = { write(value) { framedInput += value; }, end() {
            process.nextTick(async () => {
              try {
                assert.ok(framedInput.endsWith('\n'));
                const userInput = JSON.parse(framedInput.slice(0, -1));
                options.onSpawn?.(args);
                const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
                const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
                const { output } = await runtime.agent(userInput.message.content, { model, effort, ...(args[args.indexOf('--tools') + 1] === 'Read,Write,Glob,Grep' ? { readOnly: true } : {}), schema: JSON.parse(args[args.indexOf('--json-schema') + 1]) });
                const init = template(row => row.type === 'system' && row.subtype === 'init');
                Object.assign(init, { session_id: session, model, cwd: fixture.root });
                const assistant = template(row => row.type === 'assistant');
                assistant.session_id = session; assistant.sessionId = session; assistant.message.model = observedModel;
                if (options.observedTelemetry) {
                  assistant.message.stop_reason = 'end_turn';
                  assistant.message.usage.output_tokens = 113;
                } else delete assistant.message.usage;
                assistant.message.content[0].input = output;
                const final = template(row => row.type === 'result');
                Object.assign(final, { session_id: session, is_error: false, structured_output: output, result: JSON.stringify(output) });
                if (options.observedTelemetry) {
                  const modelUsage = Object.values(final.modelUsage)[0];
                  if (modelUsage.canonicalModel !== undefined) modelUsage.canonicalModel = observedModel;
                  final.modelUsage = { [observedModel]: modelUsage };
                }
                const nativeFile = path.join(fixture.storageRoot, 'native/project', session + '.jsonl');
                fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
                const nativeAssistant = { ...structuredClone(assistant), sessionId: session, effort };
                if (options.nativeAnswerCarrier === 'text') nativeAssistant.message.content = [{ type: 'text', text: JSON.stringify(output) }];
                const nativeRows = [{ ...userInput, sessionId: session }, nativeAssistant];
                options.mutateNativeTranscript?.(nativeRows);
                options.mutateTerminal?.(final);
                if (options.terminalCarrier === 'json') delete final.structured_output;
                if (options.terminalCarrier === 'structured') delete final.result;
                const observationStream = options.observedTelemetry
                  ? [init, ...nativeRows.filter(row => row.type !== 'user').map(row => structuredClone(row)), final] : null;
                options.mutateObservation?.(nativeRows, observationStream, final);
                fs.writeFileSync(nativeFile, serialize(nativeRows));
                const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
                const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
                const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
                captureStart({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
                  transcript_path: nativeFile, cwd: fixture.root }, {
                  evidenceFile: hookValue('--evidence-file'), expectedSession: hookValue('--expected-session') });
                if (options.firstResponseUsage) {
                  assistant.message.usage = options.firstResponseUsage; assistant.message.stop_reason = 'end_turn';
                }
                const usageRecords = options.firstResponseLines
                  ? options.firstResponseLines.map(row => ({ ...structuredClone(row), session_id: session, sessionId: session })) : [assistant];
                child.stdout.emit('data', Buffer.from(serialize(observationStream || [init, ...usageRecords, final]))); child.emit('close', 0, null);
              } catch (error) { child.emit('error', error); }
            });
          } };
          return child;
        } });
    }
    return runtime;
  };
}

function hostOptions(fixture, extra = {}) {
  const pr = livePr(fixture);
  return {
    storageRoot: fixture.storageRoot,
    ...(fixture.graphDir ? { graphDir: fixture.graphDir } : {}),
    refreshGit: false,
    defaultBranch: 'main',
    listPullRequests({ branch, state }) {
      if (fixture.kind === 'pr-sentinel') {
        return state === 'open' ? fixture.sentinelPrs.filter((item) => item.headRefName === branch) : [];
      }
      if (fixture.kind === 'arch-review') return state === 'open' && branch === fixture.branch ? [pr] : [];
      return state === 'closed' && branch === fixture.prBranch ? [pr] : [];
    },
    getPullRequest(input = {}) {
      const number = input.pr;
      if (fixture.kind === 'pr-sentinel') return fixture.sentinelPrs.find((item) => item.number === number);
      return pr;
    },
    preflightRound({ projectWorktree, prs }) {
      const repos = [...new Set(prs.map((item) => item.repo || null))]
        .map((repo) => ({ repo, root: projectWorktree, base: null, base_oid: null }));
      return { repos, synced: true, committed: null };
    },
    createRuntimeHost: fakeRuntimeFactory(fixture, {
      ...(['arch-review', 'code-review'].includes(fixture.kind) && !extra.badEvidence && !extra.corruptDigest ? { originalStream: true } : {}), ...extra }),
  };
}

function cleanupFixture(fixture) {
  if (fixture.partitionHomedir) os.homedir = fixture.partitionHomedir;
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.storageRoot, { recursive: true, force: true });
}

function request(fixture) {
  return fixture.kind === 'arch-review'
    ? { schema: REQUEST_SCHEMA, role: 'arch-review', worktree: fixture.root, ticket: TICKET, pr: 101 }
    : fixture.kind === 'pr-sentinel'
      ? { schema: REQUEST_SCHEMA, role: 'pr-sentinel', worktree: fixture.root, phase: fixture.phase }
    : { schema: REQUEST_SCHEMA, role: 'integrator', worktree: fixture.root, phase: PHASE };
}

function integratorFixture(options = {}) {
  const fixture = setupRepository('integrator');
  if (options.files) {
    for (const file of options.files) write(fixture.root, file, 'changed ' + file + '\n');
    git(fixture.root, ['add', 'src']);
    git(fixture.root, ['commit', '-m', 'feat: more product changes']);
    fixture.head = git(fixture.root, ['rev-parse', 'HEAD']);
    git(fixture.root, ['update-ref', `refs/remotes/origin/${fixture.branch}`, fixture.head]);
  }
  return fixture;
}

function commit(fixture, message) {
  git(fixture.root, ['add', '-A']);
  git(fixture.root, ['commit', '-q', '-m', message]);
  return git(fixture.root, ['rev-parse', 'HEAD']);
}

function ticketRow(fixture, index, branch, base) {
  const plan = `.planning/phases/${PHASE}/38-${String(index).padStart(2, '0')}-PLAN.md`;
  return { id: `T-38-${String(index).padStart(2, '0')}-extra`, plan, row: { title: 'Extra ticket', plan, phase: '38', repo: null, wave: 1,
    depends_on: [], cross_phase_deps: [], cross_repo_deps: [], files: [`src/t${index}.txt`], risk: 'high', type: 'implementation',
    human_checkpoint: true, branch, pr_base: base, epic: fixture.branch } };
}

function recordTickets(fixture, entries) {
  const graphFile = path.join(fixture.root, '.planning/graph/tickets.json'), stateFile = path.join(fixture.root, '.planning/graph/delivery-state.json');
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8')), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const { id, row, pr } of entries) {
    graph.tickets[id] = row;
    state[id] = { status: 'merged', pr: pr.number, branch: row.branch, base: pr.baseRefName };
    write(fixture.root, row.plan, planText());
  }
  write(fixture.root, '.planning/graph/tickets.json', JSON.stringify(graph));
  write(fixture.root, '.planning/graph/delivery-state.json', JSON.stringify(state));
}

function mergedPr(fixture, number, id, branch, base, head, merge) {
  return { ...livePr(fixture), number, title: `feat(${id}): change`, body: `Implements ${id}.`, headRefName: branch,
    headRefOid: head, baseRefName: base, baseRefOid: head, mergeCommit: { oid: merge } };
}

function withPrs(options, prs) {
  return { ...options, listPullRequests: ({ branch, state }) => state === 'closed' ? prs.filter(pr => pr.headRefName === branch) : [],
    getPullRequest: ({ pr }) => prs.find(item => item.number === pr) };
}

function manyTicketFixture(count, bulk = 0) {
  const fixture = setupRepository('integrator');
  const prs = [livePr(fixture)], entries = [];
  for (let index = 2; index <= count; index++) {
    write(fixture.root, `src/t${index}.txt`, `ticket ${index}\n`);
    const oid = commit(fixture, `feat: ticket ${index}`);
    const branch = `ticket/extra-${index}`, { id, row } = ticketRow(fixture, index, branch, fixture.branch);
    const pr = mergedPr(fixture, 100 + index, id, branch, fixture.branch, oid, oid);
    entries.push({ id, row, pr }); prs.push(pr);
  }
  for (let index = 0; index < bulk; index++) write(fixture.root, `src/d${index % 60}/f${index}.txt`, 'x\n');
  recordTickets(fixture, entries);
  fixture.head = commit(fixture, 'feat: bulk and ticket records');
  git(fixture.root, ['update-ref', `refs/remotes/origin/${fixture.branch}`, fixture.head]);
  return { fixture, prs };
}

function stackedFixture(childMerge) {
  const fixture = setupRepository('integrator');
  const epic = fixture.branch, entries = [];
  git(fixture.root, ['checkout', '-q', '-b', 'ticket/p']);
  write(fixture.root, 'src/p.txt', 'parent\n');
  commit(fixture, 'feat: parent');
  git(fixture.root, ['checkout', '-q', '-b', 'ticket/c']);
  write(fixture.root, 'src/c.txt', 'child\n');
  const childHead = commit(fixture, 'feat: child');
  git(fixture.root, ['checkout', '-q', 'ticket/p']);
  git(fixture.root, ['merge', '-q', '--no-ff', 'ticket/c', '-m', 'merge child into parent']);
  const childMergeCommit = git(fixture.root, ['rev-parse', 'HEAD']), parentHead = childMergeCommit;
  git(fixture.root, ['checkout', '-q', epic]);
  git(fixture.root, ['merge', '-q', '--squash', 'ticket/p']);
  const squash = commit(fixture, 'feat: squash parent');
  const parent = ticketRow(fixture, 2, 'ticket/p', epic), child = ticketRow(fixture, 3, 'ticket/c', 'ticket/p');
  const prs = [livePr(fixture), mergedPr(fixture, 102, parent.id, 'ticket/p', epic, parentHead, squash),
    mergedPr(fixture, 103, child.id, 'ticket/c', 'ticket/p', childHead, childMerge?.(childMergeCommit) ?? childMergeCommit)];
  recordTickets(fixture, [{ ...parent, pr: prs[1] }, { ...child, pr: prs[2] }]);
  fixture.head = commit(fixture, 'chore: ticket records');
  git(fixture.root, ['update-ref', `refs/remotes/origin/${epic}`, fixture.head]);
  return { fixture, prs, entries };
}

module.exports = { integratorFixture, commit, ticketRow, recordTickets, mergedPr, withPrs, manyTicketFixture, stackedFixture, PHASE, TICKET, POLICY_MD, git, fileSha, write, planText, writeCorpus, setupRepository, livePr, stable, packetFromPrompt, fakeEvidence, fakeEvidenceLines, fakeRuntimeFactory, hostOptions, cleanupFixture, request };
