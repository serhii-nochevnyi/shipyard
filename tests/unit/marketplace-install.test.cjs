'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { migrationCandidates } = require('../../scripts/bootstrap-shipyard-plugin.cjs');
const { build, packageFreshnessRequired } = require('../../scripts/package-shipyard-codex.cjs');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-marketplace-'));
try {
  // @contract: Both CLIs use their native installation and enable commands.
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const fake = `#!${process.execPath}\n` + `
const fs=require('fs'); const file=process.env.TEST_STATE;
const s=JSON.parse(fs.readFileSync(file)); const a=process.argv.slice(2);
s.calls.push(a);
const codex=process.argv[1].endsWith('codex');
if(a[0]==='plugin' && a[1]==='marketplace') {
  if(a[2]==='list') console.log(JSON.stringify(codex?{marketplaces:s.marketplaces}:s.marketplaces));
  if(a[2]==='add') s.marketplaces.push({name:'gsd-core'});
} else if(a[1]==='list') console.log(JSON.stringify(codex?{installed:s.plugins}:s.plugins));
else {
  if(s.fail) process.exit(7);
  s.plugins=[{id:'gsd-core@gsd-core',pluginId:'gsd-core@gsd-core',scope:'user',version:'1.14.0',enabled:true}];
}
fs.writeFileSync(file,JSON.stringify(s));
`;
  for (const runtime of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, runtime), fake, { mode: 0o755 });
    const state = path.join(tmp, runtime + '.json');
    const invoke = () => spawnSync(process.execPath, [path.join(root, 'scripts/ensure-gsd-plugin.cjs'), runtime],
      { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_STATE: state }, encoding: 'utf8' });
    fs.writeFileSync(state, JSON.stringify({ marketplaces: [], plugins: [], calls: [] }));
    assert.equal(invoke().status, 0);
    let s = JSON.parse(fs.readFileSync(state));
    assert.equal(s.plugins[0].enabled, true);
    assert(s.calls.some(a => a.join(' ') === `plugin ${runtime === 'codex' ? 'add' : 'install'} gsd-core@gsd-core`));
    s.calls=[];fs.writeFileSync(state,JSON.stringify(s));
    assert.equal(invoke().status,0);
    s=JSON.parse(fs.readFileSync(state));
    assert(s.calls.every(a=>a.includes('list')), 'idempotent check must not reinstall');
    s.plugins[0].enabled=false;s.calls=[];fs.writeFileSync(state,JSON.stringify(s));
    assert.equal(invoke().status,0);
    s=JSON.parse(fs.readFileSync(state));assert.equal(s.plugins[0].enabled,true);
    s.plugins=[];s.fail=true;fs.writeFileSync(state,JSON.stringify(s));
    assert.notEqual(invoke().status,0, 'missing dependency must fail installation');
  }
  const skills = path.join(tmp, 'skills'); const owned = path.join(skills, 'shipyard-route');
  fs.mkdirSync(owned,{recursive:true});fs.writeFileSync(path.join(owned,'SKILL.md'),'original');
  const previous={skills:['shipyard-route'],skill_digests:{'shipyard-route':crypto.createHash('sha256').update('original').digest('hex')}};
  assert.deepEqual(migrationCandidates(skills,previous),[owned]);
  fs.writeFileSync(path.join(owned,'SKILL.md'),'user edit');
  assert.throws(()=>migrationCandidates(skills,previous),/Local modifications/);
  assert.equal(fs.readFileSync(path.join(owned,'SKILL.md'),'utf8'),'user edit');
  fs.writeFileSync(path.join(owned,'SKILL.md'),'original');fs.writeFileSync(path.join(owned,'notes'),'keep');
  assert.throws(()=>migrationCandidates(skills,previous),/Local modifications/);
  assert.throws(()=>migrationCandidates(skills,{skills:['../escape']}),/Unsafe/);
  const out=build(path.join(tmp,'package'));
  const first=JSON.parse(fs.readFileSync(path.join(out,'package-build.json')));
  build(out);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out,'package-build.json'))),first);
  function snapshot(dir) {
    return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
      const p=path.join(dir,e.name);
      if(e.isDirectory()) { const children=snapshot(p); return children.length ? [[e.name,children]] : []; }
      return [[e.name,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]];
    });
  }
  assert.equal(packageFreshnessRequired(''),true);
  assert.equal(packageFreshnessRequired('main'),true);
  assert.equal(packageFreshnessRequired('epic/43-target-project-delivery-at-scale'),false);
  if (packageFreshnessRequired(process.env.GITHUB_BASE_REF)) {
    assert.deepEqual(snapshot(path.join(root,'plugins/shipyard')),snapshot(out),
      'Marketplace package is stale: run make package-shipyard-codex');
  }
  assert.equal(first.skills.length,6);
  assert(fs.existsSync(path.join(out,'host/scripts/ensure-gsd-plugin.cjs')));
  assert(fs.existsSync(path.join(out,'host/plugins/delivery-pipeline/scripts/model-policy.cjs')));
  const hooks=JSON.parse(fs.readFileSync(path.join(out,'hooks/hooks.json')));
  assert(hooks.hooks.SessionStart[0].hooks[0].command.includes('${PLUGIN_ROOT}'));
  const claude=JSON.parse(fs.readFileSync(path.join(root,'plugins/delivery-pipeline/.claude-plugin/plugin.json')));
  assert.deepEqual(claude.dependencies,['gsd-core@gsd-core']);
  const market=JSON.parse(fs.readFileSync(path.join(root,'.claude-plugin/marketplace.json')));
  assert(market.allowCrossMarketplaceDependenciesOn.includes('gsd-core'));
  console.log('marketplace installation tests passed');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
