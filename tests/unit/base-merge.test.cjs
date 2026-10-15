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

test('failed default fetch refuses cached refs before changing the ticket HEAD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-fetch-'));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.test']); git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'owned.txt'), 'owned'); git(['add', '.']); git(['commit', '-qm', 'seed']);
    git(['branch', 'ticket/T-47-01']); git(['switch', '-c', 'epic/47-policy']);
    fs.writeFileSync(path.join(root, 'base.txt'), 'new base'); git(['add', '.']); git(['commit', '-qm', 'base']);
    git(['update-ref', 'refs/remotes/origin/epic/47-policy', 'HEAD']); git(['switch', 'ticket/T-47-01']);
    git(['remote', 'add', 'origin', path.join(root, 'missing.git')]);
    const before = git(['rev-parse', 'HEAD']);
    const graph = path.join(root, '.planning/graph'); fs.mkdirSync(graph, { recursive: true });
    fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {
      'T-47-01': { phase: '47-policy', files: ['owned.txt'], branch: 'ticket/T-47-01', epic: 'epic/47-policy' },
    } }));
    const result = require('node:child_process').spawnSync(process.execPath,
      [script, 'T-47-01', '--worktree', root, '--base', 'origin/epic/47-policy', '--graph', graph, '--json'],
      { encoding: 'utf8', env: { ...process.env, SHIPYARD_COVERAGE_ROOT: path.join(root, 'coverage') } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch failed; refusing cached origin refs/);
    assert.equal(git(['rev-parse', 'HEAD']), before);
    assert.equal(fs.existsSync(path.join(root, '.git/MERGE_HEAD')), false);
    assert.equal(fs.existsSync(path.join(root, 'base.txt')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function squashFixture({ resolution = 'child\n', foreign = false, filename = 'owned.txt', declared = [filename] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'base-squash-')));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = content => fs.writeFileSync(path.join(root, filename), content);
  git(['init', '-q', '-b', 'main']);
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.test',
    'commit.gpgsign': 'false', 'rerere.enabled': 'true' })) git(['config', key, value]);
  write('seed\n'); git(['add', '.']); git(['commit', '-qm', 'seed']);
  git(['switch', '-c', 'parent']); write('parent\n'); git(['add', '.']); git(['commit', '-qm', 'parent']);
  git(['switch', '-c', 'ticket/T-49-02']); write('child\n'); git(['add', '.']); git(['commit', '-qm', 'child']);
  const head = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  git(['switch', 'main']); git(['switch', '-c', 'epic/49-policy']);
  write(foreign ? 'foreign\n' : 'parent\n'); git(['add', '.']); git(['commit', '-qm', 'squash']);
  const base = git(['rev-parse', 'HEAD']); git(['switch', 'ticket/T-49-02']);
  const conflict = require('node:child_process').spawnSync('git', ['-C', root, 'merge', '--no-edit', base], { encoding: 'utf8' });
  assert.notEqual(conflict.status, 0);
  assert.equal(git(['diff', '--name-only', '--diff-filter=U', '-z']), filename + '\0');
  write(resolution); git(['add', '--', filename]); git(['rerere']); git(['merge', '--abort']);
  git(['config', 'rerere.autoupdate', 'true']);
  const graph = path.join(root, '.planning/graph'); fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' } }));
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {
    'T-49-02': { phase: 49, files: declared, branch: 'ticket/T-49-02', epic: 'epic/49-policy' },
  } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ 'T-49-02': { pr: 9 } }));
  const coverageRoot = path.join(root, 'coverage');
  function run(injection = '') {
    const preload = path.join(root, 'inject.cjs');
    if (injection) fs.writeFileSync(preload, `const cp=require('node:child_process');const original=cp.spawnSync;cp.spawnSync=function(command,args,options){${injection}};`);
    return require('node:child_process').spawnSync(process.execPath,
      [...(injection ? ['--require', preload] : []), script, 'T-49-02', '--worktree', root,
        '--base', 'epic/49-policy', '--graph', graph, '--no-fetch', '--json'],
      { encoding: 'utf8', env: { ...process.env, SHIPYARD_COVERAGE_ROOT: coverageRoot } });
  }
  return { root, git, head, tree, base, coverageRoot, run, write };
}

for (const filename of ['owned.txt', 'owned\nline.txt', 'owned\ttab.txt']) test(`fresh owned squash resolution preserves full tree and genuine coverage: ${JSON.stringify(filename)}`, () => {
  const f = squashFixture({ filename });
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result, 'resolved without content changes'); assert.equal(payload.carry.carried, false);
    assert.equal(f.git(['show', '-s', '--format=%P', 'HEAD']), `${f.head} ${f.base}`);
    assert.equal(f.git(['rev-parse', 'HEAD^{tree}']), f.tree);
    const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
    const verified = coverage.verify({ commit: f.git(['rev-parse', 'HEAD']), repo: coverage.repoSlug(f.root), worktree: f.root, root: f.coverageRoot });
    assert.equal(verified.covered, true, verified.reason); assert.equal(verified.record.kind, 'base-merge');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const [name, options] of [
  ['altered index', { resolution: 'altered\n' }], ['foreign ancestry', { foreign: true }],
  ['unowned resolution', { declared: ['different.txt'] }],
]) test(`squash refuses ${name}`, () => {
  const f = squashFixture(options);
  try { const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /not guessing/);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head); assert.equal(fs.existsSync(f.coverageRoot), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const ref of ['MERGE_HEAD', 'AUTO_MERGE']) test(`preexisting ${ref} refuses before merge`, () => {
  const f = squashFixture();
  try {
    if (ref === 'MERGE_HEAD') {
      const pending = require('node:child_process').spawnSync('git',
        ['-C', f.root, 'merge', '--no-edit', f.base], { encoding: 'utf8' });
      assert.notEqual(pending.status, 0, pending.stdout + pending.stderr);
      assert.equal(f.git(['rev-parse', '--verify', 'MERGE_HEAD']), f.base);
      assert.equal(f.git(['diff', '--name-only', '--diff-filter=U', '-z']), '');
      assert.equal(f.git(['write-tree']), f.tree);
      assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
      f.git(['update-ref', '-d', 'AUTO_MERGE']);
    } else {
      f.git(['update-ref', ref, f.tree]);
    }
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /absent/);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head); assert.equal(fs.existsSync(f.coverageRoot), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('dirty tracked start refuses before merge', () => {
  const f = squashFixture();
  try { f.write('dirty\n'); const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stderr, /uncommitted/);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head); assert.equal(fs.existsSync(f.coverageRoot), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

const afterMerge = body => `const r=original(command,args,options);if(command==='git'&&args[2]==='merge'){${body}}return r;`;
for (const [name, injection] of [
  ['rename with unowned old path', afterMerge("const fs=require('node:fs'),path=require('node:path');const alternate=path.join(args[1],'alternate-index');const env={...options.env,GIT_INDEX_FILE:alternate};const opt={...options,env};original('git',['-C',args[1],'read-tree','HEAD'],opt);original('git',['-C',args[1],'update-index','--force-remove','owned.txt'],opt);const blob=original('git',['-C',args[1],'rev-parse','HEAD:owned.txt'],options).stdout.trim();original('git',['-C',args[1],'update-index','--add','--cacheinfo','100644',blob,'foreign.txt'],opt);const tree=original('git',['-C',args[1],'write-tree'],opt).stdout.trim();original('git',['-C',args[1],'update-ref','AUTO_MERGE',tree],options);")],
  ['missing AUTO_MERGE', afterMerge("original('git',['-C',args[1],'update-ref','-d','AUTO_MERGE'],options);")],
  ['empty AUTO_MERGE diff', afterMerge("const tree=original('git',['-C',args[1],'write-tree'],options).stdout.trim();original('git',['-C',args[1],'update-ref','AUTO_MERGE',tree],options);")],
  ['moved base', afterMerge("original('git',['-C',args[1],'update-ref','refs/heads/epic/49-policy','HEAD'],options);")],
  ['moved HEAD', afterMerge("original('git',['-C',args[1],'update-ref','HEAD','HEAD^'],options);")],
  ['foreign MERGE_HEAD', afterMerge("require('node:fs').writeFileSync(require('node:path').join(args[1],'.git/MERGE_HEAD'),'0'.repeat(40)+'\\n');")],
  ['failed absence probe', "if(command==='git'&&args.includes('--quiet'))return {status:128,stdout:'',stderr:'injected failure'};return original(command,args,options);"],
  ['postcommit tree mismatch', "const r=original(command,args,options);if(command==='git'&&args[2]==='show'&&args.includes('--format=%T'))r.stdout='0'.repeat(40)+'\\n';return r;"],
  ['postcommit dirty worktree', "const r=original(command,args,options);if(command==='git'&&args[2]==='commit')require('node:fs').writeFileSync(require('node:path').join(args[1],'owned.txt'),'dirty');return r;"],
  ['failed write-tree', "if(command==='git'&&args[2]==='write-tree')return {status:128,stdout:'',stderr:'injected failure'};return original(command,args,options);"],
  ['failed diff', "if(command==='git'&&args[2]==='diff'&&args.includes('--no-renames'))return {status:128,stdout:'',stderr:'injected failure'};return original(command,args,options);"],
  ['failed ancestry', "if(command==='git'&&args[2]==='log')return {status:128,stdout:'',stderr:'injected failure'};return original(command,args,options);"],
  ['postcommit parent mismatch', "const r=original(command,args,options);if(command==='git'&&args[2]==='show'&&args.includes('--format=%P'))r.stdout='0'.repeat(40)+'\\n';return r;"],
]) test(`injected ${name} cannot record coverage`, () => {
  const f = squashFixture();
  try { const r = f.run(injection); assert.notEqual(r.status, 0, r.stdout); assert.equal(fs.existsSync(f.coverageRoot), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('trusted writer refusal retains actual merge and refuses success', () => {
  const f = squashFixture();
  try { fs.writeFileSync(f.coverageRoot, 'blocked'); const r = f.run(); assert.notEqual(r.status, 0);
    assert.match(r.stderr, /coverage recording failed/);
    assert.equal(f.git(['show', '-s', '--format=%P', 'HEAD']), `${f.head} ${f.base}`);
    assert.equal(f.git(['rev-parse', 'HEAD^{tree}']), f.tree);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

 test('unstaged rerere result retains owned conflict without coverage', () => {
  const f = squashFixture();
  try { f.git(['config', 'rerere.autoupdate', 'false']); const r = f.run();
    assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).result, 'conflicts remain');
    assert.equal(f.git(['rev-parse', 'HEAD']), f.head); assert.equal(fs.existsSync(f.coverageRoot), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
