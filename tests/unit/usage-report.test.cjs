'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { report } = require('../../plugins/delivery-pipeline/scripts/usage-report.cjs');
const claude = (usage, extra = {}) => ({type:'assistant', requestId:'r1', sessionId:'s1',
  message:{id:'m1',model:'example-model',usage,...extra}});
const files = (...rows) => [{source:'fixture',rows}];

test('Claude streaming updates and file replay count a response once', () => {
  const a=claude({input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:100,output_tokens:1});
  const b=claude({input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:100,output_tokens:12},{stop_reason:'end_turn'});
  const r=report([...files(a,b),...files(a,b)]);
  assert.equal(r.groups[0].input_tokens,105);
  assert.equal(r.groups[0].provider, 'anthropic');
  assert.equal(r.groups[0].output_tokens,12);
  assert.equal(r.groups[0].observations,1);
  assert.equal(r.groups[0].finalized,1);
});
test('partial output and omitted cache counters remain unknown', () => {
  const r=report(files(claude({input_tokens:5})));
  assert.equal(r.groups[0].output_tokens,null);
  assert.equal(r.groups[0].input_tokens,null);
  assert.equal(r.groups[0].uncached_input_tokens,5);
  assert.equal(r.groups[0].finalized,0);
  assert.equal(r.comparable,false);
});
test('iterations replace ordinary aggregate and separate advisor', () => {
  const u={input_tokens:12,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:9,
    iterations:[{type:'message',input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:4},
    {type:'advisor_message',model:'advisor-model',input_tokens:30,output_tokens:3},
    {type:'message',input_tokens:7,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:5}]};
  const r=report(files(claude(u,{stop_reason:'end_turn'})));
  assert.equal(r.groups.find(g=>g.kind==='ordinary').input_tokens,12);
  assert.equal(r.groups.find(g=>g.kind==='advisor').uncached_input_tokens,30);
  assert.equal(r.groups.find(g=>g.kind==='ordinary').output_tokens,9);
});
const codex=(n,ts='2026-09-10T00:00:00Z')=>({type:'event_msg',timestamp:ts,payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,cached_input_tokens:n/2,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:3,total_tokens:n+10}}}});
const meta={type:'session_meta',payload:{id:'codex-session'}};
const codexCurrent={type:'token_usage_record',timestamp:'2026-09-10T00:02:00Z',payload:{session_id:'codex-session',response_id:'resp-1',turn_id:'turn-1',
 usage:{input_tokens:20,cached_input_tokens:10,output_tokens:2,reasoning_output_tokens:1},
 thread_token_usage:{input_tokens:300,cached_input_tokens:150,cache_write_input_tokens:0,output_tokens:30,reasoning_output_tokens:9,total_tokens:330}}};
const codexCurrent2={type:'token_usage_record',timestamp:'2026-09-10T00:03:00Z',payload:{session_id:'codex-session',response_id:'resp-2',turn_id:'turn-1',
 usage:{input_tokens:280,cached_input_tokens:140,output_tokens:28,reasoning_output_tokens:8},
 thread_token_usage:{input_tokens:300,cached_input_tokens:150,cache_write_input_tokens:0,output_tokens:30,reasoning_output_tokens:9,total_tokens:330}}};
test('Codex cumulative snapshots, repeats and resumed files are not summed',()=>{
 const r=report([{source:'a',rows:[meta,codex(100),codex(200,'2026-09-10T00:01:00Z')]},
  {source:'b',rows:[meta,codex(200,'2026-09-10T00:01:00Z')]}]);
 assert.equal(r.groups[0].input_tokens,200);assert.equal(r.groups[0].cache_read_input_tokens,100);
 assert.equal(r.groups[0].output_tokens,10);assert.equal(r.groups[0].reasoning_output_tokens,3);
});
test('current Codex thread snapshots win over duplicate legacy snapshots',()=>{
 const r=report([{source:'current',rows:[meta,codex(250,'2026-09-10T00:01:59Z'),codexCurrent,codexCurrent2]}]);
 assert.equal(r.groups[0].input_tokens,300);assert.equal(r.groups[0].cache_read_input_tokens,150);
 assert.equal(r.groups[0].output_tokens,30);assert.equal(r.comparable,true);
});
test('current Codex response usage must reconcile with the thread total',()=>{
 const mismatched={...codexCurrent2,payload:{...codexCurrent2.payload,usage:{...codexCurrent2.payload.usage,input_tokens:1}}};
 const r=report([{source:'current',rows:[meta,codexCurrent,mismatched]}]);
 assert.equal(r.observations.length,1);assert.equal(r.observations[0].unit,'session_cumulative');
 assert.equal(r.groups[0].input_tokens,300);assert.equal(r.comparable,false);
 assert.ok(r.warnings.some(w=>w.includes('did not reconcile')));
});
test('a cumulative reset reports a discontinuity and does not invent a delta',()=>{
 const r=report(files(meta,codex(100),codex(20,'2026-09-10T00:01:00Z')));
 assert.equal(r.comparable,false);assert.ok(r.warnings.some(w=>w.includes('decreased')));
 assert.equal(r.groups[0].input_tokens,null);
});
test('missing identity and invalid counters are reported',()=>{
 const r=report(files({type:'assistant',message:{id:'invalid',usage:{input_tokens:-1}}},codex(100)));
 assert.equal(r.comparable,false);assert.ok(r.warnings.some(w=>w.includes('invalid input_tokens')));
 assert.ok(r.warnings.some(w=>w.includes('session identity')));
});
test('CLI replays explicit paths once, excludes content, and diagnoses malformed input',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-cli-'));
 try {
  const p=path.join(dir,'a.jsonl');fs.writeFileSync(p,JSON.stringify(claude({input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2},{content:'SECRET-PROMPT',stop_reason:'end_turn'}))+'\n');
  const cli=path.resolve(__dirname,'../../plugins/delivery-pipeline/scripts/usage-report.cjs');
  let r=spawnSync(process.execPath,[cli,p,p],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).groups[0].input_tokens,1);assert.ok(!r.stdout.includes('SECRET-PROMPT'));
  fs.appendFileSync(p,'broken\n');r=spawnSync(process.execPath,[cli,p],{encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).comparable,false);
  r=spawnSync(process.execPath,[cli,path.join(dir,'missing')],{encoding:'utf8'});assert.equal(r.status,2);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('message identity still deduplicates snapshots when requestId is absent',()=>{
 const a=claude({input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1});
 delete a.requestId;a.uuid='row-a';const b={...a,uuid:'row-b'};
 assert.equal(report(files(a,b)).groups[0].observations,1);
});

test('nonzero Codex cache writes do not invent an uncached partition',()=>{
 const row=codex(100);row.payload.info.total_token_usage.cache_write_input_tokens=10;
 const g=report(files(meta,row)).groups[0];assert.equal(g.input_tokens,100);
 assert.equal(g.cache_creation_input_tokens,10);assert.equal(g.uncached_input_tokens,null);
});

test('request metadata arriving later does not create a second message',()=>{
 const a=claude({input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:1});
 delete a.requestId;const b=claude({input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:3},{stop_reason:'end_turn'});
 const r=report(files(a,b));assert.equal(r.groups[0].observations,1);assert.equal(r.groups[0].output_tokens,3);
});
test('late Claude model metadata fills an earlier snapshot gap',()=>{
 const a=claude({input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:1});
 a.message.model=undefined;
 const b=claude({input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:3},{stop_reason:'end_turn'});
 const r=report(files(a,b));assert.equal(r.groups[0].model,'example-model');
});
test('malformed usage containers are warned about without aborting the report',()=>{
 const r=report(files(claude('bad'),claude([]),claude(5)));
 assert.equal(r.comparable,false);assert.ok(r.warnings.some(w=>w.includes('usage object')));
});

test('incomplete iteration evidence cannot discard ordinary aggregate usage',()=>{
 const usage={input_tokens:12,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:9,
  iterations:[{type:'message',input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:4}]};
 const r=report(files(claude(usage)));assert.equal(r.groups[0].input_tokens,12);
 assert.equal(r.groups[0].unit,'response_aggregate');assert.equal(r.comparable,false);
});

test('invalid attribution enums are skipped instead of making a row eligible', () => {
 const r=report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2},{stop_reason:'end_turn'})), {attributions:[{
   observation_id:'bad-effort', dispatch_id:'dispatch-1', runtime:'claude', provider:'anthropic', kind:'ordinary',
   source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01', role:'executor',
   task_level:'routine', backend:'workflow', model:'opus', effort:'high', observed_model:'claude-opus-5', observed_effort:'bogus',
 }]});
 assert.ok(r.warnings.some((w)=>w.includes('invalid observed_effort')));
 assert.equal(r.observations[0].attribution_status,'unattributed');
 assert.equal(r.efficiency.eligible_rows,0);
});

test('Codex turn metadata is scoped by session, not only by turn_id', () => {
 const current=(session,response,input,model,effort)=>({source:`${session}.jsonl`,rows:[
   {type:'session_meta',payload:{id:session}},
   {type:'turn_context',payload:{turn_id:'turn-1',model,effort}},
   {type:'token_usage_record',timestamp:'2026-09-10T00:02:00Z',payload:{
     session_id:session,response_id:response,turn_id:'turn-1',
     usage:{input_tokens:input,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0},
     thread_token_usage:{input_tokens:input,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0,total_tokens:input+1},
   }},
 ]});
 const r=report([current('session-a','response-a',10,'gpt-5.6-luna','high'),current('session-b','response-b',20,'gpt-6-astra','xhigh')]);
 assert.deepEqual(r.observations.map((o)=>[o.session_id,o.model,o.observed_effort]).sort(),[
   ['session-a','gpt-5.6-luna','high'],['session-b','gpt-6-astra','xhigh'],
 ]);
});

test('malformed transcript effort stays visible but is not eligible for comparison', () => {
 const row = {source:'session-bad-effort.jsonl',rows:[
   {type:'session_meta',payload:{id:'session-bad-effort'}},
   {type:'turn_context',payload:{turn_id:'turn-1',model:'gpt-6-astra',effort:'bogus'}},
   {type:'token_usage_record',timestamp:'2026-09-10T00:02:00Z',payload:{
     session_id:'session-bad-effort',response_id:'response-bad-effort',turn_id:'turn-1',
     usage:{input_tokens:20,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0},
     thread_token_usage:{input_tokens:20,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0,total_tokens:21},
   }},
 ]};
 const r = report([row]);
 assert.equal(r.observations[0].observed_effort, 'bogus');
 assert.equal(r.efficiency.eligible_rows, 0);
 assert.equal(r.coverage.effort_observed, 0);
});

test('non-string attribution sources are skipped without aborting the report', () => {
 const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'})), {
   attributions: [{
     observation_id:'bad-source', dispatch_id:'dispatch-1', runtime:'claude', provider:'anthropic', kind:'ordinary',
     source: { path: 'not-a-path' }, session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01',
     role:'executor', task_level:'routine', backend:'workflow', model:'opus', effort:'high',
     observed_model:'claude-opus-5', observed_effort:'high',
   }],
 });
 assert.ok(r.warnings.some((w) => w.includes('source must be a string')));
 assert.equal(r.observations[0].attribution_status, 'unattributed');
});

test('runtime-incompatible requested tiers are skipped from in-memory attributions', () => {
 const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'})), {
   attributions: [{
     observation_id:'bad-runtime-tier', dispatch_id:'dispatch-1', runtime:'codex', provider:'openai', kind:'ordinary',
     source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01',
     role:'executor', task_level:'routine', backend:'workflow', model:'fable', effort:'high',
     observed_model:'gpt-5.6-luna', observed_effort:'high',
   }],
 });
 assert.ok(r.warnings.some((w) => w.includes('not available on runtime codex')));
 assert.equal(r.observations[0].attribution_status, 'unattributed');
});

test('malformed observed_model values are skipped instead of entering efficiency rows', () => {
 const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'})), {
   attributions: [{
     observation_id:'bad-observed-model', dispatch_id:'dispatch-1', runtime:'claude', provider:'anthropic', kind:'ordinary',
     source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01', role:'executor',
     task_level:'routine', backend:'workflow', model:'opus', effort:'high', observed_model:{id:'bad'},
     observed_effort:'high',
   }],
 });
 assert.ok(r.warnings.some((w) => w.includes('observed_model must be a string')));
 assert.equal(r.efficiency.eligible_rows, 0);
});

test('efficiency rows stay separated by provider, runtime and backend', () => {
 const attributed = {
   observation_id:'shared-dispatch', dispatch_id:'dispatch-1', runtime:'claude', provider:'anthropic', kind:'ordinary',
   source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01', role:'executor',
   task_level:'routine', backend:'workflow', model:'opus', effort:'high', observed_model:'claude-opus-5',
   observed_effort:'high',
 };
 const r = report(files(
   claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'}),
   {type:'assistant', requestId:'r2', sessionId:'s2', message:{id:'m2', model:'example-model', usage:{input_tokens:7,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:3}, stop_reason:'end_turn'}},
 ), {attributions:[
   attributed,
   {...attributed, observation_id:'shared-dispatch-2', session_id:'s2', request_id:'r2', message_id:'m2', backend:'agent'},
 ]});
 assert.equal(r.efficiency.rows.length, 2);
 assert.deepEqual(r.efficiency.rows.map((row) => row.backend).sort(), ['agent', 'workflow']);
});
