'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const script = path.resolve(__dirname,'../../plugins/delivery-pipeline/scripts/base-merge.cjs');
for (const base of ['epic/47-policy', 'develop']) test(`public base-merge preserves scope and ${base === 'develop' ? 're-owes an integration review' : 'skips an epic review'}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'architecture-base-'));
  const git = args => execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  try {
    git(['init','-q','-b','main']); git(['config','user.name','Test']);git(['config','user.email','test@example.test']);git(['config','commit.gpgsign','false']);
    fs.writeFileSync(path.join(root,'owned.txt'),'owned');git(['add','.']);git(['commit','-qm','seed']);
    git(['branch','ticket/T-47-01']);git(['switch','-c',base]);
    fs.writeFileSync(path.join(root,'other.txt'),'base');git(['add','.']);git(['commit','-qm','base change']);git(['switch','ticket/T-47-01']);
    const graph=path.join(root,'.planning/graph');fs.mkdirSync(graph,{recursive:true});
    fs.writeFileSync(path.join(root,'.planning/config.json'),JSON.stringify({git:{base_branch:'develop'}}));
    fs.writeFileSync(path.join(graph,'tickets.json'),JSON.stringify({tickets:{'T-47-01':{phase:47,files:['owned.txt'],epic:'epic/47-policy',branch:'ticket/T-47-01'}}}));
    fs.writeFileSync(path.join(graph,'delivery-state.json'),JSON.stringify({'T-47-01':{pr:9}}));
    const result=JSON.parse(execFileSync(process.execPath,[script,'T-47-01','--worktree',root,'--base',base,'--graph',graph,'--no-fetch','--json'],
      {encoding:'utf8',env:{...process.env,SHIPYARD_COVERAGE_ROOT:path.join(root,'coverage')}}));
    assert.equal(result.carry.carried,false);assert.equal(result.carry.architecture,base === 'develop' ? 'required' : 'skipped-by-target');
    assert.equal(result.carry.carry,base === 'develop' ? 're-owed' : 'skipped-by-target');
    assert.equal(fs.readFileSync(path.join(root,'owned.txt'),'utf8'),'owned');
    assert.equal(fs.readFileSync(path.join(root,'other.txt'),'utf8'),'base');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
