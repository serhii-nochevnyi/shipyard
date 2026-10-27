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
const { resolveIntegrationBranch, architectureTarget, phaseBinding, PHASE_SUBJECT, buildSubject, parseSubject,
  repositoryIdentity, acceptedRepositoryValues, PHASE_SUBJECT_ROLES, PHASE_ONLY_ROLES } = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');

function semanticArchitectureProcesses({ worktree, storage, agentText, artifacts }) {
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const captureRoot = path.resolve(__dirname, '../fixtures/captured');
  const registry = JSON.parse(fs.readFileSync(path.join(captureRoot, 'boundaries/codex-agent-stream.json')));
  const captured = name => {
    const file = registry.fixtures.find(file => file.endsWith('/codex-agent-stream-' + name + '.jsonl'));
    assert.ok(file, 'registered original native shapes are required');
    return fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8').trim().split('\n')
      .map(JSON.parse).filter(row => !row.shipyard_fixture);
  };
  const parent = captured('parent'), cli = captured('exec');
  const template = (rows, predicate) => {
    const row = rows.find(predicate);
    assert.ok(row, 'registered original native template is required');
    return structuredClone(row);
  };
  const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  const launches = [];
  const codexHome = path.join(storage, 'codex-home');
  return { launches, codexHome, probe: { status: 'available', executable: 'codex', runtime_version: registry.cli_version },
    spawn() {
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let input = '';
      child.stdin = { write(raw) { input += raw; }, end() { process.nextTick(() => {
        try {
          input = input.replace(/\n$/, '');
          const payload = JSON.parse(input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\s*([\s\S]*?)\s*<\/AUTHENTICATED_SEMANTIC_REVIEW>/)[1]);
          if (payload.input_transport === 'host-files') {
            for (const source of payload.material) source.content = fs.readFileSync(path.resolve(worktree, source.read_path), 'utf8');
            payload.originals = payload.originals.map(original => {
              const original_text = fs.readFileSync(path.resolve(worktree, original.read_path), 'utf8');
              return { reference: original.reference, native: original.native, original_text, result: JSON.parse(original_text) };
            });
          }
          if (payload.stage === 'final') {
            assert.equal(launches.length, 2);
            assert.equal(payload.originals.length, 2);
            for (const original of payload.originals) assert.deepEqual(artifacts.readSemanticOriginal({ worktreePath: worktree,
              snapshot_sha256: payload.snapshot_sha256, assignment_id: original.reference.assignment_id }), original);
          }
          const identity = payload.reviewed_identity, contract = 'shipyard.semantic-review.v1';
          const result = { schema: contract, review_contract: contract, role: 'arch-review', stage: payload.stage,
            runtime: 'codex', subject: payload.subject, snapshot_sha256: payload.snapshot_sha256,
            assignment_id: payload.assignment?.id || null, binding_sha256: payload.binding_sha256, reviewed_identity: identity,
            completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [], limitations: [],
            required_context: [], unread: [], conclusions: ['Evaluated the actual source change against ADR-014.'],
            coverage: payload.assignment?.primary_obligation_ids || payload.obligation_ids,
            seams: payload.seams.map(seam => ({ id: seam.id, disposition: 'resolved', rationale: 'Read the actual source boundary.' })),
            originals: payload.originals?.map(original => original.reference) || [],
            evidence_markdown: 'Complete fixture architecture review against the original ADR and aggregate diff.' };
          if (payload.stage === 'final') Object.assign(result, { phase: identity.phase, id: payload.subject,
            pr: identity.pr, repository: identity.repository, base_commit: identity.base, merge_base: identity.merge_base,
            verdict: 'conform', head: identity.head, head_tree: identity.head_tree, base: identity.base_ref,
            base_tree: identity.merge_base_tree, ticket_set: identity.ticket_set,
            ticket_set_digest: identity.ticket_set_digest, summary: 'Independent aggregate architecture judgment.' });
          const session = crypto.randomUUID(), text = JSON.stringify(result);
          const meta = template(parent, row => row.type === 'session_meta');
          Object.assign(meta.payload, { id: session, session_id: session, cwd: worktree, runtime_workspace_roots: [worktree] });
          const context = template(parent, row => row.type === 'turn_context');
          const model = /^model = "(.+)"$/m.exec(agentText)[1];
          const effort = /^model_reasoning_effort = "(.+)"$/m.exec(agentText)[1];
          Object.assign(context.payload, { model, effort, cwd: worktree, workspace_roots: [worktree] });
          context.payload.sandbox_policy.type = 'read-only';
          Object.assign(context.payload.collaboration_mode.settings, { model, reasoning_effort: effort });
          const start = template(parent, row => row.payload?.type === 'task_started');
          const turn = start.payload.turn_id; context.payload.turn_id = turn;
          const developer = template(parent, row => row.payload?.role === 'developer');
          developer.payload.content = [{ type: 'input_text', text: runtime.generatedInstructions(agentText) }];
          const user = template(parent, row => row.payload?.role === 'user');
          user.payload.content = [{ type: 'input_text', text: input }];
          const final = template(parent, row => row.payload?.phase === 'final_answer');
          final.payload.content.forEach(block => { block.text = text; });
          final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
          const complete = template(parent, row => row.payload?.type === 'task_complete');
          Object.assign(complete.payload, { turn_id: turn, last_agent_message: text });
          const now = new Date(), directory = path.join(codexHome, 'sessions', String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, session + '.jsonl'), serialize([meta, context, start, developer, user,
            template(parent, row => row.payload?.type === 'token_count'), final, complete]));
          const stream = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
            .map(type => template(cli, row => row.type === type));
          stream[0].thread_id = session; stream[2].item.text = text;
          launches.push({ payload, result, session });
          child.stdout.emit('data', Buffer.from(serialize(stream))); child.emit('close', 0);
        } catch (error) { child.emit('error', error); }
      }); } };
      return child;
    } };
}

test('phase subject roles and phase-only roles are exact frozen shared lists', () => {
  assert.deepEqual(PHASE_SUBJECT_ROLES, ['arch-review', 'code-review']);
  assert.deepEqual(PHASE_ONLY_ROLES, ['code-review']);
  assert.ok(Object.isFrozen(PHASE_SUBJECT_ROLES));
  assert.ok(Object.isFrozen(PHASE_ONLY_ROLES));
});

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

test('subject repositories allow spaces but refuse the delete control character', () => {
  const fields = { phase: 50, input: 'ADR-030', repository: '/work/my repo/.git' };
  const subject = buildSubject('planning-input', fields);
  assert.equal(parseSubject('planning-input', subject).repository, '/work/my repo/.git');
  assert.throws(() => buildSubject('planning-input', { ...fields, repository: '/work/my\x7frepo/.git' }), /repository/);
  assert.equal(parseSubject('planning-input', subject.replace('my repo', 'my\x7frepo')), null);
});

test('repository identity ignores an inherited git scope pointing at another repository', () => {
  const { execFileSync } = require('node:child_process');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-git-env-')));
  const make = (name, remote) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    return dir;
  };
  const saved = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].map(key => [key, process.env[key]]));
  try {
    const mine = make('mine', 'https://github.com/Acme/Mine.git');
    const other = make('other', 'https://github.com/Acme/Other.git');
    const expected = path.join(mine, '.git');
    assert.equal(repositoryIdentity(mine), expected);
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_COMMON_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
    assert.equal(repositoryIdentity(mine), expected);
    assert.deepEqual(acceptedRepositoryValues(mine), [expected, 'acme/mine']);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  }
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
    write(f.root,'.planning/config.json',JSON.stringify({git:{base_branch:'develop'},delivery_pipeline:{code_review:'report'}}));
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
    assert.equal(prepared.prepared.packet.review_contract, context.FOCUSED_CONTRACT);
    assert.match(prepared.launch.context.prompt,/reviewed implementation change/);
    assert.deepEqual(prepared.prepared.binding.ticketSet.map(row => row.id), [TICKET]);
    const selectedAdr = prepared.prepared.packet.refs.find(ref => ref.path.endsWith('ADR-014-host-bound-review.md'));
    assert.ok(selectedAdr);
    assert.match(selectedAdr.content, /exact live PR diff/);
    assert.equal(selectedAdr.sha256, require('node:crypto').createHash('sha256').update(selectedAdr.content).digest('hex'));
    const adrSelection = prepared.prepared.packet.adr_selection.find(ref => ref.path === selectedAdr.path);
    assert.ok(adrSelection.selected);
    assert.ok(adrSelection.reasons.some(reason => reason.includes('plan reference')));
    assert.match(prepared.prepared.packet.diff.content, /reviewed implementation change/);
    assert.equal(prepared.prepared.packet.diff.content, git(f.root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=50', f.base + '...' + f.pr.headRefOid]) + '\n');
    assert.equal(prepared.prepared.packet.refs.some(ref => ref.path.endsWith('SUMMARY.md')), false);
    assert.equal(fs.readFileSync(path.join(f.root, '.planning/phases/38-codex-arch-review/38-01-SUMMARY.md'), 'utf8'),
      'Original acceptance: installed obligations remain HOLD.');
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
  const originalCodexHome = process.env.CODEX_HOME, originalPath = process.env.PATH;
  try {
    let graphDir = path.join(f.root,'.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir,'tickets.json')));
    graph.tickets[TICKET].repo = repo;
    graph.tickets = { foreign: {...graph.tickets[TICKET], repo: repo === null ? 'acme/other' : null, plan: '.planning/phases/38-foreign/38-02-PLAN.md', epic: 'epic/38-codex-arch-review'}, ...graph.tickets };
    graph.tickets[TICKET].epic = 'epic/38-codex-arch-review';
    write(f.root,'.planning/graph/tickets.json',JSON.stringify(graph));
    write(f.root,'.planning/phases/38-codex-arch-review/38-01-SUMMARY.md','Original acceptance: installed obligations remain HOLD.');
    write(f.root,'.planning/config.json',JSON.stringify({git:{base_branch:'develop'},delivery_pipeline:{code_review:'report'}}));
    git(f.root,['branch','develop',f.base]);git(f.root,['update-ref','refs/remotes/origin/develop',f.base]);
    git(f.root,['switch','-c',graph.tickets[TICKET].epic]);git(f.root,['add','.']);git(f.root,['commit','-m','phase evidence']);
    f.pr = {...f.pr,number:801,headRefName:graph.tickets[TICKET].epic,headRefOid:git(f.root,['rev-parse','HEAD']),baseRefName:'develop'};
    const planningRoot = f.planningRoot = f.root + '-planning';
    git(f.root, ['worktree','add','-b','planning-fixture',planningRoot,f.pr.headRefOid]);
    graphDir = path.join(planningRoot,'.planning/graph');
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
    assert.equal(prepared.prepared.packet.review_contract, context.FOCUSED_CONTRACT);
    assert.match(prepared.launch.context.prompt,/reviewed implementation change/);
    assert.deepEqual(prepared.prepared.binding.ticketSet.map(row => row.id), [TICKET]);
    const selectedAdr = prepared.prepared.packet.refs.find(ref => ref.path.endsWith('ADR-014-host-bound-review.md'));
    assert.ok(selectedAdr);
    assert.match(selectedAdr.content, /exact live PR diff/);
    assert.equal(selectedAdr.sha256, require('node:crypto').createHash('sha256').update(selectedAdr.content).digest('hex'));
    const adrSelection = prepared.prepared.packet.adr_selection.find(ref => ref.path === selectedAdr.path);
    assert.ok(adrSelection.selected);
    assert.ok(adrSelection.reasons.some(reason => reason.includes('plan reference')));
    assert.match(prepared.prepared.packet.diff.content, /reviewed implementation change/);
    assert.equal(prepared.prepared.packet.diff.content, git(f.root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=50', f.base + '...' + f.pr.headRefOid]) + '\n');
    assert.equal(prepared.prepared.packet.refs.some(ref => ref.path.endsWith('SUMMARY.md')), false);
    assert.equal(fs.readFileSync(path.join(f.root, '.planning/phases/38-codex-arch-review/38-01-SUMMARY.md'), 'utf8'),
      'Original acceptance: installed obligations remain HOLD.');
    assert.deepEqual(prepared.prepared.rows.map(x=>x.id),[TICKET]);
    const artifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    for (const edit of [{repo: 'acme/missing'}, {repo: repo === null ? 'acme/other' : null},
      {rows: [...binding.rows, {id:'foreign',row:graph.tickets.foreign}]}, {membership: '0'.repeat(64)}]) {
      assert.throws(() => artifacts.selectPhaseArchives(f.root, {...binding,...edit}, {graphDir}), /phase absent|membership|identity|digest/);
    }
    if (runtime === 'codex') {
    const storage = fs.mkdtempSync(path.join(authorityHome,'codex-mixed-'));
    const value = prepared;
    const hostModule = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const requestPath = path.join(storage,'request.json');fs.writeFileSync(requestPath,JSON.stringify(request));
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
    const native = semanticArchitectureProcesses({ worktree: f.root, storage, agentText: text, artifacts });
    process.env.CODEX_HOME = native.codexHome;
    const expectedRepoArgs = ['repo', 'view', ...(repo ? [repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'];
    const bin = path.join(storage, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!' + process.execPath + '\n' + [
      "'use strict';", "const assert = require('node:assert/strict');",
      'assert.deepEqual(process.argv.slice(2), ' + JSON.stringify(expectedRepoArgs) + ');',
      "process.stdout.write('develop\\n');", '',
    ].join('\n'), { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + process.env.PATH;
    let output = '';
    await hostModule.runCli(['--args-file', requestPath], { write: text => { output += text; } },
      { ...options, capabilities, recorder, agentDir, agentManifest, storageRoot: storage,
        probe: { ...native.probe, capabilities }, spawn: native.spawn, env: { ...process.env },
        execFileSync(exe,args,opts) {
          if (exe === 'gh') { assert.deepEqual(args, expectedRepoArgs); return 'develop'; }
          return require('node:child_process').execFileSync(exe,args,opts);
        } });
    const result = JSON.parse(output);
    assert.equal(result.subject, request.scope.ticket);
    const finalManifest = JSON.parse(fs.readFileSync(result.artifact.artifact_path));
    const codexFindings = JSON.parse(fs.readFileSync(path.resolve(f.root, finalManifest.files.findings.path)));
    assert.equal(codexFindings.stage, 'final');
    assert.equal(codexFindings.reviewed_identity.repo,repo);
    assert.deepEqual(codexFindings.ticket_set.map(row => row.id), [TICKET]);
    assert.equal(native.launches.length, 3);
    assert.deepEqual(native.launches.map(launch => launch.payload.stage), ['worker', 'worker', 'final']);
    assert.equal(new Set(native.launches.map(launch => launch.session)).size, 3);
    assert.equal(codexFindings.originals.length, 2);
    const finalRecord = recorder.getVerifiedRecord(result.dispatch_id);
    assert.equal(finalRecord.role, 'arch-review');
    assert.equal(finalRecord.receipt.runtime_evidence.session_id, native.launches[2].session);
    assert.ok(codexFindings.originals.every(original => original.dispatch_id !== result.dispatch_id));
    const authorityFile = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const cachedAuthority = require.cache[authorityFile]; delete require.cache[authorityFile];
    try {
      const coldAuthority = require(authorityFile);
      assert.equal(coldAuthority.currentArchitectureVerdict({worktreePath:f.root,graphDir,pr:801,head:f.pr.headRefOid,
        headBranch:f.pr.headRefName,baseName:'develop',baseCommit:f.base,repo}).authenticated,true);
    } finally { require.cache[authorityFile] = cachedAuthority; }
    assert.equal(artifacts.currentArchitectureVerdict({worktreePath:f.root,graphDir,pr:801,head:f.pr.headRefOid,
      headBranch:f.pr.headRefName,baseName:'develop',baseCommit:f.base}).authenticated,true);
    } else {
    const storageRoot = fs.mkdtempSync(path.join(authorityHome, 'claude-mixed-'));
    const native = await claude.createClaudeRoleHost({...options, storageRoot,
      createRuntimeHost: ({scope, controller, recorderDir, transcriptDir}) => {
        const runtime = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
        const captureStart = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs').capture;
        const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/captured/boundaries/claude-stream.json')));
        const streamPath = registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
        assert.ok(streamPath, 'registered original Claude stream is required');
        const records = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
          .map(JSON.parse).filter(record => !record.shipyard_fixture);
        const template = predicate => structuredClone(records.find(predicate));
        const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
        const session = require('node:crypto').randomUUID();
        return runtime.createClaudeRuntimeHost({scope, controller, recorderDir, transcriptDir,
          startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
          uuid: () => session, sessionTranscriptRoot: path.join(storageRoot, 'native'),
          probe: {status:'available', executable:'claude-fixture', runtime_version:registry.cli_version,
            capabilities:{assistantTranscriptEvidence:true, restrictedTools:true, sandboxedBash:true}},
          spawn(_file, args) {
            const {EventEmitter} = require('node:events');
            const child = new EventEmitter(); child.pid = process.pid;
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            let framedInput = '';
            child.stdin = {write(value) { framedInput += value; }, end() {
              process.nextTick(() => {
                assert.ok(framedInput.endsWith('\n'));
                const userInput = JSON.parse(framedInput.slice(0, -1));
                const prompt = userInput.message.content;
                const encoded = JSON.parse(prompt.split('<AUTHENTICATED_CONTEXT_PACKET>')[1].split('</AUTHENTICATED_CONTEXT_PACKET>')[0]);
                const packet = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs').decodeUniqueContent(encoded);
                assert.deepEqual(packet.role_context.ticket_set.map(row=>row.id),[TICKET]);
                const focusedFields = JSON.parse(prompt.split('Echo these focused subject fields: ')[1].split('\n')[0]);
                const output = {...focusedFields, review_completeness:'complete', limitations:[], unresolved_sources:[], id:packet.subject,pr:801,head:f.pr.headRefOid,base_tree:git(f.root,['rev-parse',f.base+'^{tree}']),
                  ticket_set:packet.role_context.ticket_set,ticket_set_digest:packet.role_context.ticket_set_digest,
                  verdict:'conform',blocking_count:0,summary:'Fixture review',findings:[],
                  evidence_markdown:'Complete fixture architecture review.'};
                write(f.root,'.shipyard-arch-review-evidence.md','Complete fixture architecture review.');
                const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
                const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
                const init = template(row => row.type === 'system' && row.subtype === 'init');
                Object.assign(init, {session_id:session, model, cwd:f.root});
                const assistant = template(row => row.type === 'assistant');
                assistant.session_id = session; assistant.message.model = observedModel;
                assistant.message.content[0].input = output;
                const final = template(row => row.type === 'result');
                Object.assign(final, {session_id:session, is_error:false, structured_output:output, result:JSON.stringify(output)});
                const nativeFile = path.join(storageRoot, 'native/project', session + '.jsonl');
                fs.mkdirSync(path.dirname(nativeFile), {recursive:true});
                const nativeAssistant = {...structuredClone(assistant), sessionId:session, effort};
                fs.writeFileSync(nativeFile, serialize([{...userInput, sessionId:session}, nativeAssistant]));
                const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
                const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
                const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
                captureStart({hook_event_name:'SessionStart', source:'startup', session_id:session,
                  transcript_path:nativeFile, cwd:f.root}, {
                  evidenceFile:hookValue('--evidence-file'), expectedSession:hookValue('--expected-session')});
                child.stdout.emit('data', Buffer.from(serialize([init, assistant, final])));
                child.emit('close', 0, null);
              });
            }};
            return child;
          }});
      },
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
      assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,worktreePath:planningRoot,repo}).authenticated,true);
      assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,worktreePath:planningRoot,repo,head:'f'.repeat(40)}),null);
      assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,worktreePath:planningRoot,repo,baseCommit:'f'.repeat(40)}),null);
      assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,worktreePath:planningRoot,repo,baseName:'main'}),null);
      assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,worktreePath:planningRoot,repo:repo === null ? 'acme/other' : null}),null);
    } finally {
      fs.openSync = originalOpen; fs.readdirSync = originalReaddir;
      for (let index = 0; index < 1001; index++) fs.rmSync(foreignFamilies + index, {recursive:true,force:true});
    }

    const foreignCheckout = path.join(f.root,'foreign-checkout');
    fs.mkdirSync(foreignCheckout);
    git(foreignCheckout,['init','-b','foreign']);
    assert.notEqual(git(foreignCheckout,['rev-parse','--path-format=absolute','--git-common-dir']),git(f.root,['rev-parse','--path-format=absolute','--git-common-dir']));
    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,worktreePath:foreignCheckout,repo}),null);

    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,repo:repo === null ? 'acme/other' : null}),null);
    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,baseCommit:'f'.repeat(40)}),null);
    assert.equal(artifacts.currentArchitectureVerdict({...verdictInput,head:'f'.repeat(40)}),null);
    const graphPath = path.join(graphDir,'tickets.json');
    const originalGraph = fs.readFileSync(graphPath);
    graph.tickets[TICKET].repo = repo === null ? 'acme/wrong' : null;
    fs.writeFileSync(graphPath,JSON.stringify(graph));
    if (runtime === 'codex') assert.equal(artifacts.currentArchitectureVerdict(verdictInput),null);
    else assert.throws(()=>artifacts.currentArchitectureVerdict(verdictInput), /phase absent|canonical phase epic|membership|digest|one current phase|independently retained current phase roster/);
    fs.writeFileSync(graphPath,originalGraph);
    const findingsPin = artifacts.authenticatedArchivePins(f.root).find(pin => pin.path.endsWith('/findings.json')
      && (runtime !== 'codex' || JSON.parse(fs.readFileSync(path.join(f.root, pin.path))).stage === 'final'));
    const findingsPath = path.join(f.root,findingsPin.path);
    const originalFindings = fs.readFileSync(findingsPath);
    fs.chmodSync(findingsPath,0o600);
    const tamperedFindings = JSON.parse(originalFindings);
    if (runtime === 'codex') tamperedFindings.reviewed_identity.repo = 'acme/tampered';
    else tamperedFindings.host_context.phase_repo = 'acme/tampered';
    fs.writeFileSync(findingsPath,JSON.stringify(tamperedFindings));
    assert.throws(()=>artifacts.currentArchitectureVerdict(verdictInput), /pin|size|changed/);
    fs.writeFileSync(findingsPath,originalFindings); fs.chmodSync(findingsPath,0o400);
    f.pr.baseRefName = graph.tickets[TICKET].epic;
    assert.throws(()=>builder.build([...args,'--runtime','codex'],options),/skipped-by-target/);
    assert.throws(()=>context.prepare(request.scope,{role:'arch-review',signals:{},context:request.context},options),/skipped-by-target/);
    f.pr.baseRefName='develop';f.pr.headRefOid='f'.repeat(40);
    assert.throws(()=>context.prepare(request.scope,{role:'arch-review',signals:{},context:request.context},options),/identity/);
  } finally {
    process.env.PATH = originalPath;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(f.root,{recursive:true,force:true}); if (f.planningRoot) fs.rmSync(f.planningRoot,{recursive:true,force:true});}
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

test('every PHASE_SUBJECT importer shares the one definition', () => {
  const dir = '../../plugins/delivery-pipeline/scripts/';
  for (const name of ['run-contract', 'dispatch-record', 'role-artifact', 'dispatch-boundary', 'codex-arch-review-context']) {
    const source = fs.readFileSync(path.join(__dirname, dir, name + '.cjs'), 'utf8');
    assert.match(source, /architecture-target\.cjs/, name);
    assert.doesNotThrow(() => require(dir + name + '.cjs'), name);
  }
  assert.ok(PHASE_SUBJECT.test(`phase=1-x;repository=/a b/.git;tickets=${'a'.repeat(64)};pr=1;head=${'b'.repeat(40)};base=${'c'.repeat(40)}`));
});
