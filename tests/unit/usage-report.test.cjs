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
test('Codex cumulative snapshots, repeats and resumed files are not summed',()=>{
 const r=report([{source:'a',rows:[meta,codex(100),codex(200,'2026-09-10T00:01:00Z')]},
  {source:'b',rows:[meta,codex(200,'2026-09-10T00:01:00Z')]}]);
 assert.equal(r.groups[0].input_tokens,200);assert.equal(r.groups[0].cache_read_input_tokens,100);
 assert.equal(r.groups[0].output_tokens,10);assert.equal(r.groups[0].reasoning_output_tokens,3);
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
