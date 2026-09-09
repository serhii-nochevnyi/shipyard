const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');
// Diagnostic only: prints observed behavior; assertions and fixes belong to the
// corresponding implementation tickets. All mutations target temporary fixtures.
const root = path.resolve(process.argv[2] || process.cwd());
const gsdRoot = path.resolve(process.argv[3] || path.join(os.homedir(),'.codex'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'shipyard-recheck-probes-'));
fs.mkdirSync(scratch, {recursive:true});
const out = [];
function project(name, cfg) {
  const dir = path.join(scratch,name);
  fs.mkdirSync(path.join(dir,'.planning'),{recursive:true});
  fs.writeFileSync(path.join(dir,'.planning/config.json'),JSON.stringify(cfg));
  return dir;
}
const brokenProject=project('known-corrupt-config',{});
fs.writeFileSync(path.join(brokenProject,'.planning/config.json'),'{"pipeline":{"auto_merge":"off"');
const broken=require(path.join(root,'plugins/delivery-pipeline/scripts/pipeline-config.cjs')).loadConfig(brokenProject);
out.push({probe:'known-T-26-02',autoMerge:broken.config.auto_merge,valid:broken.valid,warnings:broken.warnings});
const bins = path.join(scratch,'bin');
fs.mkdirSync(bins,{recursive:true});
for (const [bin,version] of [['codex','codex-cli 0.147.0'],['claude','2.1.263 (Claude Code)']]) {
  fs.writeFileSync(path.join(bins,bin),'#!/bin/sh\nprintf "%s\\n" '+JSON.stringify(version)+'\n',{mode:0o755});
}
const configRoot = path.join(scratch,'codex-config');
fs.mkdirSync(path.join(configRoot,'agents'),{recursive:true});
fs.writeFileSync(path.join(configRoot,'config.toml'),'[agents.shipyard-integrator]\nconfig_file = "agents/shipyard-integrator.toml"\n');
fs.writeFileSync(path.join(configRoot,'agents/shipyard-integrator.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
const tuner = path.join(root,'plugins/delivery-pipeline/scripts/gsd-tune.cjs');
const env = {...process.env, PATH: bins+path.delimiter+process.env.PATH, CODEX_HOME:configRoot};
for (const [name,cfg,extra] of [
  ['codex-agent-floor',{runtime:'codex',git:{branching_strategy:'none'}},{}],
  ['fable-old-pin',{runtime:'claude',pipeline:{fable:'auto'},git:{branching_strategy:'none'}},{ANTHROPIC_DEFAULT_FABLE_MODEL:'claude-fable-5'}],
]) {
  const cwd=project(name,cfg);
  const applied=spawnSync(process.execPath,[tuner,'--apply','--json'],{cwd,env:{...env,...extra},encoding:'utf8',timeout:15000});
  const r=spawnSync(process.execPath,[tuner,'--json'],{cwd,env:{...env,...extra},encoding:'utf8',timeout:15000});
  const parsed=JSON.parse(r.stdout);
  out.push({probe:name,applyExit:applied.status,exit:r.status,blockers:parsed.blockers,drift:parsed.drift.length});
}
const remapProject=project('codex-remap',{runtime:'codex',model_profile_overrides:{codex:{sonnet:{model:'gpt-6-astra'}}}});
const gen=require(path.join(root,'scripts/gen-codex-shipyard.cjs'));
const logs=[];
const policy=gen.codexModelPolicy(path.join(root,'plugins/delivery-pipeline'),gsdRoot,{cwd:remapProject,env:{...env,SHIPYARD_CODEX_CLI_VERSION:'0.147.0'},log:m=>logs.push(m.trim())});
out.push({probe:'codex-remap-bypasses-floor',palette:policy.palette,actual:policy.forRole('ci-fix'),logs});
const installedAgents=path.join(scratch,'upgrade-agents');
fs.mkdirSync(installedAgents,{recursive:true});
let freshLow=[];
for (const version of ['0.153.4','0.147.0']) {
  const output=path.join(scratch,'generated-'+version);
  const result=spawnSync(process.execPath,[path.join(root,'scripts/gen-codex-shipyard.cjs'),'--plugin',path.join(root,'plugins/delivery-pipeline'),'--out',output,'--codex-home',gsdRoot,'--phase','2'],{cwd:project('generator-upgrade',{runtime:'codex'}),env:{...process.env,SHIPYARD_CODEX_CLI_VERSION:version},encoding:'utf8',timeout:30000});
  if(result.status!==0) throw new Error(result.stderr);
  const produced=fs.readdirSync(path.join(output,'agents'));
  for(const file of produced) fs.copyFileSync(path.join(output,'agents',file),path.join(installedAgents,file));
  if(version==='0.147.0') freshLow=produced;
}
out.push({probe:'upgrade-stale-deep-agents',freshLowDeep:freshLow.filter(f=>f.includes('-deep')),installedDeep:fs.readdirSync(installedAgents).filter(f=>f.includes('-deep'))});
const {computeVerdict}=require(path.join(root,'plugins/delivery-pipeline/scripts/failure-signature.cjs'));
const seq=['A','B','A','A'];
const events=[];
const verdicts=[];
seq.forEach((signature,i)=>{
  verdicts.push(computeVerdict(events,{signature,head:'head'+i}).verdict);
  events.push({event:'attempt',signature,head:'head'+i,outcome:'red',n:i+1,effort:'high'});
});
out.push({probe:'nonconsecutive-exhaustion',sequence:seq,verdicts});
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const source=fs.readFileSync(path.join(root,'plugins/delivery-pipeline/workflows/fix-round.mjs'),'utf8').replace('export const meta =','const meta =');
const run=new AsyncFunction('args','agent','parallel','phase',source);
async function capture(strategy) {
  let captured;
  await run({prs:[{id:'T-01-01',pr:1,branch:'ticket/test',worktreePath:'/tmp/test',planPath:'/tmp/PLAN.md',needsCiFix:true,strategy,model:'opus',effort:'max'}],ciFixRefPath:'/ci.md',reviewFixRefPath:'/review.md',reinitScript:'/scripts/reviewers.cjs'}, async(prompt,options)=>{captured={prompt,options};return {status:'no-op'};}, jobs=>Promise.all(jobs.map(j=>j())),()=>{});
  return captured;
}
(async()=>{
  const a=await capture('fix'),b=await capture('rethink');
  out.push({probe:'workflow-strategy',identicalPrompts:a.prompt===b.prompt,hasRethink:b.prompt.includes('rethink'),effortApplied:b.options.effort});
  console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
