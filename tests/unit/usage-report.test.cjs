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
test('current Codex format wins when legacy snapshots are in a resumed file',()=>{
 const legacy={...codex(250,'2026-09-10T00:01:59Z'),payload:{...codex(250,'2026-09-10T00:01:59Z').payload,session_id:'codex-session'}};
 const r=report([
   {source:'legacy-part',rows:[{type:'session_meta',payload:{id:'codex-session'}},legacy]},
   {source:'current-part',rows:[{type:'session_meta',payload:{id:'codex-session'}},codexCurrent,codexCurrent2]},
 ]);
 assert.equal(r.groups[0].input_tokens,300);
 assert.equal(r.groups[0].output_tokens,30);
 assert.equal(r.observations.length,2);
});
test('current Codex identity on a row-level session field suppresses legacy snapshots', () => {
 const current = { ...codexCurrent, payload: { ...codexCurrent.payload } };
 delete current.payload.session_id;
 current.sessionId = 'codex-session';
 const legacy = { ...codex(250,'2026-09-10T00:01:59Z'), sessionId: 'codex-session' };
 const r = report([
   { source: 'legacy-part', rows: [legacy] },
   { source: 'current-part', rows: [current] },
 ]);
 assert.equal(r.observations.length, 1);
 assert.equal(r.observations[0].session_id, 'codex-session');
 assert.equal(r.groups[0].input_tokens, 300);
});
test('current Codex usage record supplies session identity without session_meta', () => {
 const session = 'fragment-session';
 const row = { ...codexCurrent, payload: { ...codexCurrent.payload, session_id: session } };
 const r = report([{ source: 'resumed-fragment.jsonl', rows: [row] }]);
 assert.equal(r.observations.length, 1);
 assert.equal(r.observations[0].session_id, session);
 assert.equal(r.observations[0].unit, 'session_cumulative');
 assert.ok(!r.warnings.some((w) => w.includes('without session identity')));
});
test('total_token_usage records take the current path and suppress legacy duplicates', () => {
 const total = { ...codexCurrent, payload: { ...codexCurrent.payload } };
 delete total.payload.thread_token_usage;
 total.payload.total_token_usage = { ...codexCurrent.payload.thread_token_usage };
 const r = report([{ source: 'mixed-current.jsonl', rows: [codex(250), total, meta] }]);
 assert.equal(r.observations.length, 1);
 assert.equal(r.observations[0].session_id, 'codex-session');
 assert.equal(r.observations[0].unit, 'session_cumulative');
 assert.equal(r.groups[0].input_tokens, 300);
 assert.ok(!r.warnings.some((warning) => warning.includes('current response usage')));
});
test('Codex token usage before session metadata still uses the pre-scanned session', () => {
 const early = { ...codexCurrent, payload: { ...codexCurrent.payload } };
 delete early.payload.session_id;
 const r = report([{ source: 'metadata-late.jsonl', rows: [early, meta] }]);
 assert.equal(r.observations.length, 1);
 assert.equal(r.observations[0].session_id, 'codex-session');
 assert.ok(!r.warnings.some((w) => w.includes('without session identity')));
});
test('resumed Codex responses use their source for joins and a session turn fallback', () => {
 const session = 'resumed-session';
 const first = { ...codexCurrent, payload: { ...codexCurrent.payload, session_id: session, response_id: 'resume-1' } };
 const second = { ...codexCurrent2, payload: { ...codexCurrent2.payload, session_id: session, response_id: 'resume-2' } };
 const a = { source: 'resume-a.jsonl', rows: [
   { type: 'session_meta', payload: { id: session } },
   { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.6-terra', effort: 'high' } },
   first,
 ] };
 const b = { source: 'resume-b.jsonl', rows: [second] };
 const r = report([a, b], { attributions: [
   { dispatch_id: 'dispatch-a', runtime: 'codex', provider: 'openai', source: 'resume-a.jsonl',
     session_id: session, ticket: 'T-01-01', role: 'executor', task_level: 'complex', backend: 'codex-agent',
     model: 'sonnet', effort: 'high', observed_model: 'gpt-5.6-terra', observed_effort: 'high' },
   { dispatch_id: 'dispatch-b', runtime: 'codex', provider: 'openai', source: 'resume-b.jsonl',
     session_id: session, ticket: 'T-01-02', role: 'executor', task_level: 'complex', backend: 'codex-agent',
     model: 'sonnet', effort: 'high' },
 ] });
 assert.equal(r.observations.length, 2);
 assert.deepEqual(r.observations.map((o) => [o.dispatch_id, o.attribution_status, o.model]), [
   ['dispatch-a', 'session', 'gpt-5.6-terra'],
   ['dispatch-b', 'session', 'gpt-5.6-terra'],
 ]);
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
  const unreadable=path.join(dir,'dir.jsonl');fs.mkdirSync(unreadable);
  const missing=path.join(dir,'missing.jsonl');
  const cli=path.resolve(__dirname,'../../plugins/delivery-pipeline/scripts/usage-report.cjs');
  let r=spawnSync(process.execPath,[cli,p,p],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).groups[0].input_tokens,1);assert.ok(!r.stdout.includes('SECRET-PROMPT'));
  fs.appendFileSync(p,'broken\n');r=spawnSync(process.execPath,[cli,p],{encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).comparable,false);
  r=spawnSync(process.execPath,[cli,unreadable],{encoding:'utf8'});assert.equal(r.status,1,r.stderr);
  let out=JSON.parse(r.stdout);assert.equal(out.comparable,false);
  assert.ok(out.warnings.some((w)=>w.includes('unreadable transcript path')));
  r=spawnSync(process.execPath,[cli,p,missing],{encoding:'utf8'});assert.equal(r.status,1,r.stderr);out=JSON.parse(r.stdout);
  assert.equal(out.groups[0].input_tokens,1);
  assert.ok(out.warnings.some((w)=>w.includes('unreadable transcript path')));
  r=spawnSync(process.execPath,[cli,p,'--attribution',path.join(dir,'missing-attribution.jsonl')],{encoding:'utf8'});
  assert.equal(r.status,1,r.stderr);out=JSON.parse(r.stdout);
  assert.equal(out.groups[0].input_tokens,1);
  assert.ok(out.warnings.some((w)=>w.includes('unreadable attribution path')));
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

test('explicit empty attribution fields are rejected instead of defaulted', () => {
 const base = { dispatch_id:'dispatch-fields', runtime:'claude', provider:'anthropic', kind:'ordinary',
   source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01',
   role:'executor', task_level:'routine', backend:'workflow', model:'opus', effort:'high',
   observed_model:'example-model', observed_effort:'high' };
 for (const [field, value, needle] of [
   ['provider', '', 'provider does not match'], ['provider', null, 'provider does not match'],
   ['kind', '', 'unknown kind'], ['kind', null, 'unknown kind'],
   ['runtime', '', 'unknown runtime'], ['runtime', null, 'unknown runtime'],
 ]) {
   const record = { ...base, observation_id:`bad-${field}-${String(value)}`, [field]:value };
   const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'})), { attributions:[record] });
   assert.ok(r.warnings.some((w) => w.includes(needle)), `${field}=${String(value)} should be rejected`);
   assert.equal(r.efficiency.eligible_rows, 0);
  }
});

test('inherited runtime names are rejected as unknown', () => {
 const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'})), {
   attributions: [{ observation_id:'bad-runtime-prototype', dispatch_id:'dispatch-prototype', runtime:'toString',
     source:'fixture', session_id:'s1' }],
 });
 assert.ok(r.warnings.some((w) => w.includes('unknown runtime')));
 assert.equal(r.coverage.attribution_records, 0);
 assert.equal(r.observations[0].attribution_status, 'unattributed');
});

test('malformed transcript models remain visible but are excluded from efficiency coverage', () => {
 const row = claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'});
 row.message.model = { provider: 'unknown' };
 const r = report(files(row), { attributions: [{
   observation_id:'bad-transcript-model', dispatch_id:'dispatch-bad-model', runtime:'claude', provider:'anthropic',
   source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01', role:'executor',
   task_level:'routine', backend:'workflow', model:'opus', effort:'high', observed_effort:'high',
 }] });
 assert.deepEqual(r.observations[0].model, { provider: 'unknown' });
 assert.equal(r.coverage.model_observed, 0);
 assert.equal(r.efficiency.eligible_rows, 0);
 assert.ok(r.efficiency.rows[0].exclusion_reasons.includes('missing_model'));
});

test('malformed observed_model text is rejected before matching', () => {
 const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'})), {
   attributions: [{ observation_id:'bad-observed', dispatch_id:'dispatch-2', runtime:'claude', provider:'anthropic', kind:'ordinary',
       source:'fixture', session_id:'s1', model:'opus', observed_model:['claude-opus-5'] },
   ],
 });
 assert.ok(r.warnings.some((w) => w.includes('observed_model must be a string')));
 assert.equal(r.coverage.attribution_records, 0);
});

test('efficiency rows keep provider, runtime and backend as distinct joins', () => {
 const codexRow = { type:'event_msg', timestamp:'2026-09-10T00:01:00Z', payload:{ type:'token_count', info:{ total_token_usage:{
   input_tokens:100, cached_input_tokens:40, cache_write_input_tokens:0, output_tokens:8, reasoning_output_tokens:3, total_tokens:108,
 } } } };
 const r = report([
   { source:'claude.jsonl', rows:[claude({input_tokens:10, cache_read_input_tokens:20,
     cache_creation_input_tokens:0, output_tokens:4}, {stop_reason:'end_turn'})] },
   { source:'codex.jsonl', rows:[{ type:'session_meta', payload:{ id:'codex-session' } }, codexRow] },
 ], { attributions: [
   { observation_id:'same-claude', dispatch_id:'dispatch-shared', runtime:'claude', provider:'anthropic', kind:'ordinary',
     source:'claude.jsonl', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01', role:'executor',
     task_level:'routine', backend:'workflow', model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high' },
   { observation_id:'same-codex', dispatch_id:'dispatch-shared', runtime:'codex', provider:'openai', kind:'ordinary',
     source:'codex.jsonl', session_id:'codex-session', ticket:'T-01-01', role:'executor', task_level:'routine',
     backend:'codex-agent', model:'sonnet', effort:'high', observed_model:'gpt-5.6-luna', observed_effort:'high' },
 ] });
 assert.equal(r.efficiency.rows.length, 2);
 assert.deepEqual(r.efficiency.rows.map((row) => [row.provider, row.runtime]).sort(), [
   ['anthropic', 'claude'], ['openai', 'codex'],
 ]);
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

test('message-scoped attributions do not fall back to other responses in the same session', () => {
 const rows = files(
   claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, {stop_reason:'end_turn'}),
   {type:'assistant', requestId:'r2', sessionId:'s1', message:{id:'m2', model:'example-model',
     usage:{input_tokens:7,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:3}, stop_reason:'end_turn'}},
 );
 const r = report(rows, {attributions:[{
   observation_id:'message-only', dispatch_id:'dispatch-1', runtime:'claude', provider:'anthropic', kind:'ordinary',
   source:'fixture', session_id:'s1', request_id:'r1', message_id:'m1', ticket:'T-01-01', role:'executor',
   task_level:'routine', backend:'workflow', model:'opus', effort:'high', observed_model:'claude-opus-5',
   observed_effort:'high',
 }]});
 assert.deepEqual(r.observations.map((o) => [o.message_id, o.dispatch_id, o.attribution_status]), [
   ['m1', 'dispatch-1', 'mismatch'],
   ['m2', null, 'unattributed'],
 ]);
});

test('a verified delivery outcome rolls up parent continuation and child dispatch usage into one completion', () => {
 const parent = {type:'assistant', requestId:'r-parent', sessionId:'s-parent',
   message:{id:'m-parent', model:'example-model',
     usage:{input_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}, stop_reason:'end_turn'}};
 const child = {type:'assistant', requestId:'r-child', sessionId:'s-child',
   message:{id:'m-child', model:'example-model',
     usage:{input_tokens:15,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, stop_reason:'end_turn'}};
 const r = report(files(parent, child), {
   attributions: [
     {dispatch_id:'dispatch-parent', runtime:'claude', provider:'anthropic', kind:'ordinary',
       source:'fixture', session_id:'s-parent', request_id:'r-parent', message_id:'m-parent',
       run_id:'run-1', ticket:'T-41-01', role:'executor', task_level:'routine', backend:'workflow',
       model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high'},
     {dispatch_id:'dispatch-child', runtime:'claude', provider:'anthropic', kind:'ordinary',
       source:'fixture', session_id:'s-child', request_id:'r-child', message_id:'m-child',
       run_id:'run-1', ticket:'T-41-01', role:'ci-fix', task_level:'routine', backend:'workflow',
       model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high'},
   ],
   outcomes: [{run_id:'run-1', ticket:'T-41-01', status:'completed'}],
 });
 assert.deepEqual(r.observations.map((o) => o.verified_completion_status), ['completed', 'completed']);
 assert.equal(r.efficiency.verified_completion_count, 1);
 assert.equal(r.efficiency.verified_completions.length, 1);
 const completion = r.efficiency.verified_completions[0];
 assert.equal(completion.dispatch_count, 2);
 assert.equal(completion.input_tokens, 25);
 assert.equal(completion.complete, true);
 assert.deepEqual(r.efficiency.input_per_verified_completion, {count:1, total:25, median:25, p90:25});
});

test('ambiguous verified outcomes keep the completion join unknown', () => {
 const row = {type:'assistant', requestId:'r-amb', sessionId:'s-amb',
   message:{id:'m-amb', model:'example-model',
     usage:{input_tokens:8,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}, stop_reason:'end_turn'}};
 const r = report(files(row), {
   attributions: [{dispatch_id:'dispatch-amb', runtime:'claude', provider:'anthropic', kind:'ordinary',
     source:'fixture', session_id:'s-amb', request_id:'r-amb', message_id:'m-amb',
     run_id:'run-2', ticket:'T-41-02', role:'executor', task_level:'routine', backend:'workflow',
     model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high'}],
   outcomes: [
     {run_id:'run-2', ticket:'T-41-02', status:'completed'},
     {run_id:'run-2', ticket:'T-41-02', status:'failed'},
   ],
 });
 assert.equal(r.observations[0].verified_completion_status, 'ambiguous');
 assert.ok(r.warnings.some((w) => w.includes('ambiguous verified outcome')));
 assert.equal(r.efficiency.verified_completions.length, 0);
});

test('missing effort does not block a verified completion join, only efficiency eligibility', () => {
 const row = {type:'assistant', requestId:'r-noeffort', sessionId:'s-noeffort',
   message:{id:'m-noeffort', model:'example-model',
     usage:{input_tokens:20,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:3}, stop_reason:'end_turn'}};
 const r = report(files(row), {
   attributions: [{dispatch_id:'dispatch-noeffort', runtime:'claude', provider:'anthropic', kind:'ordinary',
     source:'fixture', session_id:'s-noeffort', request_id:'r-noeffort', message_id:'m-noeffort',
     run_id:'run-3', ticket:'T-41-03', role:'executor', task_level:'routine', backend:'workflow',
     model:'opus', observed_model:'example-model'}],
   outcomes: [{run_id:'run-3', ticket:'T-41-03', status:'completed'}],
 });
 assert.equal(r.observations[0].verified_completion_status, 'completed');
 assert.equal(r.efficiency.rows[0].eligible, false);
 assert.ok(r.efficiency.rows[0].exclusion_reasons.includes('missing_or_nonconcrete_effort'));
 assert.equal(r.efficiency.verified_completions.length, 1);
 assert.equal(r.efficiency.verified_completions[0].input_tokens, 20);
 assert.equal(r.efficiency.verified_completions[0].complete, true);
});

test('a failed run stays in cohort totals while only the completed recovery run becomes a verified completion', () => {
 const failed = {type:'assistant', requestId:'r-fail', sessionId:'s-fail',
   message:{id:'m-fail', model:'example-model',
     usage:{input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}, stop_reason:'end_turn'}};
 const recovered = {type:'assistant', requestId:'r-recover', sessionId:'s-recover',
   message:{id:'m-recover', model:'example-model',
     usage:{input_tokens:12,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:2}, stop_reason:'end_turn'}};
 const r = report(files(failed, recovered), {
   attributions: [
     {dispatch_id:'dispatch-fail', runtime:'claude', provider:'anthropic', kind:'ordinary',
       source:'fixture', session_id:'s-fail', request_id:'r-fail', message_id:'m-fail',
       run_id:'run-4a', ticket:'T-41-04', role:'executor', task_level:'routine', backend:'workflow',
       model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high'},
     {dispatch_id:'dispatch-recover', runtime:'claude', provider:'anthropic', kind:'ordinary',
       source:'fixture', session_id:'s-recover', request_id:'r-recover', message_id:'m-recover',
       run_id:'run-4b', ticket:'T-41-04', role:'ci-fix', task_level:'routine', backend:'workflow',
       model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high'},
   ],
   outcomes: [
     {run_id:'run-4a', ticket:'T-41-04', status:'failed'},
     {run_id:'run-4b', ticket:'T-41-04', status:'completed'},
   ],
 });
 assert.deepEqual(r.observations.map((o) => o.verified_completion_status).sort(), ['completed', 'failed']);
 const total = r.groups.reduce((sum, g) => sum + (g.input_tokens || 0), 0);
 assert.equal(total, 17, 'total cohort consumption keeps the failed run visible');
 assert.equal(r.efficiency.verified_completions.length, 1);
 assert.equal(r.efficiency.verified_completions[0].run_id, 'run-4b');
 assert.equal(r.efficiency.verified_completions[0].input_tokens, 12);
});

test('CLI accepts an --outcomes ledger and diagnoses an unreadable path', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-outcomes-cli-'));
 try {
  const p=path.join(dir,'a.jsonl');
  fs.writeFileSync(p,JSON.stringify({type:'assistant', requestId:'r-cli', sessionId:'s-cli',
    message:{id:'m-cli', model:'example-model',
      usage:{input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}, stop_reason:'end_turn'}})+'\n');
  const outcomes=path.join(dir,'outcomes.jsonl');
  fs.writeFileSync(outcomes, JSON.stringify({run_id:'run-cli', ticket:'T-41-05', status:'completed'})+'\n');
  const cli=path.resolve(__dirname,'../../plugins/delivery-pipeline/scripts/usage-report.cjs');
  let r=spawnSync(process.execPath,[cli,p,'--outcomes',outcomes],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).groups[0].input_tokens,1);
  r=spawnSync(process.execPath,[cli,p,'--outcomes',path.join(dir,'missing-outcomes.jsonl')],{encoding:'utf8'});
  assert.equal(r.status,1,r.stderr);
  const out=JSON.parse(r.stdout);
  assert.ok(out.warnings.some((w)=>w.includes('unreadable outcome path')));
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
