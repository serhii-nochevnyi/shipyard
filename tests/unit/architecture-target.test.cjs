'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const authorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-authority-')));
const originalHomedir = os.homedir;
os.homedir = () => authorityHome;
process.on('exit', () => {
  os.homedir = originalHomedir;
  fs.rmSync(authorityHome,{recursive:true,force:true});
});
const { resolveIntegrationBranch, architectureTarget, phaseBinding, PHASE_SUBJECT } = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');

test('configuration wins for the project; foreign repositories keep their own default', () => {
  const config = { git: { base_branch: 'develop' } };
  assert.equal(resolveIntegrationBranch({ config, defaultBranch: 'trunk' }), 'develop');
  assert.equal(resolveIntegrationBranch({ config, repo: 'acme/other', defaultBranch: 'trunk' }), 'trunk');
  let calls = 0;
  assert.equal(resolveIntegrationBranch({ config: {}, exec: (_exe, args) => {
    calls++; assert.deepEqual(args, ['repo','view','--json','defaultBranchRef','--jq','.defaultBranchRef.name']); return 'release';
  } }), 'release');
  assert.equal(calls, 1);
  assert.throws(() => resolveIntegrationBranch({ config: {}, exec: () => '' }), /unavailable/);
});

test('live retargets add and remove review without inventing a conform verdict', () => {
  for (const integrationBranch of ['main','develop','trunk']) {
    for (const base of ['epic/47-policy','ticket/T-47-08']) {
      assert.deepEqual(architectureTarget({ base, integrationBranch }).status, 'skipped-by-target');
    }
    assert.equal(architectureTarget({base:integrationBranch,integrationBranch}).status, 'required');
  }
  assert.equal(architectureTarget({}).required, true);
});

test('aggregate subject binds actual membership, repository, PR, live head and base', () => {
  const row = {phase:47,plan:'.planning/phases/47-policy/47-01-PLAN.md',epic:'epic/47-policy',branch:'ticket/T-47-01'};
  const input = {graph:{tickets:{'T-47-01':row}},state:{'T-47-01':{pr:1,status:'merged'}},phase:47,
    repository:'/repo/.git',pr:9,head:'a'.repeat(40),base:'b'.repeat(40),branch:'epic/47-policy'};
  const subject = phaseBinding(input).subject;
  assert(PHASE_SUBJECT.test(subject));
  for (const edit of [{pr:10},{head:'c'.repeat(40)},{base:'d'.repeat(40)},{repository:'/other/.git'},
    {state:{'T-47-01':{pr:2,status:'merged'}}}, {graph:{tickets:{'T-47-01':row,'T-47-02':{...row,plan:'.planning/phases/47-policy/47-02-PLAN.md'}}}}])
    assert.notEqual(phaseBinding({...input,...edit}).subject,subject);
  assert.throws(() => phaseBinding({...input,branch:'ticket/T-47-01'}), /canonical phase epic/);
});

test('public phase builder reports empty selections as structured build refusals', () => {
  const { fixture, write } = require('./helpers/codex-arch-review-fixtures.cjs');
  const builder = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const f = fixture();
  try {
    const graphDir = path.join(f.root, '.planning/graph');
    write(f.root, '.planning/graph/tickets.json', JSON.stringify({ tickets: {} }));
    let liveLookups = 0;
    const options = { cwd: f.root, graphDir, refreshGit: false,
      getPullRequest: () => { liveLookups++; throw new Error('unexpected live lookup'); } };
    for (const runtime of ['codex', 'claude']) {
      for (const repo of [undefined, 'acme/missing']) {
        assert.throws(() => builder.build(['arch-review', '38-codex-arch-review',
          '--phase', '38', '--pr', '801', '--runtime', runtime,
          ...(repo === undefined ? [] : ['--repo', repo])], options), error => {
          assert.equal(error.code, 'BUILD_REFUSED');
          assert.equal(error.exitCode, 2);
          assert.equal(error.field, repo === undefined ? '--phase' : '--repo');
          assert.equal(error.message, 'deliver-dispatch: phase absent from canonical graph');
          return true;
        });
      }
    }
    assert.equal(liveLookups, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('public phase builder and native context use the explicit aggregate PR and complete evidence', () => {
  const { fixture, write, git, TICKET } = require('./helpers/codex-arch-review-fixtures.cjs');
  const builder = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const f = fixture();
  try {
    const graphDir = path.join(f.root,'.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir,'tickets.json')));
    graph.tickets[TICKET].epic = 'epic/38-codex-arch-review';
    write(f.root,'.planning/graph/tickets.json',JSON.stringify(graph));
    write(f.root,'.planning/phases/38-codex-arch-review/38-01-SUMMARY.md','Original acceptance: installed obligations remain HOLD.');
    write(f.root,'.planning/config.json',JSON.stringify({git:{base_branch:'develop'}}));
    git(f.root,['branch','develop',f.base]);git(f.root,['update-ref','refs/remotes/origin/develop',f.base]);
    git(f.root,['switch','-c',graph.tickets[TICKET].epic]);git(f.root,['add','.']);git(f.root,['commit','-m','phase evidence']);
    f.pr = {...f.pr,number:801,headRefName:graph.tickets[TICKET].epic,headRefOid:git(f.root,['rev-parse','HEAD']),baseRefName:'develop'};
    const options = {cwd:f.root,graphDir,refreshGit:false,getPullRequest:()=>f.pr};
    const args = ['arch-review','38-codex-arch-review','--phase','38','--pr','801'];
    const request = builder.build([...args,'--runtime','codex'],options);
    assert(PHASE_SUBJECT.test(request.scope.ticket));
    const rawState = JSON.parse(fs.readFileSync(path.join(graphDir,'delivery-state.json')));
    const binding = phaseBinding({ graph, state: rawState.tickets || rawState, phase: 38,
      repository: git(f.root,['rev-parse','--path-format=absolute','--git-common-dir']),
      branch: f.pr.headRefName, pr: f.pr.number, head: f.pr.headRefOid, base: f.base });
    const inventoryPath = path.join(authorityHome,'current-phase-inventory.json');
    fs.writeFileSync(inventoryPath,JSON.stringify({rows:[]}),{mode:0o600});
    require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').registerPhaseArchiveRoster({
      worktreePath: f.root, binding, graphDir, inventoryPath,
      expectedInventoryDigest: require('node:crypto').createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex') });
    const prepared = context.prepare(request.scope,{role:'arch-review',signals:{},context:{}},options);
    assert.equal(prepared.prepared.pr,801);
    assert.equal(prepared.prepared.rows[0].id,TICKET);
    assert.match(prepared.launch.context.prompt,/installed obligations remain HOLD/);
    assert.match(prepared.launch.context.prompt,/reviewed implementation change/);
    assert(prepared.prepared.packet.required_refs.some(ref=>ref.path.endsWith('SUMMARY.md')));
    assert.equal(builder.build([...args,'--runtime','claude'],options).phase,'38-codex-arch-review');
    f.pr.baseRefName = graph.tickets[TICKET].epic;
    assert.throws(()=>builder.build([...args,'--runtime','codex'],options),/skipped-by-target/);
    assert.throws(()=>context.prepare(request.scope,{role:'arch-review',signals:{},context:{}},options),/skipped-by-target/);
    f.pr.baseRefName='develop';f.pr.headRefOid='f'.repeat(40);
    assert.throws(()=>context.prepare(request.scope,{role:'arch-review',signals:{},context:{}},options),/identity/);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

for (const repo of [null, 'acme/selected']) {
for (const runtime of ['codex','claude'])
test(`public phase builder and hosts select ${repo ?? 'current project'} from mixed repositories (${runtime})`, async () => {
  const { fixture, write, git, TICKET } = require('./helpers/codex-arch-review-fixtures.cjs');
  const builder = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const f = fixture();
  try {
    const graphDir = path.join(f.root,'.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir,'tickets.json')));
    graph.tickets[TICKET].repo = repo;
    graph.tickets = { foreign: {...graph.tickets[TICKET], repo: repo === null ? 'acme/other' : null, plan: '.planning/phases/38-foreign/38-02-PLAN.md', epic: 'epic/38-codex-arch-review'}, ...graph.tickets };
    graph.tickets[TICKET].epic = 'epic/38-codex-arch-review';
    write(f.root,'.planning/graph/tickets.json',JSON.stringify(graph));
    write(f.root,'.planning/phases/38-codex-arch-review/38-01-SUMMARY.md','Original acceptance: installed obligations remain HOLD.');
    write(f.root,'.planning/config.json',JSON.stringify({git:{base_branch:'develop'}}));
    git(f.root,['branch','develop',f.base]);git(f.root,['update-ref','refs/remotes/origin/develop',f.base]);
    git(f.root,['switch','-c',graph.tickets[TICKET].epic]);git(f.root,['add','.']);git(f.root,['commit','-m','phase evidence']);
    f.pr = {...f.pr,number:801,headRefName:graph.tickets[TICKET].epic,headRefOid:git(f.root,['rev-parse','HEAD']),baseRefName:'develop'};
    const options = {cwd:f.root,graphDir,refreshGit:false,defaultBranch:'develop',getPullRequest:input=>{ assert.equal(input.repo,repo); return f.pr; }};
    const args = ['arch-review','38-codex-arch-review','--phase','38','--pr','801', ...(repo ? ['--repo',repo] : [])];
    const request = builder.build([...args,'--runtime','codex'],options);
    assert(PHASE_SUBJECT.test(request.scope.ticket));
    const rawState = JSON.parse(fs.readFileSync(path.join(graphDir,'delivery-state.json')));
    const binding = phaseBinding({ graph, state: rawState.tickets || rawState, phase: 38,
      repository: git(f.root,['rev-parse','--path-format=absolute','--git-common-dir']), repo,
      branch: f.pr.headRefName, pr: f.pr.number, head: f.pr.headRefOid, base: f.base });
    const inventoryPath = path.join(authorityHome,'current-phase-inventory.json');
    fs.writeFileSync(inventoryPath,JSON.stringify({rows:[]}),{mode:0o600});
    const claudeRequest = builder.build([...args,'--runtime','claude'],options);
    assert.equal(claudeRequest.repo,repo);
    const claude = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
    assert.equal(claude.parseRequest(claudeRequest).repo,repo);
    await assert.rejects(claude.createClaudeRoleHost({...options,getPullRequest:input=>{
      assert.equal(input.repo,repo);
      throw new Error('selected repository reached live PR lookup');
    }}).run(claudeRequest), /selected repository reached live PR lookup/);
    assert.throws(()=>builder.build([...args.slice(0,6),'--repo','acme/missing','--runtime','codex'],options), /phase absent/);
    require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').registerPhaseArchiveRoster({
      worktreePath: f.root, binding, graphDir, inventoryPath,
      expectedInventoryDigest: require('node:crypto').createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex') });
    const prepared = context.prepare(request.scope,{role:'arch-review',signals:{},context:request.context},options);
    assert.equal(prepared.prepared.pr,801);
    assert.equal(prepared.prepared.rows[0].id,TICKET);
    assert.match(prepared.launch.context.prompt,/installed obligations remain HOLD/);
    assert.match(prepared.launch.context.prompt,/reviewed implementation change/);
    assert(prepared.prepared.packet.required_refs.some(ref=>ref.path.endsWith('SUMMARY.md')));
    assert.deepEqual(prepared.prepared.rows.map(x=>x.id),[TICKET]);
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    for (const edit of [{repo: 'acme/missing'}, {repo: repo === null ? 'acme/other' : null},
      {rows: [...binding.rows, {id:'foreign',row:graph.tickets.foreign}]}, {membership: '0'.repeat(64)}]) {
      assert.throws(() => artifacts.selectPhaseArchives(f.root, {...binding,...edit}, {graphDir}), /phase absent|membership|identity|digest/);
    }
    if (runtime === 'codex') {
    const storage = fs.mkdtempSync(path.join(authorityHome,'codex-mixed-'));
    const value = prepared;
    f.head = f.pr.headRefOid;
    const hostModule = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const requestPath = path.join(storage,'request.json');fs.writeFileSync(requestPath,JSON.stringify(request));
    const parsed = hostModule.readRequestFile(requestPath);
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
    const host = { scope: parsed.scope, capabilities, recorder,
      launchStatic(selection, context) {
        const session = require('node:crypto').randomUUID();
        const judgment = { id: request.scope.ticket, pr: f.pr.number, head: f.head,
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
    let output = '';
    await hostModule.runCli(['--args-file', requestPath], { write: text => { output += text; } },
      { ...options, host, capabilities, recorder, agentDir, agentManifest, storageRoot: storage,
        execFileSync(exe,args,opts) {
          if (exe === 'gh') return args[0] === 'repo' ? 'develop' : JSON.stringify(f.pr);
          return require('node:child_process').execFileSync(exe,args,opts);
        } });
    const result = JSON.parse(output);
    assert.equal(result.subject, request.scope.ticket);
    const codexFindings = JSON.parse(fs.readFileSync(path.join(f.root,artifacts.authenticatedArchivePins(f.root).find(pin=>pin.path.endsWith('/findings.json')).path)));
    assert.equal(codexFindings.host_context.phase_repo,repo);
    assert.equal(artifacts.currentArchitectureVerdict({worktreePath:f.root,graphDir,pr:801,head:f.pr.headRefOid,
      headBranch:f.pr.headRefName,baseName:'develop',baseCommit:f.base}).authenticated,true);
    } else {
    const storageRoot = fs.mkdtempSync(path.join(authorityHome, 'claude-mixed-'));
    const native = await claude.createClaudeRoleHost({...options, storageRoot,
      createRuntimeHost: ({scope, controller, recorderDir}) => ({
        scope: {worktree:scope.worktree.path}, controller,
        recorder: require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs').createDurableRecorder(recorderDir),
        capabilities: {supportedModels:['claude-opus-5-5','claude-fable-5','claude-sonnet-5-5'],
          supportedEfforts:['low','medium','high','xhigh','max'],observedModel:true,observedEffort:true},
        async agent(prompt, selection) {
          const marker = '<AUTHENTICATED_CONTEXT_PACKET>\n\n';
          const start = prompt.indexOf(marker) + marker.length;
          const packet = JSON.parse(prompt.slice(start,prompt.indexOf('\n\n</AUTHENTICATED_CONTEXT_PACKET>',start)));
          assert.deepEqual(packet.role_context.ticket_set.map(row=>row.id),[TICKET]);
          const output = {id:packet.subject,pr:801,head:f.pr.headRefOid,base_tree:git(f.root,['rev-parse',f.base+'^{tree}']),
            ticket_set:packet.role_context.ticket_set,ticket_set_digest:packet.role_context.ticket_set_digest,
            verdict:'conform',blocking_count:0,summary:'Fixture review',findings:[]};
          write(f.root,'.shipyard-arch-review-evidence.md','Complete fixture architecture review.');
          const session = 'fixture-'+require('node:crypto').randomUUID();
          const transcript = {path:path.join(storageRoot,session+'.jsonl'),bytes:64,sha256:'a'.repeat(64)};
          const observed = selection.model === 'fable' ? 'claude-fable-5' : selection.model;
          return {output,applicationEvidence:{launch_id:'claude-'+session,session_id:session,process_id:process.pid,runtime_version:'2.1.280',
            applied_model:selection.model,applied_effort:selection.effort,observed_model:observed,observed_effort:selection.effort,
            selection_evidence:{source:'claude-session-assistant-transcript',session_id:session,assistant_records:1,model:observed,effort:selection.effort,transcript},
            stream_evidence:{format:'stream-json',records:1,assistant_messages:1},transcript}};
        }, applicationEvidence:({result})=>result.applicationEvidence,
      }),
    }).run(claudeRequest);
    assert.equal(native.result.verdict, 'conform');
    assert.equal(native.result.host_context.phase_repo, repo);
    }
    const verdictInput = {worktreePath:f.root,graphDir,pr:801,head:f.pr.headRefOid,headBranch:f.pr.headRefName,baseName:'develop',baseCommit:f.base};
    const foreignFamilies = path.join(f.root, artifacts.ARTIFACT_ARCHIVE_DIR, 'foreign-family-');
    for (let index = 0; index < 1001; index++) {
      const family = foreignFamilies + index;
      fs.mkdirSync(family);
      fs.writeFileSync(path.join(family, 'findings.json'), 'foreign findings');
    }
    const originalOpen = fs.openSync, originalReaddir = fs.readdirSync;
    try {
      fs.openSync = function(file, ...args) {
        if (String(file).startsWith(foreignFamilies)) throw new Error('foreign archive body opened');
        return originalOpen.call(this, file, ...args);
      };
      fs.readdirSync = function(file, ...args) {
        if (String(file) === path.join(f.root, artifacts.ARTIFACT_ARCHIVE_DIR)) throw new Error('archive root enumerated');
        return originalReaddir.call(this, file, ...args);
      };
      assert.equal(artifacts.currentArchitectureVerdict(verdictInput).authenticated,true);
      assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,repo}).authenticated,true);
    } finally {
      fs.openSync = originalOpen; fs.readdirSync = originalReaddir;
      for (let index = 0; index < 1001; index++) fs.rmSync(foreignFamilies + index, {recursive:true,force:true});
    }

    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,repo:repo === null ? 'acme/other' : null}),null);
    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,baseCommit:'f'.repeat(40)}),null);
    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,head:'f'.repeat(40)}),null);
    const graphPath = path.join(graphDir,'tickets.json');
    const originalGraph = fs.readFileSync(graphPath);
    graph.tickets[TICKET].repo = repo === null ? 'acme/wrong' : null;
    fs.writeFileSync(graphPath,JSON.stringify(graph));
    assert.throws(()=>artifacts.currentArchitectureVerdict(verdictInput), /phase absent|canonical phase epic|membership|digest|one current phase|independently retained current phase roster/);
    fs.writeFileSync(graphPath,originalGraph);
    const findingsPin = artifacts.authenticatedArchivePins(f.root).find(pin=>pin.path.endsWith('/findings.json'));
    const findingsPath = path.join(f.root,findingsPin.path);
    const originalFindings = fs.readFileSync(findingsPath);
    fs.chmodSync(findingsPath,0o600);
    fs.writeFileSync(findingsPath,JSON.stringify({...JSON.parse(originalFindings),host_context:{...JSON.parse(originalFindings).host_context,phase_repo:'acme/tampered'}}));
    assert.throws(()=>artifacts.currentArchitectureVerdict(verdictInput), /pin|size|changed/);
    fs.writeFileSync(findingsPath,originalFindings); fs.chmodSync(findingsPath,0o400);
    f.pr.baseRefName = graph.tickets[TICKET].epic;
    assert.throws(()=>builder.build([...args,'--runtime','codex'],options),/skipped-by-target/);
    assert.throws(()=>context.prepare(request.scope,{role:'arch-review',signals:{},context:request.context},options),/skipped-by-target/);
    f.pr.baseRefName='develop';f.pr.headRefOid='f'.repeat(40);
    assert.throws(()=>context.prepare(request.scope,{role:'arch-review',signals:{},context:request.context},options),/identity/);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

}

test('public live verifier skips an epic and refuses bare status authority on a non-main integration branch', () => {
  const { fixture, write, git } = require('./helpers/codex-arch-review-fixtures.cjs');
  const { verifyArchitectureTarget } = require('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs');
  const f=fixture();
  try {
    write(f.root,'.planning/config.json',JSON.stringify({git:{base_branch:'develop'}}));
    const live={...f.pr,baseRefName:'epic/38-policy'};
    const input={pr:live.number,worktreePath:f.root,getPullRequest:()=>live};
    assert.equal(verifyArchitectureTarget(input).status,'skipped-by-target');
    live.baseRefName='develop';live.body='gate_status: arch-review=conform, head='+live.headRefOid;
    const checked=verifyArchitectureTarget(input);
    assert.equal(checked.status,'required');assert.equal(checked.ready,false);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('mixed repository binding selects only explicit target members', () => {
  const row = {phase:47,plan:'.planning/phases/47-policy/47-01-PLAN.md',epic:'epic/47-policy'};
  const graph = {tickets:{local:{...row,repo:null},foreign:{...row,repo:'acme/other'}}};
  const input = {graph,state:{},phase:47,repository:'/repo/.git',pr:9,head:'a'.repeat(40),base:'b'.repeat(40),branch:row.epic};
  assert.deepEqual(phaseBinding({...input,repo:null}).rows.map(x=>x.id), ['local']);
  assert.deepEqual(phaseBinding({...input,repo:'acme/other'}).rows.map(x=>x.id), ['foreign']);
  assert.throws(()=>phaseBinding({...input,repo:'acme/missing'}), /phase absent/);
  assert.throws(()=>phaseBinding({...input,repo:'acme/other',branch:'epic/foreign'}), /canonical phase epic/);
  assert.equal(phaseBinding({...input,repo:null}).subject,phaseBinding({...input,graph:{tickets:{local:graph.tickets.local}}}).subject);
});
