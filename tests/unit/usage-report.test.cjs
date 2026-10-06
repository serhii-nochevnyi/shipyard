'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { report } = require('../../plugins/delivery-pipeline/scripts/usage-report.cjs');
const subscriptionObservation = require('../../plugins/delivery-pipeline/scripts/subscription-observation.cjs');
const claude = (usage, extra = {}) => ({type:'assistant', requestId:'r1', sessionId:'s1',
  message:{id:'m1',model:'example-model',usage,...extra}});
const files = (...rows) => [{source:'fixture',rows}];
const loadFixtureRows = (relPath) => fs.readFileSync(path.resolve(__dirname, '../..', relPath), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));

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

const CODEX_STREAM_EXEC_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-exec.jsonl';

test('a Codex host-stream transcript (thread.started/turn.completed) yields a per-session sum', () => {
  const rows = loadFixtureRows(CODEX_STREAM_EXEC_FIXTURE);
  const r = report([{ source: 'fixture', rows }]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].unit, 'session_stream_sum');
  assert.equal(r.observations[0].session_id, '<SESSION-1>');
  assert.equal(r.observations[0].attribution_status, 'unattributed');
  assert.equal(r.observations[0].input_tokens, 20391);
  assert.equal(r.observations[0].cache_read_input_tokens, 6912);
  assert.equal(r.observations[0].cache_creation_input_tokens, 0);
  assert.equal(r.observations[0].uncached_input_tokens, 13479);
  assert.equal(r.observations[0].output_tokens, 5);
  assert.equal(r.observations[0].reasoning_output_tokens, 0);
});

test('a two-turn Codex stream is summed per session, never max-merged', () => {
  const rows = [
    { type: 'thread.started', thread_id: 'two-turn-session' },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 1 } },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 15, reasoning_output_tokens: 2 } },
  ];
  const r = report([{ source: 'two-turn.jsonl', rows }]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].input_tokens, 250);
  assert.equal(r.observations[0].cache_read_input_tokens, 50);
  assert.equal(r.observations[0].output_tokens, 25);
  assert.equal(r.observations[0].reasoning_output_tokens, 3);
});

test('a session present as both a stream and a token_usage_record rollout is counted once, with a warning', () => {
  const streamRows = [
    { type: 'thread.started', thread_id: 'codex-session' },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 999, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 } },
  ];
  const r = report([
    { source: 'native.jsonl', rows: [meta, codexCurrent] },
    { source: 'stream.jsonl', rows: streamRows },
  ]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].unit, 'session_cumulative');
  assert.equal(r.groups[0].input_tokens, 300);
  assert.ok(r.warnings.some((w) => w.includes('more than one usage schema')));
});

test('a stream scanned before its session\'s token_usage_record rollout still yields one observation', () => {
  const session = 'reordered-thread';
  const streamRows = [
    { type: 'thread.started', thread_id: session },
    { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ];
  const nativeRows = [
    { type: 'session_meta', payload: { id: session } },
    { type: 'token_usage_record', timestamp: '2026-09-10T00:00:00Z', payload: {
      session_id: session,
      total_token_usage: { input_tokens: 400, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0, total_tokens: 404 },
    } },
  ];
  const r = report([
    { source: 'stream.jsonl', rows: streamRows },
    { source: 'native.jsonl', rows: nativeRows },
  ]);
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].unit, 'session_cumulative');
  assert.equal(r.groups[0].input_tokens, 400);
  assert.ok(r.warnings.some((w) => w.includes('more than one usage schema')));
});

test('a stream turn without a preceding thread.started is skipped with a warning', () => {
  const rows = [
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ];
  const r = report([{ source: 'orphan-stream.jsonl', rows }]);
  assert.equal(r.observations.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('without a preceding thread.started')));
});

test('Codex stream sessions get model/effort only from the attribution ledger', () => {
  const rows = [
    { type: 'thread.started', thread_id: 'attributed-stream' },
    { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } },
  ];
  const r = report([{ source: 'attributed-stream.jsonl', rows }], { attributions: [
    { dispatch_id: 'dispatch-stream', runtime: 'codex', provider: 'openai', source: 'attributed-stream.jsonl',
      session_id: 'attributed-stream', ticket: 'T-01-01', role: 'executor', task_level: 'complex', backend: 'codex-agent',
      model: 'sonnet', effort: 'high', observed_model: 'gpt-6-luna', observed_effort: 'high' },
  ] });
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].attribution_status, 'session');
  assert.equal(r.observations[0].model, 'gpt-6-luna');
  assert.equal(r.observations[0].observed_effort, 'high');
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

test('a verified completion spanning Claude and Codex keeps per-runtime totals and refuses a mixed sum', () => {
 const codexRow = { type:'event_msg', timestamp:'2026-09-10T00:01:00Z', payload:{ type:'token_count', info:{ total_token_usage:{
   input_tokens:100, cached_input_tokens:40, cache_write_input_tokens:0, output_tokens:8, reasoning_output_tokens:3, total_tokens:108,
 } } } };
 const shared = { dispatch_id:'dispatch-shared', run_id:'run-mixed', ticket:'T-01-01', role:'executor', task_level:'routine',
   effort:'high', observed_effort:'high' };
 const r = report([
   { source:'claude.jsonl', rows:[claude({input_tokens:10, cache_read_input_tokens:20,
     cache_creation_input_tokens:0, output_tokens:4}, {stop_reason:'end_turn'})] },
   { source:'codex.jsonl', rows:[{ type:'session_meta', payload:{ id:'codex-session' } }, codexRow] },
 ], { attributions: [
   { ...shared, observation_id:'mixed-claude', runtime:'claude', provider:'anthropic', kind:'ordinary',
     source:'claude.jsonl', session_id:'s1', request_id:'r1', message_id:'m1', backend:'workflow', model:'opus',
     observed_model:'example-model' },
   { ...shared, observation_id:'mixed-codex', runtime:'codex', provider:'openai', kind:'ordinary',
     source:'codex.jsonl', session_id:'codex-session', backend:'codex-agent', model:'sonnet', observed_model:'gpt-5.6-luna' },
 ], outcomes: [{run_id:'run-mixed', ticket:'T-01-01', status:'completed'}] });
 assert.equal(r.efficiency.verified_completions.length, 1);
 const completion = r.efficiency.verified_completions[0];
 assert.equal(completion.mixed_runtime, true);
 assert.equal(completion.input_tokens, null, 'Claude and Codex input is never summed');
 assert.deepEqual(completion.by_runtime.map((s) => [s.runtime, s.provider_family, s.input_tokens]), [
   ['claude', 'anthropic', 30], ['codex', 'openai', 100],
 ]);
 assert.equal(r.efficiency.cohort_consumption.mixed_runtime, true);
 assert.equal(r.efficiency.cohort_consumption.input_tokens, null);
 assert.deepEqual([r.efficiency.input_per_verified_completion.total,
   r.efficiency.input_per_verified_completion.cohort_total,
   r.efficiency.input_per_verified_completion.per_completion], [null, null, null]);
 assert.deepEqual(r.efficiency.per_verified_completion_by_runtime.map((s) => [s.runtime, s.input_tokens.total,
   s.input_tokens.cohort_total, s.input_tokens.per_completion]), [['claude', 30, 30, 30], ['codex', 100, 100, 100]]);
});

test('unassigned overhead is bucketed by reason and runtime', () => {
 const codexRow = { type:'event_msg', timestamp:'2026-09-10T00:01:00Z', payload:{ type:'token_count', info:{ total_token_usage:{
   input_tokens:100, cached_input_tokens:40, cache_write_input_tokens:0, output_tokens:8, reasoning_output_tokens:3, total_tokens:108,
 } } } };
 const r = report([
   { source:'claude.jsonl', rows:[claude({input_tokens:10, cache_read_input_tokens:20,
     cache_creation_input_tokens:0, output_tokens:4}, {stop_reason:'end_turn'})] },
   { source:'codex.jsonl', rows:[{ type:'session_meta', payload:{ id:'codex-session' } }, codexRow] },
 ]);
 assert.deepEqual(r.efficiency.unassigned_overhead.map((u) => [u.reason, u.runtime, u.input_tokens]), [
   ['missing_ticket_or_dispatch', 'claude', 30], ['missing_ticket_or_dispatch', 'codex', 100],
 ]);
 assert.equal(r.efficiency.input_per_verified_completion.unassigned_total, null);
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
 assert.deepEqual(r.efficiency.input_per_verified_completion,
   {count:1, total:25, median:25, p90:25, cohort_total:25, unassigned_total:0, per_completion:25});
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
 assert.equal(r.efficiency.verified_completions[0].input_tokens, 17, 'the failed attempt joins the completion it led to');
 assert.deepEqual(r.efficiency.verified_completions[0].attempt_statuses, {failed:1});
 assert.deepEqual(r.efficiency.verified_completions[0].dispatch_ids, ['dispatch-fail', 'dispatch-recover']);
 assert.deepEqual(r.efficiency.unassigned_overhead, []);
 const input = r.efficiency.input_per_verified_completion;
 assert.deepEqual([input.count, input.total, input.median, input.p90, input.cohort_total, input.per_completion],
   [1, 17, 17, 17, 17, 17]);
});

test('unknown-outcome and unticketed usage stays in the cohort numerator as explicit unassigned overhead', () => {
 const usage = (id, input) => ({type:'assistant', requestId:`r-${id}`, sessionId:`s-${id}`,
   message:{id:`m-${id}`, model:'example-model',
     usage:{input_tokens:input,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}, stop_reason:'end_turn'}});
 const attribution = (id, run, ticket) => ({dispatch_id:`dispatch-${id}`, runtime:'claude', provider:'anthropic',
   kind:'ordinary', source:'fixture', session_id:`s-${id}`, request_id:`r-${id}`, message_id:`m-${id}`,
   run_id:run, ticket, role:'executor', task_level:'routine', backend:'workflow',
   model:'opus', effort:'high', observed_model:'example-model', observed_effort:'high'});
 const r = report(files(usage('done-a', 10), usage('done-b', 30), usage('parked', 4), usage('unknown', 6), usage('loose', 3)), {
   attributions: [
     attribution('done-a', 'run-a', 'T-41-10'), attribution('done-b', 'run-b', 'T-41-11'),
     attribution('parked', 'run-c', 'T-41-12'), attribution('unknown', 'run-d', 'T-41-10'),
   ],
   outcomes: [
     {run_id:'run-a', ticket:'T-41-10', status:'completed'},
     {run_id:'run-b', ticket:'T-41-11', status:'completed'},
     {run_id:'run-c', ticket:'T-41-12', status:'parked'},
   ],
 });
 assert.equal(r.efficiency.verified_completions.length, 2);
 assert.deepEqual(r.efficiency.verified_completions.map((c) => c.input_tokens).sort((a, b) => a - b), [10, 30],
   'an unknown-outcome row is not assigned to a completion by ticket alone');
 assert.deepEqual(r.efficiency.unassigned_overhead.map((u) => [u.reason, u.rows, u.input_tokens]), [
   ['missing_ticket_or_dispatch', 1, 3],
   ['no_verified_completion', 1, 4],
   ['outcome_unknown', 1, 6],
 ]);
 assert.equal(r.efficiency.cohort_consumption.input_tokens, 53);
 const input = r.efficiency.input_per_verified_completion;
 assert.deepEqual([input.count, input.total, input.median, input.p90, input.cohort_total, input.unassigned_total,
   input.per_completion], [2, 40, 10, 30, 53, 13, 26.5]);
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

const CLAUDE_EXECUTOR_FIXTURE = 'tests/fixtures/captured/claude-stream-executor.jsonl';
const CODEX_PARENT_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-parent.jsonl';

const CLAUDE_EXECUTOR_OBSERVATIONS = [{
  provider:'anthropic', kind:'ordinary', unit:'response_aggregate', finalized:false, source:'fixture',
  runtime:'claude', provider_family:'anthropic', session_id:'<SESSION-3>', request_id:'req_011CfScSPvNtJtkUKGJ2Xdmt',
  message_id:'msg_011CfScSQiGRDtXBBXV5V4ri', dispatch_id:null, project_id:null, run_id:null, ticket:null, role:null,
  task_level:null, backend:null, requested_model:null, requested_effort:null, effort_applied:null,
  observed_effort:null, effort_source:'unknown', model:'claude-sonnet-5', observed_model:'claude-sonnet-5',
  model_source:'transcript', attribution_status:'unattributed', attribution_level:null, completion_status:'unknown',
  verified_completion_status:'unknown', input_tokens:16288, uncached_input_tokens:2, cache_read_input_tokens:12743,
  cache_creation_input_tokens:3543, output_tokens:1, reasoning_output_tokens:null,
}];
const CLAUDE_EXECUTOR_GROUPS = [{
  provider:'anthropic', provider_family:'anthropic', runtime:'claude', kind:'ordinary', model:'claude-sonnet-5',
  observed_effort:null, requested_model:null, requested_effort:null, effort_applied:null, role:null, task_level:null,
  backend:null, unit:'response_aggregate', observations:1, finalized:0, attributed:0,
  model_sources:{transcript:1}, effort_sources:{unknown:1}, attribution_statuses:{unattributed:1},
  ticket_count:0, dispatch_count:0, input_tokens:16288, uncached_input_tokens:2, cache_read_input_tokens:12743,
  cache_creation_input_tokens:3543, output_tokens:1, reasoning_output_tokens:null,
  missing:{reasoning_output_tokens:1},
}];

const CODEX_PARENT_COMMON_OBSERVATION = {
  provider:'openai', kind:'ordinary', unit:'model_pass', finalized:false, source:'fixture', runtime:'codex',
  provider_family:'openai', session_id:'<SESSION-2>', request_id:'<SESSION-4>', dispatch_id:null, project_id:null,
  run_id:null, ticket:null, role:null, task_level:null, backend:null, requested_model:null, requested_effort:null,
  effort_applied:null, observed_effort:'low', effort_source:'transcript', model:'gpt-6-luna',
  observed_model:'gpt-6-luna', model_source:'transcript', attribution_status:'unattributed', attribution_level:null,
  completion_status:'unknown', verified_completion_status:'unknown',
};
const CODEX_PARENT_OBSERVATIONS = [
  {...CODEX_PARENT_COMMON_OBSERVATION, message_id:'resp_091f5b341a77ba46016ab8de4ff1bc87d2827760ff82492d8e',
    input_tokens:20581, uncached_input_tokens:13669, cache_read_input_tokens:6912, cache_creation_input_tokens:0,
    output_tokens:167, reasoning_output_tokens:0},
  {...CODEX_PARENT_COMMON_OBSERVATION, message_id:'resp_091f5b341a77ba46016ab8de54831887d291ff086cdfec60ff',
    input_tokens:20771, uncached_input_tokens:547, cache_read_input_tokens:20224, cache_creation_input_tokens:0,
    output_tokens:22, reasoning_output_tokens:0},
  {...CODEX_PARENT_COMMON_OBSERVATION, message_id:'resp_091f5b341a77ba46016ab8de5cbd4487d29a50fc321fe6a0be',
    input_tokens:20857, uncached_input_tokens:633, cache_read_input_tokens:20224, cache_creation_input_tokens:0,
    output_tokens:12, reasoning_output_tokens:0},
];
const CODEX_PARENT_GROUPS = [{
  provider:'openai', provider_family:'openai', runtime:'codex', kind:'ordinary', model:'gpt-6-luna',
  observed_effort:'low', requested_model:null, requested_effort:null, effort_applied:null, role:null,
  task_level:null, backend:null, unit:'model_pass', observations:3, finalized:0, attributed:0,
  model_sources:{transcript:3}, effort_sources:{transcript:3}, attribution_statuses:{unattributed:3},
  ticket_count:0, dispatch_count:0, input_tokens:62209, uncached_input_tokens:14849, cache_read_input_tokens:47360,
  cache_creation_input_tokens:0, output_tokens:201, reasoning_output_tokens:0, missing:{},
}];

function assertQuotaInvariants(usage) {
  assert.equal(usage.schema, 'shipyard.subscription-usage.v1');
  assert.equal(usage.verdict, 'inconclusive');
  assert.deepEqual(usage.coverage, {codex_parent:'unverified', codex_idle_baseline:'unverified'});
}

test('subscription_usage on the captured Claude executor fixture gives the two Claude buckets', () => {
  const rows = loadFixtureRows(CLAUDE_EXECUTOR_FIXTURE);
  const r = report([{source:'fixture', rows}]);
  assert.equal(r.units, 'tokens processed; not subscription quota');
  assertQuotaInvariants(r.subscription_usage);
  assert.deepEqual(r.subscription_usage.series.map((s) => s.bucket_id).sort(), ['five_hour', 'seven_day']);
  const byBucket = Object.fromEntries(r.subscription_usage.series.map((s) => [s.bucket_id, s]));
  assert.equal(byBucket.five_hour.last.used_percent, 70);
  assert.equal(byBucket.five_hour.provider, 'anthropic');
  assert.equal(byBucket.seven_day.last.used_percent, 57);
  assert.deepEqual(r.subscription_usage.warnings, []);
  assert.deepEqual(r.observations, CLAUDE_EXECUTOR_OBSERVATIONS);
  assert.deepEqual(r.groups, CLAUDE_EXECUTOR_GROUPS);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.comparable, true);
});

test('subscription_usage on the Codex parent native fixture gives one codex:primary series despite the token_usage_record skip', () => {
  const rows = loadFixtureRows(CODEX_PARENT_FIXTURE);
  const r = report([{source:'fixture', rows}]);
  assertQuotaInvariants(r.subscription_usage);
  assert.equal(r.subscription_usage.series.length, 1);
  assert.equal(r.subscription_usage.series[0].bucket_id, 'codex:primary');
  assert.equal(r.subscription_usage.series[0].provider, 'openai');
  assert.equal(r.subscription_usage.series[0].samples, 3);
  assert.deepEqual(r.subscription_usage.warnings, []);
  assert.deepEqual(r.observations, CODEX_PARENT_OBSERVATIONS);
  assert.deepEqual(r.groups, CODEX_PARENT_GROUPS);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.comparable, true);
});

test('a malformed rate_limit_event adds only to subscription_usage.warnings and leaves a true comparable true', () => {
  const rows = loadFixtureRows(CLAUDE_EXECUTOR_FIXTURE);
  const original = rows.find((row) => row.type === 'rate_limit_event');
  const malformed = JSON.parse(JSON.stringify(original));
  delete malformed.rate_limit_info.unifiedWindows.five_hour.utilization;
  const mutatedRows = rows.filter((row) => row.type !== 'rate_limit_event').concat(malformed);
  const r = report([{source:'fixture', rows: mutatedRows}]);
  assertQuotaInvariants(r.subscription_usage);
  assert.ok(r.subscription_usage.warnings.some((w) => w.includes('missing or non-numeric utilization')));
  assert.deepEqual(r.subscription_usage.series.map((s) => s.bucket_id), ['seven_day']);
  assert.deepEqual(r.observations, CLAUDE_EXECUTOR_OBSERVATIONS);
  assert.deepEqual(r.groups, CLAUDE_EXECUTOR_GROUPS);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.comparable, true);
});

test('subscription_usage stays a populated schema object with no quota record at all', () => {
  const r = report(files(claude({input_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1},{stop_reason:'end_turn'})));
  assertQuotaInvariants(r.subscription_usage);
  assert.deepEqual(r.subscription_usage.series, []);
  assert.deepEqual(r.subscription_usage.discontinuities, []);
  assert.notEqual(r.subscription_usage, null);
});

test('--account-label declares attribution and an invalid runtime or label exits 2', () => {
  const cli = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/usage-report.cjs');
  const fixture = path.resolve(__dirname, '../..', CODEX_PARENT_FIXTURE);
  let r = spawnSync(process.execPath, [cli, fixture], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  for (const needle of ['creator_user_id', 'credits', 'plan_type', 'balance']) {
    assert.equal(r.stdout.includes(needle), false, `stdout must not leak ${needle}`);
  }
  const out = JSON.parse(r.stdout);
  assert.equal(out.subscription_usage.series[0].account_label, null);

  r = spawnSync(process.execPath, [cli, fixture, '--account-label', 'codex=codex-prolite'], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const labeled = JSON.parse(r.stdout);
  assert.equal(labeled.subscription_usage.series[0].account_label, 'codex-prolite');
  const rows = loadFixtureRows(CODEX_PARENT_FIXTURE);
  const direct = subscriptionObservation.fromTranscriptRows(rows, {accountLabels:{codex:'codex-prolite'}});
  assert.equal(direct.envelopes[0].attribution, 'declared');

  r = spawnSync(process.execPath, [cli, fixture, '--account-label', 'codex=me@x'], {encoding:'utf8'});
  assert.equal(r.status, 2, r.stderr);

  r = spawnSync(process.execPath, [cli, fixture, '--account-label', 'jira=me'], {encoding:'utf8'});
  assert.equal(r.status, 2, r.stderr);
});

test('usage-report.cjs requires none of the network or process-spawning core modules', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/usage-report.cjs'), 'utf8');
  for (const forbidden of ['child_process', 'net', 'http', 'https', 'dgram']) {
    assert.equal(new RegExp(`require\\(['"](node:)?${forbidden}['"]\\)`).test(src), false, `must not require ${forbidden}`);
  }
});

test('real waiter and authenticated child reports keep actors separate and unknown counters out of sums', async () => {
  const { measuredPlanningFixture } = require('./codex-decompose-host.test.cjs');
  const overhead = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs');
  const measured = await measuredPlanningFixture({ timeout: true });
  const r = overhead.report({ rows: measured.rows });
  const actors = new Map(r.by_actor.map(entry => [entry.actor, entry.metrics]));
  const parents = measured.rows.filter(row => row.actor === 'parent');
  assert.equal(actors.get('parent').wait_polls.sum, parents.length);
  assert.equal(actors.get('child').wait_polls.sum, null);
  for (const key of ['model_turns', 'tool_calls', 'retries', 'provider_tokens']) {
    assert.equal(actors.get('child')[key].sum, null);
    assert.equal(actors.get('child')[key].count, 0);
  }
  assert.equal(r.metrics.model_turns.sum, null);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.status.efficiency_measured, false);
  assert.ok(r.verdict_reasons.some(reason => /no savings/.test(reason)));
  assert.equal(Object.keys(r).some(key => /percent/i.test(key)), false);
  const transcript = measured.childTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const usage = report([{ source: 'authenticated-original-child', rows: transcript }]);
  assert.ok(usage.groups.every(group => group.provider === 'openai'));
});
