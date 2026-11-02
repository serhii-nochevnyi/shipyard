'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');

function createOriginalFixerFixture(context) {
const { captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require } = context;
const __dirname = path.resolve(context.scriptsRoot, '../../../tests/unit');
async function originalFixerFixture(outcome, mutation, evolution = null, historicalRecovery = null) {
  const f = fixture({ physicalPaths: true });
  if (['pending', 'action'].includes(historicalRecovery)) fs.writeFileSync(path.join(f.graphDir, 'delivery-log.jsonl'),
    JSON.stringify({ ts: '2026-10-19T07:31:21.739Z', event: 'status_change', ticket: 'T-999-98',
      from: null, to: 'pending', pr: null }) + '\n');
  const defaultAgents = mutation?.startsWith('normalized-default-') || mutation?.startsWith('normalized-cli-default-');
  const defaultOsHome = mutation?.endsWith('-os-home');
  const home = defaultOsHome ? path.join(fs.realpathSync(temporary), '.codex')
    : path.join(fs.realpathSync(temporary), 'repair-native-' + path.basename(f.root));
  if (defaultAgents) {
    const originalDir = f.agentDir;
    f.agentDir = path.join(home, 'agents');
    fs.mkdirSync(f.agentDir, { recursive: true });
    fs.cpSync(originalDir, f.agentDir, { recursive: true });
    fs.rmSync(originalDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(f.root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('src/owned.txt','utf8'), 'fixed by static native review-fix\\n');\n");
  git(f.root, 'add', 'check.cjs'); git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture: actual candidate verification');
  f.base = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'update-ref', 'refs/heads/main', f.base);
  approvedPlan(f, ['node check.cjs']);
  const verificationAllowList = [{ argv: ['node', 'check.cjs'], profile: 'host', timeout_s: 600 }];
  const agentManifest = agentManifestFor(f.agentDir, 'review-fix');
  const evidenceFile = path.join(f.root, '.shipyard-evidence.md');
  fs.writeFileSync(evidenceFile, 'Complete original review evidence.');
  const boardFile = path.join(f.graphDir, 'delivery-state.json');
  const board = JSON.parse(fs.readFileSync(boardFile)); board['T-38-04'].pr = 501;
  fs.writeFileSync(boardFile, JSON.stringify(board));
  const graphFile = path.join(f.graphDir, 'tickets.json');
  const graph = JSON.parse(fs.readFileSync(graphFile)); graph.tickets[f.scope.ticket].phase = '38';
  fs.writeFileSync(graphFile, JSON.stringify(graph));
  const built = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs').build(['review-fix', f.scope.ticket,
    '--runtime', 'codex', '--pr', '501', '--review-file', evidenceFile, '--graph', f.graphDir], { cwd: f.root });
  f.scope = { ...f.scope, ...built.scope };
  const { scope: _scope, graph_dir: _graph, ...nativeRequest } = built;
  const legacyActions = mutation?.startsWith('companion-cli-legacy-');
  const threadId = legacyActions ? 'PRRT_kwDOTmU9jc6rQN4b' : 'thread-1';
  const commentId = legacyActions ? 'PRRC_kwDOTmU9jc784inG' : 'comment-1';
  const locationMutation = mutation?.includes('-location-');
  const feedback = [{ id: threadId, isResolved: false,
    ...((locationMutation || mutation?.startsWith('issue-')) ? { path: 'src/owned.txt', originalLine: 1616, line: 1653 } : {}) }];
  const originalThreadComment = { id: commentId, body: mutation?.startsWith('issue-') ? '[rule-a] Full original thread comment' : 'Full original thread comment' };
  const output = { schema: 'shipyard.repair-result.v1', id: f.scope.ticket, pr: 501,
    status: outcome === 'source' ? 'fixed' : outcome, pushed: false, notes: 'Complete repair reasoning.',
    hypothesis: 'The source condition explains the original finding.', review_dispositions: [
      { id: threadId, action: outcome === 'no-op' ? 'reply-and-resolve' : 'escalate', reply: 'Retain pending current review.', evidence: { command: 'inspect', result: 'complete source reviewed' } },
      { id: commentId, action: outcome === 'no-op' ? 'reply' : 'escalate', reply: 'Retain this obligation.', evidence: { command: 'inspect', result: 'complete comment reviewed' } },
      { id: 'pr-body-501', action: outcome === 'no-op' ? 'reply' : 'escalate', reply: 'Complete PR body reasoning.', evidence: { command: 'inspect PR', result: 'complete original body evaluated' } },
    ] };
  if (outcome === 'escalate') output.review_dispositions[1].action = 'reply';
  if (mutation?.startsWith('issue-')) for (const item of output.review_dispositions) item.action = 'escalate';
  if (['normalized-source-repeat', 'normalized-cli-source-repeat'].includes(mutation)) {
    for (const disposition of output.review_dispositions) disposition.action = disposition.id === threadId ? 'reply-and-resolve' : 'reply';
  }
  const replies = [], prReplies = [], external = [], reviews = [];
  const actor = legacyActions ? { __typename: 'User', id: 'U_kgDOBacXqA', login: 'serhii-nochevnyi' }
    : { __typename: 'User', id: 'authenticated-host-user', login: 'delivery-host' };
  const originalComments = legacyActions ? Array.from({ length: 3 }, (_, index) =>
    ({ id: 'original-pr-comment-' + index, body: 'Complete original external feedback ' + index })) : [];
  if (legacyActions) {
    output.review_dispositions = [output.review_dispositions[2], ...originalComments.map(comment => ({
      ...structuredClone(output.review_dispositions[2]), id: comment.id })),
    { ...output.review_dispositions[0], action: 'escalate' }, { ...output.review_dispositions[1], action: 'reply',
      reply: 'Launch setup exceptions are covered by the outer failure-retention handler.' }];
  }
  let swapReplyTarget = false, mutateRelation = false;
  let launches = 0, publishedHead = f.base, pushes = 0;
  let relationReads = 0;
  const readOnlyResponses = new Map();
  const live = () => ({ number: mutation === 'foreign-pr' ? 502 : 501, state: mutation === 'closed-pr' ? 'CLOSED' : 'OPEN',
    headRefName: 'ticket/T-38-04', headRefOid: mutation === 'stale-head' ? '1'.repeat(40) : publishedHead,
    baseRefName: 'main', baseRefOid: mutation === 'stale-base' ? '2'.repeat(40) : f.base });
  const gh = (_program, args) => {
    if (_program === 'git' && args[0] === 'push') {
      pushes++; publishedHead = git(f.root, 'rev-parse', 'HEAD');
      if (mutation === 'publication-response-loss' || (historicalRecovery === 'pending' && launches > 1)) throw new Error('Original push response was lost after remote confirmation');
      return 'confirmed host push';
    }
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'fixture/repository' });
    const query = args.find(arg => arg.startsWith('query='));
    if (args[0] === 'pr') return JSON.stringify({ id: 'pr-body-501' });
    const value = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
    const project = comment => ({ ...comment, author: repairAuthorFromQuery(query, comment.author) });
    if (query.includes('viewer{id login}')) return JSON.stringify({ data: { viewer: actor } });
    if (query.includes('addPullRequestReviewThreadReply')) {
      const forgedAuthor = {
        'reply-author-foreign': { ...actor, id: 'foreign-global-user' },
        'reply-author-login': { ...actor, login: 'foreign-login' },
        'reply-author-bot': { ...actor, __typename: 'Bot', id: 'foreign-global-bot' },
        'reply-author-mannequin': { ...actor, __typename: 'Mannequin', id: 'foreign-global-mannequin' },
        'reply-author-organization': { ...actor, __typename: 'Organization', id: 'foreign-global-organization' },
        'reply-author-enterprise': { ...actor, __typename: 'EnterpriseUserAccount', id: 'foreign-global-enterprise' },
        'reply-author-unknown': { ...actor, __typename: 'UnknownActor' },
        'reply-author-null': null,
        'reply-author-missing-id': { __typename: 'User', login: actor.login },
        'reply-author-api-id': { ...actor, id: 12345 },
      };
      const comment = { id: legacyActions && !replies.length ? 'PRRC_kwDOTmU9jc7865lw' : 'reply-' + (replies.length + 1), body: value('body'),
        author: replies.length === 0 && Object.hasOwn(forgedAuthor, mutation) ? forgedAuthor[mutation] : actor }; replies.push(comment);
      if (!reviews.length) reviews.push({ id: legacyActions ? 'PRR_kwDOTmU9jc8AAAABRu8U6g' : 'companion-review-1',
        body: '', state: 'COMMENTED', author: actor });
      if ((mutation === 'thread-response-loss' || mutation === 'companion-cli-response-loss' || mutation === 'companion-cli-legacy-absent'
          || mutation?.startsWith('pending-')) && replies.length === 1) throw new Error('Original accepted thread reply response lost');
      if ((mutation === 'companion-cli-reuse-response-loss' && replies.length === 2)
          || (historicalRecovery === 'action' && launches > 1 && replies.length === 3))
        throw new Error('Original accepted later thread reply response lost');
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment } } });
    }
    if (query.includes('addComment(input:')) {
      const comment = { id: 'pr-reply-' + (prReplies.length + 1), body: value('body'), author: actor }; prReplies.push(comment);
      if (mutation === 'comment-response-loss' && prReplies.length === 1) throw new Error('Original accepted PR reply response lost');
      return JSON.stringify({ data: { addComment: { commentEdge: { node: comment } } } });
    }
    if (query.includes('resolveReviewThread(input:')) { feedback[0].isResolved = true;
      if (mutation === 'resolve-response-loss') throw new Error('Original accepted resolve response lost');
      return JSON.stringify({ data: { resolveReviewThread: { thread: feedback[0] } } }); }
    if (query.includes('{id body title}')) return JSON.stringify({ data: { repository: { pullRequest: { id: 'pr-body-501', body: 'Original complete PR body', title: 'Original PR title' } } } });
    const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    if (query.includes('... on PullRequestReviewComment{')) {
      relationReads++;
      if ((['companion-cli-pending-id', 'companion-cli-legacy-id'].includes(mutation)
          || mutation?.startsWith('companion-cli-refuse-')) && relationReads === 1)
        throw new Error('Original relation query unavailable');
      const reply = replies.find(item => item.id === value('id'));
      const pr = { id: 'pr-body-501', number: 501, repository: { nameWithOwner: 'fixture/repository' } };
      const node = reply && { ...project(reply), replyTo: { id: commentId }, pullRequest: pr,
        pullRequestReview: reviews[0] ? { ...project(reviews[0]), pullRequest: pr } : null };
      const targetComment = [originalThreadComment, ...external, ...replies]
        .find(item => item.id === value('target'));
      const target = targetComment ? { ...project(targetComment), pullRequest: pr,
        replyTo: targetComment.id === commentId ? null : { id: commentId } } : {};
      if (mutation === 'companion-wrong-link') node.pullRequestReview.id = 'foreign-review';
      if (mutation === 'companion-wrong-pr') node.pullRequest.number = 502;
      if (mutation === 'companion-wrong-review-pr') node.pullRequestReview.pullRequest = { ...pr, id: 'foreign-pr' };
      if (mutation === 'companion-wrong-repo') node.pullRequest.repository.nameWithOwner = 'foreign/repository';
      if (mutation === 'companion-wrong-target') node.replyTo.id = 'foreign-comment';
      if (mutation === 'companion-truncated') node.pullRequestReview.body_truncated = true;
      if (['normalized-companion-link', 'normalized-covered-source-companion-link'].includes(mutation) && mutateRelation)
        node.pullRequestReview.id = 'foreign-review';
      return JSON.stringify({ data: { node, target } });
    }
    if (query.includes('node(id:')) {
      if (mutation === 'failed-page') throw new Error('original page unavailable');
      if (mutation === 'disposition-budget') {
        const offset = Number(value('cursor') || 0);
        return JSON.stringify({ data: { node: { comments: {
          nodes: Array.from({ length: 100 }, (_, index) => ({ id: 'bounded-obligation-' + (offset + index), body: 'x' })),
          pageInfo: { hasNextPage: offset + 100 < 2000, endCursor: String(offset + 100) } } } } });
      }
      const comments = [{ ...originalThreadComment, body: mutation === 'overflow' ? 'x'.repeat(600000) : originalThreadComment.body }, ...external, ...(swapReplyTarget ? [] : replies)].map(project);
      if (mutation === 'duplicate-feedback') comments.push(comments[0]);
      if (mutation === 'feedback-movement' && launches) comments.push({ id: 'new-obligation', body: 'New feedback after preparation.' });
      const page = connection(comments);
      if (mutation === 'stalled-pagination') page.pageInfo = { hasNextPage: true, endCursor: 'unchanged-cursor' };
      return JSON.stringify({ data: { node: { comments: page } } });
    }
    const field = query.includes('reviewThreads(') ? 'reviewThreads' : query.includes('reviews(') ? 'reviews' : 'comments';
    if (field === 'reviews' && reviews.length) {
      if (mutation === 'companion-review-body') reviews[0].body = 'New external review finding';
      if (mutation === 'companion-review-state') reviews[0].state = 'CHANGES_REQUESTED';
      if (mutation === 'companion-review-author') reviews[0].author = { ...actor, id: 'foreign-user' };
      if (mutation === 'companion-extra-review' && reviews.length === 1) reviews.push({ ...reviews[0], id: 'unknown-review' });
      if (mutation === 'companion-reuse-extra-review' && replies.length === 2 && reviews.length === 1)
        reviews.push({ ...reviews[0], id: 'unknown-later-review' });
      if (mutation === 'companion-reuse-review-body' && replies.length === 2) reviews[0].body = 'New external finding';
    }
    return JSON.stringify({ data: { repository: { pullRequest: { [field]: connection(field === 'reviewThreads' ? feedback : field === 'comments' ? [...originalComments, ...prReplies, ...(swapReplyTarget ? replies : [])].map(project) : reviews.map(project)) } } } });
  };
  const transport = (program, args, ...rest) => {
    const response = gh(program, args, ...rest);
    if (program === 'gh' && !args.some(arg => arg.startsWith('query=mutation')))
      readOnlyResponses.set(JSON.stringify(args), response);
    return response;
  };
  const originalHome = os.homedir; os.homedir = () => fs.realpathSync(temporary);
  const originalCodexHome = process.env.CODEX_HOME;
  if (defaultOsHome) delete process.env.CODEX_HOME;
  try {
    if (mutation === 'missing-disposition') output.review_dispositions.pop();
    if (mutation === 'missing-schema') delete output.schema;
    if (mutation === 'foreign-schema') output.schema = 'shipyard.repair-result.v2';
    if (mutation === 'extra-result-field') output.accepted = true;
    if (mutation === 'extra-disposition-field') output.review_dispositions[0].resolved = true;
    if (mutation === 'escalate-resolve') output.review_dispositions[0].action = 'reply-and-resolve';
    if (mutation === 'foreign-result') output.id = 'T-38-99';
    if (mutation === 'producer-push') output.pushed = true;
    if (mutation === 'evidence-symlink') { fs.unlinkSync(evidenceFile); fs.symlinkSync(f.plan, evidenceFile); }
    if (mutation === 'evidence-bytes') fs.appendFileSync(evidenceFile, 'changed');
    if (mutation === 'unknown-selector') nativeRequest.context.attempt = 99;
    if (mutation === 'caller-rung') nativeRequest.signals = { signatureState: 'repeat_exhausted' };
    if (mutation === 'caller-first') nativeRequest.signals = { signatureState: 'first' };
    if (mutation === 'caller-new') nativeRequest.signals = { signatureState: 'new' };
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'review-fix' });
    const run = (request = nativeRequest) => {
      const executing = request.role === 'executor';
      const launchRole = executing ? policy.resolveDispatch({ runtime: 'codex', role: 'executor' }) : selected;
      const hostOptions = { ...cliOptions(f), host: undefined, scope: f.scope,
      agentManifest, getPullRequest: live, execFileSync: transport, verification: undefined,
      verificationAllowList, hostVerificationRunner: hostRunner(),
      probe: { status: 'available', executable: 'codex', runtime_version: 'fixture',
        capabilities: { supportedModels: [selected.model], supportedEfforts: ['low', 'high', 'xhigh'] } },
      env: { CODEX_HOME: home },
      spawn(_executable, _args, options) {
        launches++;
        if (defaultOsHome) assert.equal(options.env.CODEX_HOME, undefined);
        const session = crypto.randomUUID();
        const effort = JSON.parse(_args.find(value => value.startsWith('model_reasoning_effort=')).split('=')[1]);
        const applied = { model: _args[_args.indexOf('--model') + 1], effort,
          agent_file: !launchRole.agent_file || effort === 'low' ? launchRole.agent_file
            : launchRole.agent_file.replace('.toml', effort === 'high' ? '-repeat.toml' : '-deep.toml') };
        if (executing) assert.equal(applied.agent_file, null, 'executor uses the original dynamic native launch');
        const final = JSON.stringify(output);
        if (historicalRecovery && !executing && launches > 1) fs.writeFileSync(path.join(f.root, 'outside.txt'), 'Subsequent native source correction.\n');
        if (outcome === 'source' || executing || (historicalRecovery && launches > 1)) fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'fixed by static native review-fix\n');
        if (mutation === 'foreign-dirty') fs.writeFileSync(path.join(f.root, 'outside.txt'), 'foreign mutation');
        if (mutation === 'self-commit') { git(f.root, 'add', 'src/owned.txt'); git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unauthorized producer commit'); }
        if (mutation === 'plan-movement') fs.appendFileSync(f.plan, '\nChanged approved PLAN.');
        if (mutation === 'evidence-completion') fs.appendFileSync(evidenceFile, '\nChanged during native turn.');
        fs.writeFileSync(path.join(f.root, '.shipyard-repair-evidence.md'), 'Complete original producer evidence and dispositions.');
        const capturedRows = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', { '<SESSION-2>': session })
          .trim().split('\n').map(JSON.parse);
        const started = capturedRows.find(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
        const turnId = crypto.randomUUID();
        Object.assign(started.payload, { turn_id: turnId, root_turn_id: turnId });
        const nativeMessage = (role, text, phase) => {
          const row = structuredClone(capturedRows.find(row => row.type === 'response_item'
            && row.payload?.type === 'message' && row.payload.role === role));
          assert.ok(row, 'registered native message template is required');
          row.payload.content = [{ ...row.payload.content[0], text }];
          row.payload.internal_chat_message_metadata_passthrough.turn_id = turnId;
          if (phase) row.payload.phase = phase;
          return row;
        };
        const user = nativeMessage('user', '');
        const instructions = applied.agent_file
          ? require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').generatedInstructions(
            fs.readFileSync(path.join(f.agentDir, applied.agent_file), 'utf8')) : null;
        const rows = [capturedRows.find(row => row.type === 'session_meta'), capturedRows.find(row => row.type === 'turn_context'),
          started, ...(instructions === null ? [] : [nativeMessage('developer', instructions)]), user,
          capturedRows.find(row => row.type === 'response_item' && row.payload?.phase === 'final_answer'),
          capturedRows.find(row => row.type === 'event_msg' && row.payload?.type === 'task_complete')];
        if (mutation === 'native-delegation') {
          const call = structuredClone(capturedRows.find(row => row.type === 'response_item' && row.payload?.type === 'function_call'));
          Object.assign(call.payload, { name: 'spawn_agent', call_id: 'unauthorized-fixer-child', arguments: JSON.stringify({ agent_type: 'executor' }) });
          call.payload.internal_chat_message_metadata_passthrough.turn_id = turnId;
          rows.splice(rows.length - 2, 0, call);
        }
        for (const row of rows) {
          if (row.type === 'session_meta') Object.assign(row.payload, { id: session, session_id: session, cwd: f.root, runtime_workspace_roots: [f.root] });
          if (row.type === 'turn_context') {
            Object.assign(row.payload, { model: applied.model, effort: applied.effort, cwd: f.root, turn_id: turnId });
            row.payload.sandbox_policy = { type: 'workspace-write' };
            if (row.payload.collaboration_mode?.settings) Object.assign(row.payload.collaboration_mode.settings, { model: applied.model, reasoning_effort: applied.effort });
          }
          if (row.payload?.type === 'task_complete') Object.assign(row.payload, { last_agent_message: final, turn_id: turnId });
          if (row.payload?.phase === 'final_answer') {
            row.payload.internal_chat_message_metadata_passthrough.turn_id = turnId;
            row.payload.content.forEach(block => { block.text = final; });
          }
        }
        if (mutation === 'missing-native-completion') rows.pop();
        if (mutation === 'duplicate-native-final') rows.splice(rows.length - 1, 0, structuredClone(rows.at(-2)));
        if (mutation === 'foreign-native-final') rows.at(-2).payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign-turn';
        if (mutation === 'mismatched-native-final') rows.at(-2).payload.content[0].text = 'foreign final JSON';
        const date = new Date();
        const nativeHome = options.env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        const directory = path.join(nativeHome, 'sessions', String(date.getFullYear()),
          String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        fs.mkdirSync(directory, { recursive: true });
        const cli = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session })
          .trim().split('\n').map(JSON.parse);
        for (const row of cli) if (row.item?.type === 'agent_message') row.item.text = final;
        const finalItem = cli.find(row => row.item?.type === 'agent_message');
        const progress = Array.from({ length: 4 }, (_, index) => {
          const row = structuredClone(finalItem);
          Object.assign(row.item, { id: 'progress-' + index, text: 'Original progress ' + index });
          return row;
        });
        cli.splice(cli.findIndex(row => row.item?.type === 'agent_message'), 0, ...progress);
        rows.splice(rows.length - 2, 0, ...progress.map(row => nativeMessage('assistant', row.item.text, 'commentary')));
        if (mutation === 'duplicate-cli-final') {
          const duplicate = structuredClone(finalItem); duplicate.item.id = 'duplicate-final';
          cli.splice(cli.length - 1, 0, duplicate);
        }
        if (mutation === 'foreign-cli-session') {
          const foreign = structuredClone(cli.find(row => row.type === 'thread.started'));
          foreign.thread_id = crypto.randomUUID(); cli.unshift(foreign);
        }
        if (mutation === 'mismatched-cli-final') cli.findLast(row => row.item?.type === 'agent_message').item.text = 'Foreign final';
        if (mutation === 'duplicate-completion') cli.push(structuredClone(cli.find(row => row.type === 'turn.completed')));
        if (mutation === 'missing-completion') cli.splice(cli.findIndex(row => row.type === 'turn.completed'), 1);
        const child = new EventEmitter(); child.pid = 45678;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { write(prompt) {
          if (executing) assert.ok(String(prompt).includes('executor already dispatched'));
          else {
          assert.ok(String(prompt).includes('full feedback') || String(prompt).includes('complete feedback'));
          const required = String(prompt).split('exactly these required fields: ')[1]?.split('. ')[0];
          assert.ok(required, 'the actual generated native prompt must enumerate the complete producer schema');
          for (const field of ['schema', 'id', 'pr', 'status', 'pushed', 'notes', 'hypothesis', 'review_dispositions'])
            assert.match(required, new RegExp('\\b' + field + '\\b'));
          assert.ok(required.includes('schema="shipyard.repair-result.v1"'));
          assert.ok(String(prompt).includes('If status="escalate", every disposition must use reply or escalate'));
          assert.ok(String(prompt).includes('reply-and-resolve is forbidden for ALL findings in that result'));
          }
          user.payload.content = [{ type: 'input_text', text: mutation === 'native-context' ? 'Repair a foreign subject.' : String(prompt).trim() }];
        }, end() {
          process.nextTick(() => {
            fs.writeFileSync(path.join(directory, session + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
            child.stdout.emit('data', Buffer.from(cli.map(JSON.stringify).join('\n') + '\n')); child.emit('close', 0, null);
          });
        } };
        return child;
      },
      };
      if (historicalRecovery === 'admitted' && launches > 0 && !executing) {
        hostOptions.finalizeCommit = () => { throw Object.assign(new Error('Fixture finalizer interruption'), { code: 'SIGNING_FAILED' }); };
      }
      if (defaultAgents) {
        delete hostOptions.agentDir;
        delete hostOptions.agentManifest;
        if (defaultOsHome) hostOptions.env = {};
      }
      if (mutation?.endsWith('-callback')) {
        const storage = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'));
        const actualRuntime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').createCodexRuntimeHost({
          ...hostOptions, recorderDir: path.join(storage, 'receipts'), transcriptDir: path.join(storage, 'transcripts'),
          additionalProtectedPaths: [stateRoot(f), require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').archiveAuthorityDirectory(f.root)],
        });
        hostOptions.host = { ...actualRuntime, launchStatic(selection, context) {
          return actualRuntime.launchStatic(selection, { ...context, onCompleted(completed) {
            if (mutation === 'missing-callback') return;
            if (mutation === 'foreign-callback') context.onCompleted({ ...completed, session_id: crypto.randomUUID() });
            else if (mutation === 'mismatched-callback') context.onCompleted({ ...completed, last_agent_message: 'foreign result' });
            else { context.onCompleted(completed); context.onCompleted(completed); }
          } });
        } };
      }
      if (mutation?.startsWith('normalized-cli-') && launches) {
        const requestFile = path.join(home, 'original-repeat-request.json');
        fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, ...nativeRequest }));
        const written = [];
        return runCli(['--args-file', requestFile], { write(chunk) { written.push(chunk); } }, hostOptions)
          .then(result => { assert.equal(JSON.parse(written.join('')).receipt.dispatch_id, result.receipt.dispatch_id); return result; });
      }
      return createCodexDeliveryHost(hostOptions).run(request);
    };
    if (['thread-response-loss', 'comment-response-loss', 'resolve-response-loss', 'companion-cli-response-loss',
      'companion-cli-pending-id', 'companion-cli-reuse-response-loss', 'companion-cli-legacy-id', 'companion-cli-legacy-absent'].includes(mutation)
        || mutation?.startsWith('pending-') || mutation?.startsWith('companion-cli-refuse-')) {
      await assert.rejects(run, { code: 'REPAIR_FEEDBACK_UNAVAILABLE' });
      const records = fs.readdirSync(path.join(stateRoot(f), 'repair-actions'));
      assert.equal(records.length, 1);
      const dispatchId = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', records[0]))).payload.dispatch_id;
      const recoveryHost = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList });
      if (mutation?.startsWith('companion-cli-refuse-')) {
        const file = path.join(stateRoot(f), 'repair-actions', records[0]);
        if (mutation === 'companion-cli-refuse-head') publishedHead = '3'.repeat(40);
        if (mutation === 'companion-cli-refuse-graph') fs.appendFileSync(graphFile, '\n');
        if (mutation === 'companion-cli-refuse-plan') fs.appendFileSync(f.plan, '\n');
        if (mutation === 'companion-cli-refuse-ledger') {
          const envelope = JSON.parse(fs.readFileSync(file)); envelope.payload.pending.reply_id = 'foreign-reply';
          fs.writeFileSync(file, JSON.stringify(envelope));
        }
        const bytes = fs.readFileSync(file), scopeFile = path.join(home, 'refused-action-scope.json');
        const { runtime: _runtime, provider: _provider, ...scope } = f.scope;
        fs.writeFileSync(scopeFile, JSON.stringify(scope));
        await assert.rejects(() => runCli(['--resume-repair-actions', dispatchId, '--scope-file', scopeFile],
          { write() { throw new Error('refusal cannot produce a success result'); } },
          { ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList }),
        { code: mutation === 'companion-cli-refuse-ledger' ? 'STATE_RECORD_INVALID' : 'REPAIR_SUBJECT_CHANGED' });
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(launches, 1); assert.equal(replies.length, 1); assert.equal(prReplies.length, 0);
        assert.equal(feedback[0].isResolved, false);
        return;
      }
      if (mutation?.startsWith('pending-')) {
        if (mutation === 'pending-duplicate') replies.push({ ...replies[0], id: 'ambiguous-reply' });
        if (mutation === 'pending-author') replies[0].author = { ...actor, id: 'foreign-user' };
        if (mutation === 'pending-body') replies[0].body += ' changed';
        if (mutation === 'pending-target') swapReplyTarget = true;
        if (mutation === 'pending-external') external.push({ id: 'unexpected-external', body: 'complete unknown feedback' });
        if (mutation === 'pending-missing') replies.length = 0;
        const before = replies.length + prReplies.length;
        assert.throws(() => recoveryHost.resumeRepairActions(dispatchId, f.scope), { code: 'REPAIR_ACTION_PENDING' });
        assert.equal(replies.length + prReplies.length, before);
        assert.equal(launches, 1); assert.equal(feedback[0].isResolved, false);
        return;
      }
      let recovered;
      if (mutation?.startsWith('companion-cli-')) {
        const scopeFile = path.join(home, 'original-action-recovery-scope.json');
        const { runtime: _runtime, provider: _provider, ...recoveryScope } = f.scope;
        fs.writeFileSync(scopeFile, JSON.stringify(recoveryScope));
        const writes = [], options = { ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList,
          spawn() { throw new Error('action recovery cannot start another native model'); } };
        const actionFile = path.join(stateRoot(f), 'repair-actions', records[0]);
        const before = JSON.parse(fs.readFileSync(actionFile)).payload;
        assert.equal(before.pending.reply_id !== undefined, ['companion-cli-pending-id', 'companion-cli-legacy-id'].includes(mutation));
        assert.ok(!Object.hasOwn(before.pending, 'reply_review'));
        if (legacyActions) {
          assert.equal(before.confirmed.length, 4);
          assert.ok(before.confirmed.every(action => !Object.hasOwn(action, 'reply_review')));
          assert.equal(before.pending.feedback_id, commentId);
          assert.equal(replies[0].id, 'PRRC_kwDOTmU9jc7865lw');
          assert.equal(reviews[0].id, 'PRR_kwDOTmU9jc8AAAABRu8U6g');
          assert.equal(before.pending.body_sha256, '96715a709acea7e1cd45596690a04924b36a42ea1c6e440f09686ef7461e3dc0');
        }
        const receiptDir = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts');
        const snapshots = fs.readdirSync(receiptDir).filter(file => fs.statSync(path.join(receiptDir, file)).isFile())
          .map(file => [file, fs.readFileSync(path.join(receiptDir, file))]);
        const argv = ['--resume-repair-actions', dispatchId, '--scope-file', scopeFile];
        if (legacyActions) {
          completeRepairFeedback({ execFileSync: transport }, { repo: 'fixture/repository', commit: { worktree: f.root } }, 501);
          const query = 'query($id:ID!,$target:ID!){node(id:$id){... on PullRequestReviewComment{id body author{login ... on Node{id}} '
            + 'replyTo{id} pullRequest{id number repository{nameWithOwner}} '
            + 'pullRequestReview{id body state author{login ... on Node{id}} pullRequest{id number repository{nameWithOwner}}}}} '
            + 'target:node(id:$target){... on PullRequestReviewComment{id body author{login ... on Node{id}} '
            + 'replyTo{id} pullRequest{id number repository{nameWithOwner}}}}}';
          const args = ['api', 'graphql', '-f', 'query=' + query, '-f', 'id=' + replies[0].id, '-f', 'target=' + commentId];
          try { transport('gh', args); } catch { transport('gh', args); }
          const registryFile = path.join(home, 'complete-current-gh-responses.json');
          fs.writeFileSync(registryFile, JSON.stringify({ options: { storageRoot: f.storageRoot, graphDir: f.graphDir,
            verificationAllowList }, live: live(), responses: [...readOnlyResponses], argv, home: fs.realpathSync(temporary) }));
          const script = `const fs = require('node:fs'), os = require('node:os');
            const registry = JSON.parse(fs.readFileSync(process.argv[1])); os.homedir = () => registry.home;
            const host = require(process.argv[2]); const responses = new Map(registry.responses);
            host.runCli(registry.argv, process.stdout, { ...registry.options, getPullRequest: () => registry.live,
              spawn() { throw new Error('cold recovery must not launch'); }, execFileSync(program, args) {
                if (program !== 'gh' || args.some(arg => arg.startsWith('query=mutation')))
                  throw new Error('cold recovery must not replay an action');
                const raw = responses.get(JSON.stringify(args)); if (!raw) throw new Error('uncaptured original read');
                return raw;
              } }).catch(error => { process.stderr.write(error.code + ': ' + error.message); process.exitCode = 1; });`;
          const cold = spawnSync(process.execPath, ['-e', script, registryFile,
            path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs')],
          { encoding: 'utf8', env: process.env, timeout: 30000 });
          assert.equal(cold.status, 0, cold.stderr);
          recovered = JSON.parse(cold.stdout);
        } else {
          recovered = await runCli(argv, { write(chunk) { writes.push(chunk); } }, options);
          assert.deepEqual(JSON.parse(writes.join('')), recovered);
        }
        const confirmed = JSON.parse(fs.readFileSync(actionFile)).payload;
        assert.equal(confirmed.schema, before.schema);
        assert.deepEqual(confirmed.subject, before.subject);
        assert.deepEqual(confirmed.actor, before.actor);
        const threadActions = confirmed.confirmed.filter(action => action.reply_review);
        assert.equal(threadActions[0].reply_review.created, true);
        if (!legacyActions) assert.equal(threadActions[1].reply_review.created, false);
        else assert.deepEqual(confirmed.confirmed.slice(0, 4), before.confirmed);
        assert.equal(confirmed.feedback.inventory.filter(item => item.kind === 'review').length, 1);
        assert.ok(confirmed.feedback.pages.every(page => Number.isInteger(page.count)));
        assert.deepEqual(threadActions[0].reply_review.review, confirmed.feedback.inventory.find(item => item.kind === 'review'));
        const relation = threadActions[0].reply_review;
        assert.equal(relation.sha256, crypto.createHash('sha256').update(relation.response).digest('hex'));
        assert.equal(JSON.parse(relation.response).data.node.pullRequestReview.id, relation.review.id);
        const repeated = await runCli(argv, { write() {} }, options);
        assert.deepEqual(repeated, recovered);
        for (const [file, bytes] of snapshots) assert.deepEqual(fs.readFileSync(path.join(receiptDir, file)), bytes);
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      } else recovered = recoveryHost.resumeRepairActions(dispatchId, f.scope);
      assert.equal(recovered.actions.confirmed.length, legacyActions ? 5 : 3);
      assert.equal(replies.length + prReplies.length, legacyActions ? 5 : 3, 'accepted replies with lost responses are not replayed');
      assert.equal(feedback[0].isResolved, !legacyActions);
      return;
    }
    if (mutation?.startsWith('companion-')) {
      await assert.rejects(run, { code: 'REPAIR_ACTION_PENDING' });
      const laterReply = mutation.startsWith('companion-reuse-');
      assert.equal(launches, 1); assert.equal(replies.length, laterReply ? 2 : 1); assert.equal(prReplies.length, 0);
      assert.equal(feedback[0].isResolved, laterReply);
      const file = fs.readdirSync(path.join(stateRoot(f), 'repair-actions'))[0];
      const pending = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file))).payload;
      assert.equal(pending.pending.reply_id, replies.at(-1).id);
      const bytes = fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file));
      assert.throws(() => createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
        verificationAllowList }).resumeRepairActions(pending.dispatch_id, f.scope), { code: 'REPAIR_ACTION_PENDING' });
      assert.deepEqual(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file)), bytes);
      assert.equal(replies.length, laterReply ? 2 : 1); assert.equal(launches, 1);
      return;
    }
    if (mutation?.startsWith('reply-author-')) {
      await assert.rejects(run, { code: 'REPAIR_ACTION_PENDING' });
      assert.equal(launches, 1); assert.equal(replies.length, 1); assert.equal(prReplies.length, 0);
      assert.equal(feedback[0].isResolved, false);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      const records = fs.readdirSync(path.join(stateRoot(f), 'repair-actions'));
      assert.equal(records.length, 1);
      const dispatchId = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', records[0]))).payload.dispatch_id;
      const recoveryHost = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList });
      assert.throws(() => recoveryHost.resumeRepairActions(dispatchId, f.scope), { code: 'REPAIR_ACTION_PENDING' });
      assert.equal(replies.length, 1); assert.equal(feedback[0].isResolved, false);
      replies[0].author = { ...actor };
      const recovered = recoveryHost.resumeRepairActions(dispatchId, f.scope);
      assert.equal(recovered.actions.confirmed.length, 3);
      assert.equal(replies.length + prReplies.length, 3, 'authenticated recovery confirms the original reply without replay');
      assert.equal(feedback[0].isResolved, true); assert.equal(launches, 1);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      return;
    }
    if (mutation === 'publication-response-loss') {
      await assert.rejects(run, { code: 'REPAIR_PUBLICATION_PENDING' });
      const candidates = fs.readdirSync(path.join(stateRoot(f), 'candidates'));
      assert.equal(candidates.length, 1);
      const recovered = await createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
        verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() })
        .resumeFinalization(candidates[0].replace(/\.json$/, ''), f.scope);
      assert.equal(recovered.idempotent, true);
      assert.equal(recovered.publication.status, 'confirmed');
      assert.equal(recovered.artifact.commit, publishedHead);
      assert.equal(recovered.actions.status, 'confirmed');
      assert.equal(pushes, 1, 'an independently confirmed signed push is never replayed');
      assert.equal(launches, 1);
      return;
    }
    if (mutation?.startsWith('issue-')) {
      if (mutation === 'issue-unknown') feedback[0].line = feedback[0].originalLine = null;
      if (mutation === 'issue-ambiguous') originalThreadComment.body = '[rule-a] rule:other class:conflicting';
      const first = await run();
      assert.equal(first.receipt.applied_effort, 'low');
      const installRung = (suffix, rung, effort) => {
        const file = selected.agent_file.replace('.toml', suffix + '.toml');
        const original = fs.readFileSync(path.join(f.agentDir, selected.agent_file), 'utf8');
        const agent = original.replace('shipyard-policy-rung = "base"', 'shipyard-policy-rung = "' + rung + '"')
          .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "' + effort + '"')
          .replace('name = "' + selected.agent_file.replace('.toml', '') + '"', 'name = "' + file.replace('.toml', '') + '"');
        fs.writeFileSync(path.join(f.agentDir, file), agent);
        const manifest = JSON.parse(fs.readFileSync(agentManifest));
        manifest.agent_files.push(file); manifest.agent_digests[file] = crypto.createHash('sha256').update(agent).digest('hex');
        fs.writeFileSync(agentManifest, JSON.stringify(manifest));
      };
      installRung('-repeat', 'repeat', 'high'); installRung('-deep', 'repeat_exhausted', 'xhigh');
      const repost = (id, rule) => {
        originalThreadComment.id = id;
        originalThreadComment.body = '[' + rule + '] Reposted current finding';
        output.review_dispositions[1].id = id;
      };
      if (mutation === 'issue-shift') feedback[0].line++;
      repost('comment-b', ['issue-repost', 'issue-shift'].includes(mutation) ? 'rule-a' : 'rule-b');
      const second = await run();
      assert.equal(second.receipt.applied_effort, mutation === 'issue-repost' ? 'high' : 'low');
      assert.equal(second.resolution.signals.signatureState, mutation === 'issue-repost' ? 'repeat' : 'first');
      if (['issue-unknown', 'issue-ambiguous', 'issue-shift'].includes(mutation)) {
        assert.equal(second.resolution.signals.signatureState, 'first');
        assert.equal(second.receipt.applied_effort, 'low');
        return;
      }
      if (mutation !== 'issue-repost') {
        repost('comment-a-again', 'rule-a');
        const third = await run();
        assert.equal(third.resolution.signals.signatureState, 'repeat');
        assert.equal(third.receipt.applied_effort, 'high');
        assert.equal(third.resolution.signals.priorApplied.dispatch_id, first.dispatch_id);
        const attempts = fs.readdirSync(path.join(stateRoot(f), 'repair-attempts')).map(file =>
          JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-attempts', file))).payload);
        const originalThird = attempts.find(item => item.dispatch_id === third.dispatch_id);
        const originalSecond = attempts.find(item => item.dispatch_id === second.dispatch_id);
        const secondFile = fs.readdirSync(path.join(stateRoot(f), 'repair-attempts')).find(file =>
          JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-attempts', file))).payload.dispatch_id === second.dispatch_id);
        assert.equal(originalThird.predecessor, secondFile.replace(/\.json$/, ''));
        assert.equal(originalSecond.dispatch_id, second.dispatch_id);
        repost('comment-b-again', 'rule-b');
        assert.equal((await run()).receipt.applied_effort, 'high');
        repost('comment-a-deep', 'rule-a');
        const fifth = await run();
        assert.equal(fifth.resolution.signals.signatureState, 'repeat_exhausted');
        assert.equal(fifth.receipt.applied_effort, 'xhigh');
        assert.equal(fifth.resolution.signals.priorApplied.dispatch_id, third.dispatch_id);
        repost('comment-a-exhausted', 'rule-a');
        await assert.rejects(run, { code: 'REPAIR_POLICY_EXHAUSTED' });
      }
      return;
    }
    if (mutation?.startsWith('normalized-')) {
      const first = await run();
      assert.equal(first.actions.confirmed.length, 3);
      assert.equal(first.resolution.signals.signatureState, 'first');
      const firstReceipt = first.receipt;
      const firstHead = git(f.root, 'rev-parse', 'HEAD');
      const coveredSource = mutation.startsWith('normalized-covered-source');
      let sourceResult;
      let currentHead = firstHead;
      const retainedFiles = fs.readdirSync(path.join(stateRoot(f), 'repair-actions')).map(file => ({
        file: path.join(stateRoot(f), 'repair-actions', file), bytes: fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file)) }));
      if ((coveredSource && locationMutation) || evolution) {
        const receiptDir = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts');
        const dispatchDigest = crypto.createHash('sha256').update(first.dispatch_id).digest('hex');
        for (const file of ['record-' + dispatchDigest + '.json', 'reservation-' + dispatchDigest + '.json']) {
          const original = path.join(receiptDir, file);
          assert.ok(fs.statSync(original).isFile());
          retainedFiles.push({ file: original, bytes: fs.readFileSync(original) });
        }
        const transcript = firstReceipt.runtime_evidence.transcript.path;
        retainedFiles.push({ file: transcript, bytes: fs.readFileSync(transcript) });
        const nativeFiles = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs')
          .nativeSessionCandidates(path.join(home, 'sessions'), firstReceipt.runtime_evidence.session_id);
        assert.equal(nativeFiles.length, 1);
        retainedFiles.push({ file: nativeFiles[0], bytes: fs.readFileSync(nativeFiles[0]) });
      }
      if (coveredSource) {
        sourceResult = await run({ role: 'executor', context: { prompt: 'Implement the current covered source correction.' } });
        currentHead = git(f.root, 'rev-parse', 'HEAD'); publishedHead = currentHead;
        assert.equal(sourceResult.receipt.role, 'executor'); assert.equal(sourceResult.receipt.compliance, 'verified');
        assert.equal(sourceResult.receipt.agent_file, undefined);
        assert.equal(sourceResult.receipt.agent_file_digest, undefined);
        assert.ok(sourceResult.receipt.runtime_evidence.native_session_evidence);
        const authority = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
        const covered = authority.verify({ worktree: f.root, repo: authority.repoSlug(f.root), commit: currentHead });
        assert.equal(covered.covered, true); assert.equal(covered.record.kind, 'executor');
        assert.equal(covered.record.dispatch_id, sourceResult.dispatch_id);
        graph.synchronized_head = currentHead; fs.writeFileSync(graphFile, JSON.stringify(graph));
        if (mutation.endsWith('-forged')) {
          const file = path.join(authority.coverageRoot(), 'coverage', encodeURIComponent(covered.record.repo), currentHead + '.json');
          const bytes = JSON.parse(fs.readFileSync(file)); bytes.payload.ticket = 'T-38-99';
          fs.writeFileSync(file, JSON.stringify(bytes));
        }
        if (mutation.endsWith('-plan')) fs.appendFileSync(f.plan, '\nChanged approved PLAN.');
        if (mutation.endsWith('-owners')) { graph.tickets[f.scope.ticket].files.push('outside.txt'); fs.writeFileSync(graphFile, JSON.stringify(graph)); }
      }
      if (evolution) {
        if (['owners', 'all'].includes(evolution)) {
          graph.tickets[f.scope.ticket].files.push('outside.txt');
          fs.writeFileSync(graphFile, JSON.stringify(graph));
        }
        if (['allowlist', 'all'].includes(evolution)) {
          verificationAllowList.push({ argv: ['node', '--version'], profile: 'host', timeout_s: 600 });
          approvedPlan(f, ['node check.cjs', 'node --version']);
        }
        fs.appendFileSync(f.plan, '\nCurrent approved scope: ' + JSON.stringify(graph.tickets[f.scope.ticket].files) + '\n');
        if (['base', 'all'].includes(evolution)) {
          f.base = currentHead;
          git(f.root, 'update-ref', 'refs/heads/main', currentHead);
        }
        if (['base-merge', 'base-merge-extra'].includes(evolution)) {
          git(f.root, 'checkout', '-q', 'main');
          fs.writeFileSync(path.join(f.root, 'base-only.txt'), 'Current approved base material.\n');
          git(f.root, 'add', 'base-only.txt'); git(f.root, 'commit', '-q', '-S', '-m', 'Current signed base evolution');
          f.base = git(f.root, 'rev-parse', 'HEAD');
          git(f.root, 'checkout', '-q', graph.tickets[f.scope.ticket].branch);
          git(f.root, 'merge', '--no-ff', '-S', '-m', 'Import current signed base', 'main');
          if (evolution === 'base-merge-extra') {
            fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'Unverified merge edit.\n');
            git(f.root, 'add', 'src/owned.txt'); git(f.root, 'commit', '--amend', '-q', '-S', '--no-edit');
          }
          currentHead = git(f.root, 'rev-parse', 'HEAD'); publishedHead = currentHead;
          graph.synchronized_head = currentHead; fs.writeFileSync(graphFile, JSON.stringify(graph));
        }
        if (evolution === 'unsigned-base') {
          f.base = git(f.root, '-c', 'commit.gpgsign=false', 'commit-tree', git(f.root, 'rev-parse', 'HEAD^{tree}'),
            '-p', f.base, '-m', 'Unsigned base evolution');
          git(f.root, 'update-ref', 'refs/heads/main', f.base);
        }
        const fresh = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs').build(['review-fix', f.scope.ticket,
          '--runtime', 'codex', '--pr', '501', '--review-file', evidenceFile, '--graph', f.graphDir], { cwd: f.root });
        if (evolution !== 'stale-plan') nativeRequest.context = fresh.context;
      }
      if (mutation?.startsWith('normalized-uncovered-source')) {
        fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'uncovered external source\n');
        git(f.root, 'add', 'src/owned.txt'); git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'uncovered external source');
        publishedHead = git(f.root, 'rev-parse', 'HEAD');
      }
      if (['normalized-source-repeat', 'normalized-cli-source-repeat'].includes(mutation)) assert.equal(firstHead, first.artifact.commit);
      const actionFile = path.join(stateRoot(f), 'repair-actions', crypto.createHash('sha256').update(first.dispatch_id).digest('hex') + '.json');
      if (mutation === 'normalized-forged-actions') {
        const state = JSON.parse(fs.readFileSync(actionFile)); state.payload.confirmed[0].reply_id = 'forged';
        fs.writeFileSync(actionFile, JSON.stringify(state));
      }
      if (mutation === 'normalized-companion-forged') {
        const state = JSON.parse(fs.readFileSync(actionFile)); state.payload.confirmed[0].reply_review.response += ' ';
        fs.writeFileSync(actionFile, JSON.stringify(state));
      }
      if (['normalized-reply-body', 'normalized-covered-source-reply-body'].includes(mutation)) replies[0].body += ' mutated';
      if (['normalized-reply-author', 'normalized-covered-source-reply-author'].includes(mutation)) replies[0].author = { ...actor, id: 'foreign-user' };
      if (['normalized-reply-id', 'normalized-covered-source-reply-id'].includes(mutation)) replies[0].id = 'foreign-reply';
      if (['normalized-reply-target', 'normalized-covered-source-reply-target'].includes(mutation)) swapReplyTarget = true;
      if (mutation === 'normalized-missing-actions') fs.unlinkSync(actionFile);
      if (mutation === 'normalized-reopened') feedback[0].isResolved = false;
      if (mutation === 'normalized-source') publishedHead = '3'.repeat(40);
      if (['normalized-companion-link', 'normalized-covered-source-companion-link'].includes(mutation)) mutateRelation = true;
      if (mutation === 'normalized-companion-body') reviews[0].body = 'New finding on the retained companion review';
      if (mutation === 'normalized-companion-author') reviews[0].author = { ...actor, id: 'foreign-user' };
      if (mutation === 'normalized-companion-missing') reviews.length = 0;
      if (locationMutation) {
        feedback[0].line = mutation.endsWith('-null') ? null : 1686;
        if (mutation.endsWith('-path')) feedback[0].path = 'outside.txt';
        if (mutation.endsWith('-original-line')) feedback[0].originalLine++;
        if (mutation.endsWith('-thread-id')) feedback[0].id = 'foreign-thread';
        if (mutation.endsWith('-reopened')) feedback[0].isResolved = false;
        if (mutation.endsWith('-negative')) feedback[0].line = -1;
        if (mutation.endsWith('-string')) feedback[0].line = '1686';
        if (mutation.endsWith('-zero')) feedback[0].line = 0;
        if (mutation.endsWith('-false')) feedback[0].line = false;
        if (mutation.endsWith('-empty')) feedback[0].line = '';
        if (mutation.endsWith('-body')) originalThreadComment.body += ' changed original feedback';
        if (mutation.endsWith('-author')) originalThreadComment.author = { ...actor, id: 'foreign-user' };
      }
      const refusal = {
        'normalized-location-shift': 'REPAIR_PREDECESSOR_INVALID', 'normalized-location-null': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-uncovered-source-location-shift': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-location-forged': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-location-path': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-original-line': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-thread-id': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-reopened': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-negative': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-string': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-zero': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-false': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-empty': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-body': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-author': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-forged': 'REPAIR_SUBJECT_CHANGED', 'normalized-uncovered-source': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-plan': 'PLAN_DIGEST_MISMATCH', 'normalized-covered-source-owners': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-reply-body': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-reply-author': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-reply-id': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-reply-target': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-companion-link': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-forged-actions': 'STATE_RECORD_INVALID', 'normalized-reply-body': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-reply-author': 'REPAIR_PREDECESSOR_INVALID', 'normalized-reply-id': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-reply-target': 'REPAIR_PREDECESSOR_INVALID', 'normalized-reopened': 'REPAIR_PREDECESSOR_INVALID', 'normalized-source': 'REPAIR_SUBJECT_CHANGED',
        'normalized-companion-body': 'REPAIR_PREDECESSOR_INVALID', 'normalized-companion-author': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-companion-missing': 'REPAIR_PREDECESSOR_INVALID', 'normalized-companion-link': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-companion-forged': 'STATE_RECORD_INVALID',
      }[mutation];
      if (refusal || ['stale-plan', 'unsigned-base', 'base-merge-extra'].includes(evolution)) {
        await assert.rejects(run, { code: evolution === 'stale-plan' ? 'PLAN_DIGEST_MISMATCH'
          : ['unsigned-base', 'base-merge-extra'].includes(evolution) ? 'REPAIR_SUBJECT_CHANGED' : refusal });
        assert.equal(launches, coveredSource ? 2 : 1); assert.equal(replies.length + prReplies.length, 3);
        if (locationMutation) {
          for (const original of retainedFiles) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
        }
        return;
      }
      if (mutation === 'normalized-missing-actions') {
        for (const reply of [...replies, ...prReplies, ...reviews]) output.review_dispositions.push({
          ...structuredClone(output.review_dispositions[1]), id: reply.id });
      }
      if (mutation === 'normalized-external') {
        external.push({ id: 'external-identical-body', body: replies[0].body, author: actor });
        output.review_dispositions.push({ ...structuredClone(output.review_dispositions[1]), id: external[0].id });
      }
      for (const disposition of output.review_dispositions) disposition.action = 'reply';
      const repeatFile = selected.agent_file.replace('.toml', '-repeat.toml');
      const originalAgent = fs.readFileSync(path.join(f.agentDir, selected.agent_file), 'utf8');
      const repeatAgent = originalAgent.replace('shipyard-policy-rung = "base"', 'shipyard-policy-rung = "repeat"')
        .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "high"')
        .replace('name = "' + selected.agent_file.replace('.toml', '') + '"', 'name = "' + repeatFile.replace('.toml', '') + '"');
      fs.writeFileSync(path.join(f.agentDir, repeatFile), repeatAgent);
      const manifest = JSON.parse(fs.readFileSync(agentManifest));
      manifest.agent_files.push(repeatFile); manifest.agent_digests[repeatFile] = crypto.createHash('sha256').update(repeatAgent).digest('hex');
      fs.writeFileSync(agentManifest, JSON.stringify(manifest));
      if (['normalized-default-missing-manifest', 'normalized-default-stale-manifest'].includes(mutation)) {
        if (mutation.endsWith('-missing-manifest')) fs.unlinkSync(agentManifest);
        else fs.appendFileSync(path.join(f.agentDir, repeatFile), '\nchanged installed repeat instructions\n');
        await assert.rejects(run, { code: 'STALE_GENERATED_AGENT' });
        assert.equal(launches, 1, 'invalid installed defaults refuse before the repeated native launch');
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), firstHead);
        assert.equal(replies.length + prReplies.length, 3);
        return;
      }
      let second;
      if (historicalRecovery) {
        output.status = 'fixed';
        if (historicalRecovery === 'direct') {
          second = await run();
          const counters = [launches, pushes, replies.length, prReplies.length];
          const recovery = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
            verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() });
          for (let retry = 0; retry < 2; retry++) {
            const resumed = await recovery.resumeFinalization(second.artifact.candidate_id, f.scope);
            assert.equal(resumed.artifact.commit, second.artifact.commit);
            assert.equal(resumed.actions.status, 'confirmed');
            assert.deepEqual([launches, pushes, replies.length, prReplies.length], counters);
          }
        } else {
          await assert.rejects(run);
          const candidates = fs.readdirSync(path.join(stateRoot(f), 'candidates')).map(file =>
            JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'candidates', file))).payload);
          const candidate = candidates.find(item => item.expected_head === currentHead && item.expected_role === 'review-fix');
          assert.ok(candidate);
          const historical = candidate.repair_subject.actionable_feedback.coverage.map(item =>
            repairCoverageTransition(item, candidate.repair_subject.actionable_feedback));
          assert.equal(historical.length, 3);
          assert.ok(historical.every(item => item.historical && item.semantic_credit === false
            && (item.source_transition ? item.source_transition.to === currentHead : firstHead === currentHead)));
          assert.deepEqual(candidate.files_modified, graph.tickets[f.scope.ticket].files);
          const counters = [launches, pushes, replies.length, prReplies.length];
          const originals = [...retainedFiles];
          for (const directory of ['candidates', 'finalized']) {
            const root = path.join(stateRoot(f), directory);
            if (fs.existsSync(root)) for (const file of fs.readdirSync(root)) originals.push({
              file: path.join(root, file), bytes: fs.readFileSync(path.join(root, file)) });
          }
          const recoveryOptions = { ...cliOptions(f), getPullRequest: live, execFileSync: transport,
            verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() };
          const recovery = createFinalizationRecoveryHost(recoveryOptions);
          const resume = () => recovery.resumeFinalization(candidate.candidate_id, f.scope);
          const unchangedCounters = () => assert.deepEqual([launches, pushes, replies.length, prReplies.length], counters);
          const rejectFileChange = async (file, mutate) => {
            const bytes = fs.readFileSync(file);
            const mode = fs.statSync(file).mode & 0o777;
            try { mutate(file, bytes); await assert.rejects(resume); unchangedCounters(); }
            finally { fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); }
          };
          await rejectFileChange(f.plan, file => fs.appendFileSync(file, '\nChanged current PLAN'));
          await rejectFileChange(graphFile, file => {
            const changed = JSON.parse(fs.readFileSync(file)); changed.tickets[f.scope.ticket].files.push('foreign-owner.txt');
            fs.writeFileSync(file, JSON.stringify(changed));
          });
          await rejectFileChange(evidenceFile, file => fs.appendFileSync(file, '\nReplaced evidence'));
          for (const directory of ['candidates', 'finalized', 'repair-publications', 'repair-actions', 'repair-attempts']) {
            const root = path.join(stateRoot(f), directory);
            if (!fs.existsSync(root)) continue;
            for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json')
                && (!['candidates', 'finalized', 'repair-publications'].includes(directory) || name === candidate.candidate_id + '.json'))) {
              const file = path.join(root, name);
              await rejectFileChange(file, (target, bytes) => {
                const envelope = JSON.parse(bytes); envelope.payload.ticket = 'T-38-99';
                fs.writeFileSync(target, JSON.stringify(envelope));
              });
              await rejectFileChange(file, target => fs.unlinkSync(target));
            }
          }
          for (const original of retainedFiles.filter(item => !item.file.includes('repair-actions') && !path.basename(item.file).startsWith('reservation-'))) {
            await rejectFileChange(original.file, file => fs.appendFileSync(file, '\nTampered original native custody'));
          }
          await assert.rejects(() => recovery.resumeFinalization(candidate.candidate_id, { ...f.scope, repository: 'foreign-repository' }));
          unchangedCounters();
          verificationAllowList.push({ argv: ['node', '--invalid-recovery-policy'], profile: 'host', timeout_s: 600 });
          try { await assert.rejects(resume); unchangedCounters(); } finally { verificationAllowList.pop(); }
          const baseBefore = git(f.root, 'rev-parse', 'main');
          try {
            git(f.root, 'update-ref', 'refs/heads/main', candidate.expected_head === baseBefore ? 'HEAD' : candidate.expected_head);
            if (git(f.root, 'rev-parse', 'main') !== baseBefore) { await assert.rejects(resume); unchangedCounters(); }
          } finally { git(f.root, 'update-ref', 'refs/heads/main', baseBefore); }
          const branchBefore = git(f.root, 'symbolic-ref', 'HEAD');
          try {
            git(f.root, 'update-ref', 'refs/heads/foreign-recovery', 'HEAD');
            git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/foreign-recovery');
            await assert.rejects(resume); unchangedCounters();
          } finally { git(f.root, 'symbolic-ref', 'HEAD', branchBefore); }
          const originalSigner = git(f.root, 'config', 'user.signingkey');
          try {
            git(f.root, 'config', 'user.signingkey', 'F'.repeat(40));
            await assert.rejects(resume); unchangedCounters();
          } finally { git(f.root, 'config', 'user.signingkey', originalSigner); }
          const originalPublished = publishedHead;
          try { publishedHead = '1'.repeat(40); await assert.rejects(resume); unchangedCounters(); }
          finally { publishedHead = originalPublished; }
          const sourceHead = git(f.root, 'rev-parse', 'HEAD');
          const unrelated = git(f.root, 'commit-tree', '-S', git(f.root, 'rev-parse', 'HEAD^{tree}'),
            '-p', sourceHead, '-m', 'Unrelated authentic equal-tree signed commit');
          try {
            git(f.root, 'update-ref', 'HEAD', unrelated); publishedHead = unrelated;
            await assert.rejects(resume); unchangedCounters();
          } finally { git(f.root, 'update-ref', 'HEAD', sourceHead); publishedHead = originalPublished; }
          if (['pending', 'action'].includes(historicalRecovery)) {
            const originalGraph = fs.readFileSync(graphFile);
            const snapshot = path.join(f.root, '.git', 'original-recovery-graph.json');
            fs.writeFileSync(snapshot, originalGraph);
            recoveryOptions.recoveryGraphSnapshot = snapshot;
            const journal = candidate.repair_subject.journal;
            assert.ok(journal);
            const journalBytes = fs.readFileSync(journal.path);
            const row = { ts: '2026-10-20T07:31:21.739Z', event: 'status_change', ticket: 'T-999-99',
              from: null, to: 'pending', pr: null };
            const append = value => fs.writeFileSync(journal.path, Buffer.concat([journalBytes, Buffer.from(value)]));
            for (const invalid of [JSON.stringify(row), 'false\n', '{bad}\n',
              JSON.stringify({ ...row, ticket: f.scope.ticket }) + '\n',
              JSON.stringify({ ...row, pr: candidate.repair_subject.pr }) + '\n',
              JSON.stringify({ ...row, event: 'repair_attempt' }) + '\n',
              JSON.stringify({ ...row, to: false }) + '\n', Buffer.from([0xff, 10])]) {
              append(invalid);
              await assert.rejects(resume); unchangedCounters();
            }
            append(JSON.stringify(row) + '\n');
            const evolved = JSON.parse(originalGraph);
            evolved.tickets['T-999-99'] = { ...evolved.tickets[f.scope.ticket], depends_on: [f.scope.ticket] };
            fs.writeFileSync(graphFile, JSON.stringify(evolved));
            await rejectFileChange(snapshot, file => fs.appendFileSync(file, ' '));
            await rejectFileChange(graphFile, file => {
              const changed = JSON.parse(fs.readFileSync(file)); changed.tickets[f.scope.ticket].risk = 'changed';
              fs.writeFileSync(file, JSON.stringify(changed));
            });
            await rejectFileChange(journal.path, (file, bytes) => {
              const changed = Buffer.from(bytes); changed[0] ^= 1; fs.writeFileSync(file, changed);
            });
            await rejectFileChange(journal.path, file => fs.writeFileSync(file, journalBytes.subarray(0, -1)));
            await rejectFileChange(graphFile, file => {
              const changed = JSON.parse(fs.readFileSync(file)); changed.epics = { forged: true };
              fs.writeFileSync(file, JSON.stringify(changed));
            });
            delete recoveryOptions.recoveryGraphSnapshot;
            await assert.rejects(resume); unchangedCounters();
            recoveryOptions.recoveryGraphSnapshot = snapshot;
          }
          const resumed = await resume();
          assert.equal(resumed.publication.status, 'confirmed');
          assert.equal(resumed.actions.status, 'confirmed');
          assert.notEqual(resumed.artifact.commit, currentHead);
          const accepted = [launches, pushes, replies.length, prReplies.length];
          assert.equal(accepted[0], counters[0]);
          if (historicalRecovery !== 'admitted') assert.equal(accepted[1], counters[1]);
          const again = await recovery.resumeFinalization(candidate.candidate_id, f.scope);
          assert.deepEqual(again.artifact, resumed.artifact);
          assert.deepEqual([launches, pushes, replies.length, prReplies.length], accepted);
          if (candidate.repair_subject.journal) {
            const pin = candidate.repair_subject.journal;
            assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pin.path).subarray(0, pin.bytes)).digest('hex'), pin.sha256);
          }
          for (const original of originals) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
          for (const original of retainedFiles) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
          return;
        }
      } else second = await run();
      const unknown = !!evolution || coveredSource || ['normalized-external', 'normalized-missing-actions'].includes(mutation);
      assert.equal(second.resolution.signals.signatureState, unknown ? 'first' : 'repeat');
      assert.equal(second.receipt.applied_effort, unknown ? 'low' : 'high');
      assert.equal(second.receipt.agent_file_digest, crypto.createHash('sha256').update(unknown ? originalAgent : repeatAgent).digest('hex'));
      assert.notEqual(second.dispatch_id, first.dispatch_id);
      assert.notEqual(second.receipt.runtime_evidence.session_id, firstReceipt.runtime_evidence.session_id);
      assert.notEqual(second.receipt.launch_id, firstReceipt.launch_id);
      assert.notEqual(second.receipt.runtime_evidence.transcript.sha256, firstReceipt.runtime_evidence.transcript.sha256);
      assert.notEqual(second.receipt.runtime_evidence.native_session_evidence.sha256, firstReceipt.runtime_evidence.native_session_evidence.sha256);
      assert.equal(second.repair_result.review_dispositions.length, mutation === 'normalized-missing-actions' ? 7 : mutation === 'normalized-external' ? 4 : 3);
      if (mutation !== 'normalized-missing-actions') assert.ok(second.repair_result.review_dispositions.every(item => !/^reply-|^pr-reply-/.test(item.id)));
      const attempts = fs.readdirSync(path.join(stateRoot(f), 'repair-attempts')).map(file =>
        JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-attempts', file))).payload).filter(item => item.dispatch_id);
      const originalSecond = attempts.find(item => item.dispatch_id === second.dispatch_id);
      assert.equal(originalSecond.subject.feedback.inventory.length, mutation === 'normalized-external' ? 8 : 7);
      assert.equal(originalSecond.subject.actionable_feedback.coverage.length, mutation === 'normalized-missing-actions' ? 0 : 3);
      if (coveredSource || evolution) {
        const historicalCoverage = originalSecond.subject.actionable_feedback.coverage.map(item =>
          repairCoverageTransition(item, originalSecond.subject.actionable_feedback));
        assert.deepEqual(originalSecond.subject.actionable_feedback.historical_dispatch_ids, [first.dispatch_id]);
        assert.ok(historicalCoverage.every(item => item.historical && item.semantic_credit === false
          && (!coveredSource || (item.source_transition.from === firstHead && item.source_transition.to === currentHead))));
        assert.equal(originalSecond.subject.actionable_feedback.inventory.find(item => item.id === threadId).resolved, true);
        if (evolution) {
          assert.ok(historicalCoverage.every(item => item.scope_transition
            && item.scope_transition.from.plan.sha256 !== item.scope_transition.to.plan.sha256));
          assert.equal(originalSecond.preparation.plan.sha256, nativeRequest.context.plan_sha256);
          assert.deepEqual(originalSecond.preparation.commit.files_modified, graph.tickets[f.scope.ticket].files);
          assert.deepEqual(originalSecond.preparation.verificationAllowList, verificationAllowList);
          assert.equal(originalSecond.preparation.commit.expectedBase, f.base);
          if (!coveredSource) assert.ok(historicalCoverage.every(item =>
            !Object.hasOwn(item, 'source_transition')), 'PLAN-only provenance must not invent a source transition');
          if (evolution === 'base-merge') {
            for (const item of historicalCoverage) {
              const records = item.source_transition.records;
              assert.equal(records.filter(pin => pin.coverage_sha256).length, 1);
              assert.equal(records.filter(pin => pin.base_import && pin.semantic_credit === false).length, 1);
              const merge = records.find(pin => pin.base_merge);
              assert.equal(merge.commit, currentHead); assert.equal(merge.semantic_credit, false);
              assert.deepEqual(merge.base_merge.parents, [sourceResult.artifact.commit, f.base]);
              assert.equal(merge.base_merge.tree, git(f.root, 'rev-parse', currentHead + '^{tree}'));
            }
          }
        }
        if (locationMutation) {
          const originalThread = JSON.parse(retainedFiles[0].bytes).payload.feedback.inventory.find(item => item.id === threadId);
          const currentThread = originalSecond.subject.actionable_feedback.inventory.find(item => item.id === threadId);
          assert.equal(originalThread.line, 1653);
          assert.deepEqual(currentThread, { ...originalThread, line: feedback[0].line });
          const receiptDir = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts');
          assert.equal(createDurableRecorder(receiptDir).getLatestReceipt('codex', 'review-fix').dispatch_id, second.dispatch_id);
        }
        for (const original of retainedFiles) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
        assert.equal(first.receipt.dispatch_id, firstReceipt.dispatch_id);
      }
      assert.equal(originalSecond.subject.actionable_feedback.digest === attempts.find(item => item.dispatch_id === first.dispatch_id).normalized_feedback_digest,
        !unknown);
      assert.equal(replies.length + prReplies.length, mutation === 'normalized-missing-actions' ? 10 : mutation === 'normalized-external' ? 7 : 6);
      if (mutation === 'normalized-repeat' && !evolution) {
        const deepFile = selected.agent_file.replace('.toml', '-deep.toml');
        const deepAgent = repeatAgent.replace('shipyard-policy-rung = "repeat"', 'shipyard-policy-rung = "repeat_exhausted"')
          .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "xhigh"')
          .replace('name = "' + repeatFile.replace('.toml', '') + '"', 'name = "' + deepFile.replace('.toml', '') + '"');
        fs.writeFileSync(path.join(f.agentDir, deepFile), deepAgent);
        manifest.agent_files.push(deepFile); manifest.agent_digests[deepFile] = crypto.createHash('sha256').update(deepAgent).digest('hex');
        fs.writeFileSync(agentManifest, JSON.stringify(manifest));
        const third = await run();
        assert.equal(third.resolution.signals.signatureState, 'repeat_exhausted');
        assert.equal(third.receipt.applied_effort, 'xhigh');
        assert.notEqual(third.dispatch_id, first.dispatch_id); assert.notEqual(third.dispatch_id, second.dispatch_id);
        assert.equal(third.repair_result.review_dispositions.length, 3);
        assert.equal(replies.length + prReplies.length, 9);
        await assert.rejects(run, { code: 'REPAIR_POLICY_EXHAUSTED' });
        assert.equal(launches, 3);
      }
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), historicalRecovery === 'direct' ? second.artifact.commit : currentHead);
      return;
    }
    if (mutation) {
      const expectedCode = {
        'foreign-pr': 'REPAIR_SUBJECT_CHANGED', 'closed-pr': 'REPAIR_SUBJECT_CHANGED',
        'stale-head': 'REPAIR_SUBJECT_CHANGED', 'stale-base': 'REPAIR_SUBJECT_CHANGED',
        'failed-page': 'REPAIR_FEEDBACK_UNAVAILABLE', 'overflow': 'REPAIR_FEEDBACK_OVERFLOW',
        'disposition-budget': 'REPAIR_FEEDBACK_OVERFLOW', 'duplicate-feedback': 'REPAIR_FEEDBACK_INVALID',
        'stalled-pagination': 'REPAIR_FEEDBACK_INVALID', 'feedback-movement': 'REPAIR_SUBJECT_CHANGED',
        'missing-disposition': 'REPAIR_COMPLETION_INVALID', 'missing-schema': 'REPAIR_COMPLETION_INVALID',
        'foreign-schema': 'REPAIR_COMPLETION_INVALID', 'extra-result-field': 'REPAIR_COMPLETION_INVALID',
        'extra-disposition-field': 'REPAIR_COMPLETION_INVALID',
        'escalate-resolve': 'REPAIR_COMPLETION_INVALID', 'foreign-result': 'REPAIR_COMPLETION_INVALID',
        'producer-push': 'REPAIR_COMPLETION_INVALID', 'evidence-symlink': 'REPAIR_EVIDENCE_CHANGED',
        'evidence-bytes': 'REPAIR_EVIDENCE_CHANGED', 'unknown-selector': 'INVALID_INPUT', 'caller-rung': 'INVALID_INPUT',
        'caller-first': 'INVALID_INPUT', 'caller-new': 'INVALID_INPUT',
        'foreign-dirty': 'SCOPED_TREE_UNAVAILABLE', 'self-commit': 'REPAIR_SUBJECT_CHANGED',
        'plan-movement': 'REPAIR_SUBJECT_CHANGED', 'evidence-completion': 'REPAIR_EVIDENCE_CHANGED',
        'missing-completion': 'RUNTIME_EVIDENCE_MISSING', 'duplicate-completion': 'RUNTIME_EVIDENCE_MISMATCH',
        'missing-callback': 'REPAIR_COMPLETION_INVALID', 'foreign-callback': 'REPAIR_COMPLETION_INVALID',
        'mismatched-callback': 'REPAIR_COMPLETION_INVALID', 'duplicate-callback': 'RUNTIME_EVIDENCE_INVALID',
        'duplicate-cli-final': 'REPAIR_COMPLETION_INVALID', 'foreign-cli-session': 'RUNTIME_EVIDENCE_INVALID',
        'mismatched-cli-final': 'RUNTIME_EVIDENCE_MISMATCH', 'duplicate-native-final': 'RUNTIME_EVIDENCE_MISMATCH',
        'missing-native-completion': 'RUNTIME_EVIDENCE_MISMATCH', 'foreign-native-final': 'RUNTIME_EVIDENCE_MISMATCH',
        'mismatched-native-final': 'RUNTIME_EVIDENCE_MISMATCH',
        'native-context': 'REPAIR_COMPLETION_INVALID', 'native-delegation': 'REPAIR_COMPLETION_INVALID',
      }[mutation];
      assert.ok(expectedCode, 'every mutation must name its intended refusal');
      await assert.rejects(run, { code: expectedCode });
      const prelaunch = ['foreign-pr', 'closed-pr', 'stale-head', 'stale-base', 'failed-page', 'overflow',
        'disposition-budget', 'duplicate-feedback', 'stalled-pagination', 'evidence-symlink', 'evidence-bytes',
        'unknown-selector', 'caller-rung', 'caller-first', 'caller-new'];
      assert.equal(launches, prelaunch.includes(mutation) ? 0 : 1);
      if (mutation !== 'self-commit') assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      assert.equal(replies.length + prReplies.length, 0);
      return;
    }
    const result = await run();
    assert.equal(launches, 1);
    assert.equal(result.receipt.role, 'review-fix');
    assert.equal(result.receipt.compliance, 'verified');
    const originalStream = fs.readFileSync(result.receipt.runtime_evidence.transcript.path, 'utf8');
    assert.equal(crypto.createHash('sha256').update(originalStream).digest('hex'), result.receipt.runtime_evidence.transcript.sha256);
    const streamRows = originalStream.trim().split('\n').map(JSON.parse);
    assert.equal(streamRows.filter(row => row.type === 'turn.completed').length, 1);
    assert.equal(streamRows.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message').length, 5);
    assert.equal(streamRows.findLast(row => row.item?.type === 'agent_message').item.text, JSON.stringify(output));
    // @contract: Selection signals retain the original boundary resolution identity.
    assert.equal(result.resolution.dispatch_id, result.receipt.dispatch_id);
    assert.equal(result.resolution.role, 'review-fix');
    assert.equal(result.resolution.model, selected.model);
    assert.equal(result.resolution.effort, selected.effort);
    assert.deepEqual(result.resolution.signals, result.signals);
    assert.equal(result.resolution.signals.signatureState, 'first');
    assert.equal(Object.hasOwn(result.resolution.signals, 'priorApplied'), false);
    assert.equal(result.receipt.applied_effort, selected.effort);
    assert.equal(result.repair.role, 'review-fix');
    assert.equal(result.repair.envelope.pushed, false);
    // @contract: Artifact base identity uses the canonical graph/PR literal, including for equivalent Git aliases.
    const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const repairRead = { role: 'review-fix', ticket: f.scope.ticket, pr: 501,
      worktreePath: f.root, base: graph.tickets[f.scope.ticket].pr_base,
      branch: graph.tickets[f.scope.ticket].branch, planPath: graph.tickets[f.scope.ticket].plan,
      boundaryStore: result.receipt_store || path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts'),
      dispatchId: result.receipt.dispatch_id, artifactPath: result.repair.artifact_ref, artifactDigest: result.repair.artifact_digest, historical: true };
    assert.equal(repairRead.base, live().baseRefName);
    assert.throws(() => roleArtifacts.read({ ...repairRead, base: 'refs/heads/main' }), { code: 'STALE_ARTIFACT' });
    // @contract: PLAN identity retains the graph literal; filesystem aliases and foreign paths refuse.
    assert.equal(path.resolve(f.graphDir, '..', '..', repairRead.planPath), f.plan);
    for (const planPath of [f.plan, './' + repairRead.planPath, '.planning/phases/38-requests/38-99-PLAN.md']) {
      assert.throws(() => roleArtifacts.read({ ...repairRead, planPath }),
        error => error.code === 'ARTIFACT_IDENTITY_MISMATCH' && error.message.includes('plan_path'));
    }
    const protectedRepair = roleArtifacts.read(repairRead);
    assert.equal(protectedRepair.base, repairRead.base);
    assert.equal(protectedRepair.manifest.branch, repairRead.branch);
    assert.equal(protectedRepair.manifest.plan_path, repairRead.planPath);
    assert.equal(protectedRepair.manifest.producer_dispatch, result.receipt.dispatch_id);
    assert.equal(protectedRepair.manifest.producer_launch, result.receipt.launch_id);
    assert.equal(protectedRepair.pr, output.pr);
    assert.equal(protectedRepair.ticket, output.id);
    assert.equal(protectedRepair.integration_base.commit, f.base);
    assert.equal(protectedRepair.producer_head, f.base);
    assert.equal(protectedRepair.evidence, 'Complete original producer evidence and dispositions.');
    assert.equal(protectedRepair.findings.hypothesis, output.hypothesis);
    assert.deepEqual(result.repair_result.review_dispositions, output.review_dispositions);
    if (outcome === 'source') {
      assert.equal(result.artifact.status, 'committed');
      assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
      assert.equal(result.actions.status, 'confirmed');
      assert.equal(publishedHead, result.artifact.commit);
      assert.ok(git(f.root, 'show', '-s', '--format=%B', 'HEAD').includes('Shipyard-Verification-Evidence:'));
      const signedCoverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs').verify({ worktree: f.root, repo: require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs').repoSlug(f.root), commit: result.artifact.commit });
      assert.equal(signedCoverage.covered, true);
      assert.equal(signedCoverage.record.kind, 'fixer');
      const recoveryHost = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
        verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() });
      await assert.rejects(() => recoveryHost.resumeFinalization(result.artifact.candidate_id, { ...f.scope, role: 'executor' }),
        error => error.code === 'IDENTITY_CHANGED' && error.invalidated.includes('role'));
      const resumed = await recoveryHost.resumeFinalization(result.artifact.candidate_id, f.scope);
      assert.equal(resumed.idempotent, true); assert.equal(resumed.artifact.commit, result.artifact.commit);
      assert.equal(resumed.publication.status, 'confirmed'); assert.equal(launches, 1);
    } else {
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      assert.equal(result.artifact, undefined);
      if (outcome === 'no-op') {
        assert.equal(result.actions.confirmed.length, 3);
        assert.equal(result.actions.confirmed.filter(action => action.resolved).length, 1);
        assert.equal(feedback[0].isResolved, true);
        assert.equal(replies.length + prReplies.length, 3);
        const recovered = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList })
          .resumeRepairActions(result.receipt.dispatch_id, f.scope);
        assert.equal(recovered.resumed, true); assert.equal(recovered.actions.confirmed.length, 3);
        assert.equal(replies.length + prReplies.length, 3, 'confirmed actions are independently checked without replay');
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      } else { assert.equal(feedback[0].isResolved, false); assert.equal(result.actions.confirmed.length, 0); }
    }
  } finally {
    os.homedir = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
    clean(f); fs.rmSync(home, { recursive: true, force: true });
  }
}

return originalFixerFixture;
}

module.exports = { createOriginalFixerFixture };
