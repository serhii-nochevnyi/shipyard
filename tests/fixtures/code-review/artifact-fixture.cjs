'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const originals = new WeakMap();
const inputStorage = new WeakMap();
const retainedInputRoots = new Set();
process.once('exit', () => {
  for (const root of retainedInputRoots) fs.rmSync(root, { recursive: true, force: true });
});
function privateInputStorage(f) {
  if (!inputStorage.has(f)) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-inputs-')));
    fs.chmodSync(root, 0o700);
    inputStorage.set(f, root);
    retainedInputRoots.add(root);
  }
  return inputStorage.get(f);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);
const artifact = require('../../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const target = require('../../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
const core = require('../../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
const { createDurableRecorder, createDispatchBoundary } = require('../../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const git = (root, args) => execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
function fixture(suffix = 'plain') {
  const previousCodexHome = process.env.CODEX_HOME;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'code-review-'+suffix+'-')));
  git(root,['init','--quiet','--initial-branch=main']);
  git(root,['config','user.name','Code Review Test']); git(root,['config','user.email','review@example.test']);
  git(root,['config','commit.gpgsign','false']);
  fs.copyFileSync(path.join(__dirname,'source.js'),path.join(root,'source.js'));
  git(root,['add','source.js']); git(root,['commit','--quiet','-m','base']);
  const base = git(root,['rev-parse','HEAD']); git(root,['update-ref','refs/remotes/origin/main',base]);
  const branch = 'epic/52-review'; git(root,['switch','--quiet','-c',branch]);
  const phase = '52-review', graphDir = path.join(root,'.planning/graph'); fs.mkdirSync(graphDir,{recursive:true});
  const graph = {tickets:{'T-52-01':{phase:52,plan:'.planning/phases/'+phase+'/52-01-PLAN.md',epic:branch}}};
  const state = {'T-52-01':{status:'merged',pr:1,head_sha:base,merge_sha:base}};
  const recorder = createDurableRecorder(path.join(root,'receipts'));
  const boundary = createDispatchBoundary({recorder,adapters:{claude:{launch:r=>({receipt_type:'adr-014.application',runtime:r.runtime,role:r.role,dispatch_id:r.dispatch_id,launch_id:'review-'+r.dispatch_id,requested_model:r.requested_model,requested_effort:r.requested_effort,applied_model:r.model,applied_effort:r.effort,observed_model:r.model,observed_effort:r.effort,policy_hash:r.policy_hash,compliance:'verified',compliance_proof:{status:'verified',boundary:'adr-014.dispatch-boundary',policy_hash:r.policy_hash,dispatch_id:r.dispatch_id,launch_id:'review-'+r.dispatch_id}})}}});
  function writeGraph() { fs.writeFileSync(path.join(graphDir,'tickets.json'),JSON.stringify(graph)); fs.writeFileSync(path.join(graphDir,'delivery-state.json'),JSON.stringify({tickets:state})); }
  function advance(n) {
    fs.writeFileSync(path.join(root,'round.txt'),String(n)); git(root,['add','round.txt']); git(root,['commit','--quiet','-m','round '+n]);
    if(n>1) { const id='T-52-0'+n; graph.tickets[id]={...graph.tickets['T-52-01'],plan:'.planning/phases/'+phase+'/52-0'+n+'-PLAN.md'}; state[id]={status:'merged',pr:10+n,head_sha:git(root,['rev-parse','HEAD']),merge_sha:git(root,['rev-parse','HEAD'])}; }
    writeGraph();
    return target.phaseBinding({graph,state,phase:52,repository:target.repositoryIdentity(root),pr:52,head:git(root,['rev-parse','HEAD']),base,branch});
  }
  function input(binding, round=1, priorHead=null, rawResult) {
    const dispatch = boundary.dispatch({runtime:'claude',role:'code-review',signals:{}},{ticket:binding.subject,subject_kind:'phase'});
    const raw = structuredClone(rawResult || JSON.parse(fs.readFileSync(path.join(__dirname,'review.json'),'utf8')));
    const normalized = core.normalizeResult(raw,{round,scope:round===1?'full':'delta',readSource:file=>fs.readFileSync(path.join(root,file),'utf8')});
    const referenceDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../../../plugins/delivery-pipeline/references/code-review.md'))).digest('hex');
    const contract = core.contractDigest(referenceDigest);
    fs.writeFileSync(path.join(root,'.shipyard-code-review-evidence.md'),'Complete review of all phase changes.\n');
    const input = {worktreePath:root,base:'main',role:'code-review',ticket:binding.subject,pr:52,ticketSet:binding.ticketSet,ticketSetDigest:binding.membership,recorder,dispatchId:dispatch.receipt.dispatch_id,result:{...normalized,id:binding.subject,pr:52,head:git(root,['rev-parse','HEAD']),base_tree:git(root,['rev-parse',base+'^{tree}']),ticket_set:binding.ticketSet,ticket_set_digest:binding.membership,contract_digest:contract,reuse_key:core.reuseKey({head:git(root,['rev-parse','HEAD']),baseCommit:base,contractDigest:contract}),prior_head:priorHead,dispositions_digest:null}};
    originals.set(input, { raw, priorFindings: [] });
    return input;
  }
  function lookup() { return artifact.currentCodeReviewVerdict({worktreePath:root,pr:52,head:git(root,['rev-parse','HEAD']),baseName:'main',baseCommit:base,graphDir,headBranch:branch}); }
  return {root,base,branch,phase,graph,state,graphDir,writeGraph,advance,input,lookup,recorder,dispatch:(role,ticket)=>boundary.dispatch({runtime:'claude',role,signals:{}},{ticket,...(['code-review','arch-review'].includes(role)?{subject_kind:'phase'}:{})}),git:args=>git(root,args),cleanup:()=>{ if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome; fs.rmSync(root,{recursive:true,force:true}); }};
}


function setOriginalReview(input, raw, priorFindings = []) {
  originals.set(input, { raw: structuredClone(raw), priorFindings: structuredClone(priorFindings) });
  return input;
}

function retainPlanningInput(f, input, planningRoot = f.root, repo = null, options = {}) {
  const packets = require('../../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const collector = require('../../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const snapshot = originals.get(input);
  if (!snapshot) throw new Error('A separately retained original raw review is required');
  const raw = structuredClone(snapshot.raw), priorFindings = snapshot.priorFindings;
  const refs = input.result.ticket_set.map(item => item.row.plan);
  const requestedPartitions = raw.coverage?.length || 0;
  const useCodex = options.runtime ? options.runtime === 'codex' : requestedPartitions > 0;
  const hostFiles = options.transport === 'host-files' || requestedPartitions > 0;
  for (const plan of refs) {
    const absolute = path.join(planningRoot, plan);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, '# Original complete acceptance\n');
    if (requestedPartitions && fs.statSync(absolute).size < requestedPartitions)
      fs.appendFileSync(absolute, 'x'.repeat(requestedPartitions));
  }
  const graphDir = path.join(planningRoot, '.planning/graph');
  const phase = path.basename(path.dirname(refs[0]));
  const carrier = path.join(planningRoot, '.planning/phases', phase, 'code-review-disagreements.json');
  let dispositionsDigest = null;
  try { dispositionsDigest = hash(fs.readFileSync(carrier)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reference = options.reference || require('../../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs').loadClaudeReferenceContent('code-review');
  const referenceDigest = { sha256: hash(reference), bytes: Buffer.byteLength(reference) };
  const head = input.result.head, base = input.result.base_commit || f.base;
  const mergeBase = git(f.root, ['merge-base', base, head]);
  const focused = { repository: target.repositoryIdentity(f.root), id: input.ticket, pr: input.pr, head,
    base_commit: base, merge_base: mergeBase, base_tree: git(f.root, ['rev-parse', mergeBase + '^{tree}']),
    ticket_set_digest: input.ticketSetDigest };
  const round = { round: input.result.review_round, scope: input.result.review_scope, priorHead: input.result.prior_head };
  const roleContext = core.assemblePacket({ subject: input.ticket, identity: focused,
    exactDiff: { from: round.scope === 'delta' ? round.priorHead : mergeBase, to: head,
      content: git(f.root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=50',
        round.scope === 'delta' ? round.priorHead : mergeBase, head,
        ...require('../../../plugins/delivery-pipeline/scripts/development-artifacts.cjs').productPathspec()]) },
    integrationBase: { commit: base }, ticketSet: input.result.ticket_set, planAcceptance: [], priorFindings, round,
    changeMetadata: {}, referenceDigest: referenceDigest.sha256 });
  Object.assign(roleContext, { planning_reference: packets.resolvePlanningReference({ worktree: f.root, graphDir, repo }),
    dispositions_digest: dispositionsDigest, reference_digest: referenceDigest });
  if (useCodex) roleContext.reference = { path: 'references/code-review.md', content: reference, ...referenceDigest };
  const packet = structuredClone(packets.decodeUniqueContent(packets.encodeUniqueContent(packets.buildContextPacket({ root: planningRoot,
    role: 'code-review', subject: input.ticket, sourceRevision: head, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
    scope: { files_modified: ['source.js'] }, requiredRefs: refs, roleContext }))));
  const contextDigest = hash(useCodex ? JSON.stringify(packets.encodeUniqueContent(packet)) : stable(packet));
  const binding = { ...packet.role_context.focused, context_digest: contextDigest,
    launch_digest: hash(stable({ packet_digest: contextDigest, reference_digest: referenceDigest })) };
  Object.assign(raw, binding, { ticket_set: packet.role_context.ticket_set, coverage: raw.coverage || [],
    evidence_markdown: raw.evidence_markdown || fs.readFileSync(path.join(f.root, '.shipyard-code-review-evidence.md'), 'utf8') });
  const dispatchId = crypto.randomUUID();
  let fileInput;
  if (useCodex) raw.coverage = raw.coverage.map((entry, index) => ({ partition: index + 1, status: entry.status }));
  if (hostFiles) {
    const sources = [{ path: 'current-pr.diff', content: packet.role_context.exact_diff.content }, ...packet.required_refs];
    const count = Math.max(requestedPartitions, sources.filter(source => source.content.length).length);
    const lastPartitionedSource = sources.findLastIndex(source => source.content.length);
    const material = [JSON.stringify(packets.encodeUniqueContent(packet))], spans = [], inventory = [];
    for (const [index, source] of sources.entries()) {
      const bytes = Buffer.from(source.content), partitions = [];
      const n = index === lastPartitionedSource ? count - spans.length : 1;
      let offset = 0;
      for (let part = 0; bytes.length && part < n; part++) {
        const end = part === n - 1 ? bytes.length : offset + 1;
        const ordinal = material.length;
        material.push(bytes.subarray(offset, end).toString('utf8')); partitions.push(ordinal);
        spans.push({ source: source.path, source_sha256: hash(bytes), source_bytes: bytes.length,
          start: offset, end, partition: ordinal }); offset = end;
      }
      inventory.push({ path: source.path, sha256: hash(bytes), bytes: bytes.length, start: 0, end: bytes.length,
        inline_asset: 0, partitions });
    }
    fileInput = collector.prepareFileInput({ worktree: f.root, phase: Number(phase.split('-')[0]), ticket: input.ticket }, material,
      { role: 'code-review', dispatchId, graphDir, phaseRepo: repo, storageRoot: privateInputStorage(f),
        focusedPartitions: spans, focusedSources: inventory,
        binding: { review_contract: core.CONTRACT_ID, packet_digest: contextDigest,
          focused: { ...packet.role_context.focused, context_digest: contextDigest } } });
    raw.coverage = spans.map((span, index) => ({ partition: span.partition, status: snapshot.raw.coverage?.[index]?.status || 'reviewed' }));
  }
  const normalization = { round: round.round, scope: round.scope, priorFindings,
    readSource: core.createSourceReader({ head, git: (args, maximum) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', maxBuffer: maximum }) }) };
  const semantic = useCodex ? core.normalizeResult(raw, normalization) : core.normalizeFinal(raw, [], normalization);
  if (useCodex && fileInput) Object.assign(semantic, collector.validateCodeReviewCoverage(semantic, fileInput.manifest));
  const { evidence_markdown: _markdown, host_context: _context, ...result } = semantic;
  Object.assign(result, { prior_head: round.priorHead, contract_digest: roleContext.contract_digest,
    dispositions_digest: dispositionsDigest,
    reuse_key: core.reuseKey({ head, baseCommit: base, contractDigest: roleContext.contract_digest }) });
  fs.writeFileSync(path.join(f.root, '.shipyard-code-review-evidence.md'), raw.evidence_markdown);
  const boundary = createDispatchBoundary({ recorder: f.recorder, adapters: { claude: { launch(r) {
    const session = crypto.randomUUID();
    const native = path.join(planningRoot, '.planning', session + '.native.jsonl');
    const stream = path.join(planningRoot, '.planning', session + '.stream.jsonl');
    const prompt = '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packets.encodeUniqueContent(packet)) + '\n</AUTHENTICATED_CONTEXT_PACKET>';
    const rows = [{ type: 'user', sessionId: session, message: { content: prompt } },
      { type: 'assistant', sessionId: session, effort: r.effort, message: { role: 'assistant', model: r.model,
        content: [{ type: 'tool_use', name: 'StructuredOutput', input: raw }] } }];
    const streamRows = [{ type: 'system', subtype: 'init', session_id: session, model: r.model },
      { type: 'result', subtype: 'success', session_id: session, is_error: false, structured_output: raw, result: JSON.stringify(raw) }];
    options.mutateNative?.(rows, streamRows, { packet, fileInput });
    const nativeText = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    const streamText = streamRows.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(native, nativeText); fs.writeFileSync(stream, streamText);
    return { receipt_type: 'adr-014.application', runtime: r.runtime, role: r.role, dispatch_id: r.dispatch_id,
      launch_id: session, session_id: session, requested_model: r.requested_model, requested_effort: r.requested_effort,
      applied_model: r.model, applied_effort: r.effort, observed_model: r.model, observed_effort: r.effort,
      policy_hash: r.policy_hash, transcript: { path: stream, bytes: Buffer.byteLength(streamText), sha256: hash(streamText) },
      selection_evidence: { source: 'claude-session-assistant-transcript', session_id: session,
        assistant_records: 1, model: r.model, effort: r.effort,
        transcript: { path: native, bytes: Buffer.byteLength(nativeText), sha256: hash(nativeText) } } };
  } } } });
  if (useCodex) {
    const dispatch = retainCodexReview(f, dispatchId, raw, packet, binding, fileInput, options);
    result.host_context = { ...(!fileInput ? { original_packet: packets.encodeUniqueContent(packet) } : {}), planning_reference: roleContext.planning_reference,
      selected_refs: packet.required_refs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) };
    input.result = result; input.dispatchId = dispatch.dispatch_id;
    originals.set(input, { raw: structuredClone(raw), priorFindings: structuredClone(priorFindings) });
    return input;
  }
  const dispatch = boundary.dispatch({ runtime: 'claude', role: 'code-review', signals: {}, dispatch_id: dispatchId },
    { ticket: input.ticket, subject_kind: 'phase' });
  input.result = result;
  input.dispatchId = dispatch.dispatch_id;
  originals.set(input, { raw: structuredClone(raw), priorFindings: structuredClone(priorFindings) });
  return input;
}

function retainCodexReview(f, dispatchId, raw, packet, binding, fileInput, options) {
  const packets = require('../../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const codexHome = path.join(f.root, '.planning/codex-fixture');
  process.env.CODEX_HOME = codexHome;
  const agent = "developer_instructions = \u0027\u0027\u0027\nJudge the supplied review context.\n\u0027\u0027\u0027\n";
  const boundary = createDispatchBoundary({ recorder: f.recorder, adapters: { codex: {
    validateGeneratedAgent(r) { return { valid: true, exists: true, content_verified: true, policy_hash: r.policy_hash,
      agent_file: r.agent_file, agent_file_content: agent, agent_file_digest: hash(agent) }; },
    launchStatic(r) {
      const session = crypto.randomUUID(), text = JSON.stringify(raw);
      const prompt = 'launch_digest=' + binding.launch_digest + (fileInput
        ? '\n<AUTHENTICATED_FOCUSED_INPUT>\n' + JSON.stringify(fileInput.input_bundle) + '\n</AUTHENTICATED_FOCUSED_INPUT>'
        : '\n<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packets.encodeUniqueContent(packet)) + '\n</AUTHENTICATED_CONTEXT_PACKET>');
      const { native, nativeText } = writeCodexSession({ home: codexHome, session, worktree: f.root,
        model: r.model, effort: r.effort, prompt, raw, mutate: rows => options.mutateNative?.(rows, null, { packet, fileInput }) });
      const stream = path.join(codexHome, session + '.stream.jsonl');
      const cli = [{ type: 'thread.started', thread_id: session }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }];
      const streamText = cli.map(row => JSON.stringify(row)).join('\n') + '\n';
      fs.writeFileSync(stream, streamText);
      return { receipt_type: 'adr-014.application', runtime: r.runtime, role: r.role, dispatch_id: r.dispatch_id,
        launch_id: session, requested_model: r.requested_model, requested_effort: r.requested_effort,
        applied_model: r.model, applied_effort: r.effort, observed_model: r.model, observed_effort: r.effort,
        policy_hash: r.policy_hash, agent_file: r.agent_file, agent_file_digest: r.agent_file_digest,
        runtime_evidence: { schema: 'shipyard.codex-runtime-evidence.v1', runtime: 'codex', provider: 'openai', session_id: session, ticket: packet.subject,
          worktree: f.root, code_review: binding,
          ...(fileInput ? { input_transport: 'host-files', input_bundle: fileInput.input_bundle,
            input_consumption: { native_session_sha256: hash(nativeText) } } : {}),
          native_session_evidence: { session_id: session, bytes: Buffer.byteLength(nativeText), sha256: hash(nativeText) },
          transcript: { path: stream, bytes: Buffer.byteLength(streamText), sha256: hash(streamText) } } };
    },
  } } });
  return boundary.dispatch({ runtime: 'codex', role: 'code-review', signals: {}, dispatch_id: dispatchId },
    { ticket: packet.subject, subject_kind: 'phase' });
}

function writeCodexSession({ home, session, worktree, model, effort, prompt, raw, mutate }) {
  const text = JSON.stringify(raw), now = new Date();
  const directory = path.join(home, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const native = path.join(directory, session + '.jsonl');
  const rows = [{ type: 'session_meta', payload: { id: session, model_provider: 'openai', cwd: worktree } },
    { type: 'turn_context', payload: { model, effort } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original', last_agent_message: text } }];
  mutate?.(rows);
  const nativeText = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(native, nativeText);
  return { native, nativeText };
}

function originalHistoricalProducer() {
  const source = fs.readFileSync(path.join(__dirname, '../../unit/judgment-artifacts.test.cjs'), 'utf8');
  const gzip = /const preCoverageRepairProducer = \{[\s\S]*?gzip: '([^']+)'/.exec(source)?.[1];
  const bytes = require('node:zlib').gunzipSync(Buffer.from(gzip, 'base64'));
  if (hash(bytes) !== 'd0f5bbba03b66e3c3142c040e37fec87ece7457197ac7013db027c52fdff6428')
    throw new Error('Original historical producer fixture changed');
  const Module = require('node:module');
  const filename = require.resolve('../../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const producer = new Module(filename, module);
  producer.filename = filename; producer.paths = Module._nodeModulePaths(path.dirname(filename));
  producer._compile(bytes.toString('utf8'), filename);
  return producer.exports;
}

function sealInputOnlyHistory(input) {
  return originalHistoricalProducer().sealJudgment(input);
}

module.exports = { originalHistoricalProducer, fixture, retainPlanningInput, setOriginalReview, sealInputOnlyHistory, writeCodexSession };
