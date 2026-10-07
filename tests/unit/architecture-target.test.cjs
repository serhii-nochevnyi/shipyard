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
