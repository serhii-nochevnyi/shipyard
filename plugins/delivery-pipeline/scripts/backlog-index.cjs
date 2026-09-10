#!/usr/bin/env node
'use strict';
// Inventory only: source notes and installed GSD are never mutated.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const STATES=new Set(['untriaged','verified_open','planned','in_progress','verified_closed','deferred','superseded']);
const hash=(s)=>crypto.createHash('sha256').update(s).digest('hex');
function sections(text, fallback) {
  const result=[]; let current=null, fence=null;
  const body=text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
  for(const line of body.split(/\r?\n/)) {
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker) {
      if(!fence) fence=marker[1];
      else if(marker[1][0]===fence[0] && marker[1].length>=fence.length) fence=null;
      if(current) current.lines.push(line); continue;
    }
    const heading=!fence && line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if(heading) { current={title:heading[1],lines:[]}; result.push(current); }
    else { if(!current && line.trim()){current={title:fallback,lines:[]};result.push(current);} if(current)current.lines.push(line); }
  }
  return result.length?result:[{title:fallback,lines:[]}];
}
function inventory(root, manifest=null, query='') {
  const real=fs.realpathSync(root);
  if(!fs.statSync(real).isDirectory())throw new Error('root must be a directory');
  const files=[];
  function walk(dir, kind) {
    let stat;try{stat=fs.lstatSync(dir);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(stat.isSymbolicLink())throw new Error(`symlink source refused: ${path.relative(real,dir)}`);
    if(!stat.isDirectory())throw new Error(`source directory expected: ${dir}`);
    for(const name of fs.readdirSync(dir).sort()) {
      const file=path.join(dir,name),s=fs.lstatSync(file);
      if(s.isSymbolicLink())throw new Error(`symlink source refused: ${path.relative(real,file)}`);
      if(s.isDirectory())walk(file,kind);
      else if(s.isFile()&&name.endsWith('.md'))files.push({file,kind});
    }
  }
  // Check the ancestor itself, otherwise a symlinked .planning escapes the root.
  const planning=path.join(real,'.planning');
  if(fs.existsSync(planning)&&fs.lstatSync(planning).isSymbolicLink())throw new Error('symlink .planning refused');
  walk(path.join(planning,'backlog'),'local');
  const phases=path.join(planning,'phases');
  if(fs.existsSync(phases)) {
    if(fs.lstatSync(phases).isSymbolicLink())throw new Error('symlink phases refused');
    for(const name of fs.readdirSync(phases).sort())if(/^999(?:[.-]|$)/.test(name))walk(path.join(phases,name),'gsd999');
  }
  const roadmap=path.join(planning,'ROADMAP.md');
  if(fs.existsSync(roadmap)) {
    if(fs.lstatSync(roadmap).isSymbolicLink())throw new Error('symlink roadmap refused');
    const text=fs.readFileSync(roadmap,'utf8');
    const parked=sections(text,'ROADMAP').filter(s=>/\b999\.\d+\b/.test(s.title));
    if(parked.length)files.push({file:roadmap,kind:'gsd999',selected:parked});
  }
  const records=new Map();
  if(manifest!==null) {
    if(manifest.schema_version!==1||!Array.isArray(manifest.items))throw new Error('manifest schema_version 1 and items array required');
    for(const rec of manifest.items) {
      if(!rec||typeof rec.id!=='string'||!rec.id)throw new Error('manifest item needs id');
      if(records.has(rec.id))throw new Error(`duplicate manifest id: ${rec.id}`);
      if(!STATES.has(rec.status))throw new Error(`unknown manifest status: ${rec.status}`);
      if(['verified_open','verified_closed'].includes(rec.status)) {
        if(!/^[0-9a-f]{40}$/.test(rec.revision||'')||!/^[0-9a-f]{64}$/.test(rec.source_hash||'')||
          !Array.isArray(rec.verification)||!rec.verification.length||rec.verification.some(v=>typeof v!=='string'||!v.trim()))
          throw new Error(`verification evidence required for ${rec.id}`);
      }
      records.set(rec.id,rec);
    }
  }
  const items=[],seen=new Set();
  for(const {file,kind,selected} of files) {
    const text=fs.readFileSync(file,'utf8'),source=`${kind}:${path.relative(real,file).split(path.sep).join('/')}`;
    const sourceHash=hash(text),counts=new Map();
    for(const section of selected || sections(text,path.basename(file,'.md'))) {
      const signature=hash(section.title).slice(0,16),n=(counts.get(signature)||0)+1;counts.set(signature,n);
      const id=`${source}#${signature}:${n}`,rec=records.get(id);seen.add(id);
      const stale=Boolean(rec?.source_hash && rec.source_hash!==sourceHash);
      const content=section.lines.join('\n').trim();
      if(query && !`${source}\n${section.title}\n${content}`.toLowerCase().includes(query.toLowerCase()))continue;
      items.push({id,source,title:section.title,source_hash:sourceHash,
        status:stale?'untriaged':rec?.status||'untriaged',prior_status:stale?rec.status:null,
        verification_stale:stale,revision:rec?.revision||null,verification:rec?.verification||[],
        excerpt:content.slice(0,600),excerpt_truncated:content.length>600});
    }
  }
  return {schema_version:1,sources:files.length,total_items:seen.size,matched_items:items.length,items,
    orphaned_manifest_ids:[...records.keys()].filter(id=>!seen.has(id)),
    evidence_validation:'manifest structure only; no live closure or landed-commit verification',
    read_only:true};
}
function main(args) {
  if(args.length===1&&args[0]==='--help'){console.log('usage: node backlog-index.cjs --root <project> [--manifest <manifest.json>] [--query <text>] [--limit <positive integer>]\nRead-only JSON; default limit 20. No source or installed GSD writes.');return;}
  const opts={};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i],v=args[i+1];
    if(!['--root','--manifest','--query','--limit'].includes(key)||v===undefined||(key!=='--query'&&v.startsWith('--'))||key in opts)
      throw new Error('invalid, duplicate or missing argument; see --help');
    opts[key]=v;
  }
  if(!opts['--root'])throw new Error('--root is required');
  const limit=opts['--limit']===undefined?20:Number(opts['--limit']);
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error('--limit must be a positive integer');
  const manifest=opts['--manifest']?JSON.parse(fs.readFileSync(opts['--manifest'],'utf8')):null;
  const out=inventory(opts['--root'],manifest,opts['--query']||'');
  out.truncated=out.items.length>limit;out.items=out.items.slice(0,limit);
  console.log(JSON.stringify(out,null,2));
}
if(require.main===module){try{main(process.argv.slice(2));}catch(e){console.error(`backlog-index: ${e.message}`);process.exitCode=2;}}
module.exports={inventory,sections};
