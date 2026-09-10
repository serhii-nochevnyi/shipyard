'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {inventory}=require('../../plugins/delivery-pipeline/scripts/backlog-index.cjs');
function fixture(fn){const r=fs.mkdtempSync(path.join(os.tmpdir(),'backlog-index-'));try{fs.mkdirSync(path.join(r,'.planning/backlog'),{recursive:true});fn(r);}finally{fs.rmSync(r,{recursive:true,force:true});}}
const note=(r,name,text)=>fs.writeFileSync(path.join(r,'.planning/backlog',name),text);
test('all sources and repeated sections have distinct stable IDs',()=>fixture(r=>{
 note(r,'one.md','# One\nintro\n## Retry\nfirst\n## Retry\nsecond');
 const d=path.join(r,'.planning/phases/999.1-park');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'PLAN.md'),'# One\nGSD backlog');
 const before=inventory(r);assert.equal(before.sources,2);assert.equal(before.items.length,4);
 assert.equal(new Set(before.items.map(i=>i.id)).size,4);
 note(r,'aaa.md','# Earlier\nAnother note');const after=inventory(r);
 for(const i of before.items)assert.ok(after.items.some(j=>j.id===i.id));
 assert.ok(before.items.some(i=>i.source.startsWith('gsd999:')));
}));
test('manifest closure needs evidence; source changes mark it stale',()=>fixture(r=>{
 note(r,'one.md','# One\nText');const item=inventory(r).items[0];
 const record={id:item.id,status:'verified_closed',source_hash:item.source_hash};
 assert.throws(()=>inventory(r,{schema_version:1,items:[record]}),/evidence/);
 record.revision='a'.repeat(40);record.verification=['node test.cjs'];
 let out=inventory(r,{schema_version:1,items:[record]});assert.equal(out.items[0].status,'verified_closed');
 note(r,'one.md','# One\nChanged');out=inventory(r,{schema_version:1,items:[record]});
 assert.equal(out.items[0].status,'untriaged');assert.equal(out.items[0].prior_status,'verified_closed');assert.equal(out.items[0].verification_stale,true);
}));
test('bad states and duplicate manifest identities refuse',()=>fixture(r=>{
 note(r,'one.md','# One');const i=inventory(r).items[0];
 assert.throws(()=>inventory(r,{schema_version:1,items:[{id:i.id,status:'done'}]}),/status/);
 const v={id:i.id,status:'untriaged'};assert.throws(()=>inventory(r,{schema_version:1,items:[v,v]}),/duplicate/);
}));
test('missing optional directories are empty, missing roots and symlink escape refuse',()=>fixture(r=>{
 assert.equal(inventory(r).sources,0);
 assert.throws(()=>inventory(path.join(r,'absent')));
 fs.symlinkSync(os.tmpdir(),path.join(r,'.planning/backlog/escape'));
 assert.throws(()=>inventory(r),/symlink/);
}));
test('CLI queries bounded results without changing sources',()=>fixture(r=>{
 note(r,'one.md','# One\n## Usage\nTokens and advisor\n## Other\nOther');
 const cli=path.resolve(__dirname,'../../plugins/delivery-pipeline/scripts/backlog-index.cjs');
 const before=fs.readFileSync(path.join(r,'.planning/backlog/one.md'),'utf8');
 const x=spawnSync(process.execPath,[cli,'--root',r,'--query','advisor','--limit','1'],{encoding:'utf8'});
 assert.equal(x.status,0,x.stderr);const out=JSON.parse(x.stdout);assert.equal(out.items.length,1);assert.equal(out.items[0].title,'Usage');
 assert.equal(fs.readFileSync(path.join(r,'.planning/backlog/one.md'),'utf8'),before);
 assert.equal(spawnSync(process.execPath,[cli,'--root',r,'--limit','-1'],{encoding:'utf8'}).status,2);
}));

test('GSD backlog entries in the roadmap are discoverable without a phase directory',()=>fixture(r=>{
 fs.writeFileSync(path.join(r,'.planning/ROADMAP.md'),'# Roadmap\n## Phase 32: Active\nIgnore\n## Phase 999.1: Later\nKeep');
 const out=inventory(r);assert.equal(out.sources,1);assert.equal(out.items.length,1);
 assert.equal(out.items[0].title,'Phase 999.1: Later');
}));
