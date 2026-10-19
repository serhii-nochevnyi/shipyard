'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const artifact = require('../../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const target = require('../../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
const core = require('../../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
const { createDurableRecorder, createDispatchBoundary } = require('../../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const git = (root, args) => execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
function fixture(suffix = 'plain') {
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
    const normalized = core.normalizeResult(rawResult || JSON.parse(fs.readFileSync(path.join(__dirname,'review.json'),'utf8')),{round,scope:round===1?'full':'delta',readSource:file=>fs.readFileSync(path.join(root,file),'utf8')});
    const referenceDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../../../plugins/delivery-pipeline/references/code-review.md'))).digest('hex');
    const contract = core.contractDigest(referenceDigest);
    fs.writeFileSync(path.join(root,'.shipyard-code-review-evidence.md'),'Complete review of all phase changes.\n');
    return {worktreePath:root,base:'main',role:'code-review',ticket:binding.subject,pr:52,ticketSet:binding.ticketSet,ticketSetDigest:binding.membership,recorder,dispatchId:dispatch.receipt.dispatch_id,result:{...normalized,id:binding.subject,pr:52,head:git(root,['rev-parse','HEAD']),base_tree:git(root,['rev-parse',base+'^{tree}']),ticket_set:binding.ticketSet,ticket_set_digest:binding.membership,contract_digest:contract,reuse_key:core.reuseKey({head:git(root,['rev-parse','HEAD']),baseCommit:base,contractDigest:contract}),prior_head:priorHead,dispositions_digest:null}};
  }
  function lookup() { return artifact.currentCodeReviewVerdict({worktreePath:root,pr:52,head:git(root,['rev-parse','HEAD']),baseName:'main',baseCommit:base,graphDir,headBranch:branch}); }
  return {root,base,branch,phase,graph,state,graphDir,writeGraph,advance,input,lookup,recorder,dispatch:(role,ticket)=>boundary.dispatch({runtime:'claude',role,signals:{}},{ticket,...(['code-review','arch-review'].includes(role)?{subject_kind:'phase'}:{})}),git:args=>git(root,args),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
module.exports={fixture};
