'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { scripts, hash, git, historicalCiScripts, signingFixture, bounded } = require('./phase53-z29x-native-ci-fix-contract.test.cjs');
const { packageSource, verifyPackage, inventory } = require('./phase53-z29y-native-ci-fix-recovery.test.cjs');
const coverage = require(path.join(scripts, 'conveyor-coverage.cjs'));
const canonical = 'plugins/delivery-pipeline/scripts/role-artifact.cjs';
const mirror = 'plugins/shipyard/host/' + canonical;
const identityPaths = ['plugins/shipyard/.codex-plugin/plugin.json', 'plugins/shipyard/package-build.json'];
function divergentFixture(signing, { conflict = false, generatedEntry = false, modeIntent = false, wrappedBoard = false, multipleConflicts = false, mechanicalCanonical = false, mechanicalPaths = false, ordinaryClean = false, objectFormat = 'sha1' } = {}) {
  const worktree = path.join(signing.directory, 'source-' + crypto.randomUUID());
  fs.mkdirSync(worktree); packageSource(worktree);
  if (mechanicalPaths) for (const file of ['mechanical-file.txt', 'mechanical-delete.txt'])
    fs.writeFileSync(path.join(worktree, file), 'original\n');
  git(worktree, 'init', '-q', '-b', 'main', '--object-format=' + objectFormat);
  for (const [key, value] of Object.entries({ 'user.name': 'Fixture', 'user.email': 'fixture@example.test', 'user.signingkey': signing.signer, 'commit.gpgsign': 'true' }))
    git(worktree, 'config', key, value);
  if (multipleConflicts) fs.writeFileSync(path.join(worktree, '.gitattributes'), canonical + ' merge=union\n');
  git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'fixture supported package');
  git(worktree, 'switch', '-c', 'ticket/T-53-31');
  const file = path.join(worktree, canonical), original = fs.readFileSync(file, 'utf8');
  if (mechanicalPaths) for (const name of ['mechanical-file.txt', 'mechanical-delete.txt'])
    fs.writeFileSync(path.join(worktree, name), 'ticket conflict\n');
  if (ordinaryClean) fs.writeFileSync(path.join(worktree, 'ordinary-ticket.txt'), 'ticket change\n');
  else fs.writeFileSync(file, original.replace("'use strict';", "'use strict';\nvoid 'ticket canonical change';"));
  if (mechanicalCanonical) fs.appendFileSync(path.join(worktree, 'plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'), "\nvoid 'stale ticket canonical change';\n");
  const generate = () => {
    const r = spawnSync(process.execPath, [path.join(worktree, 'scripts/package-shipyard-codex.cjs')], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr); verifyPackage(path.join(worktree, 'plugins/shipyard'));
  };
  generate();
  if (modeIntent) fs.chmodSync(path.join(worktree, identityPaths[0]), 0o755);
  git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'fixture ticket canonical generation');
  const head = git(worktree, 'rev-parse', 'HEAD'), headTree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  git(worktree, 'switch', 'main');
  if (mechanicalPaths) {
    fs.writeFileSync(path.join(worktree, 'mechanical-file.txt'), 'base resolution\n');
    fs.chmodSync(path.join(worktree, 'mechanical-file.txt'), 0o755);
    fs.unlinkSync(path.join(worktree, 'mechanical-delete.txt'));
  }
  if (ordinaryClean) fs.writeFileSync(path.join(worktree, 'ordinary-base.txt'), 'incoming change\n');
  else fs.writeFileSync(file, (conflict || multipleConflicts) ? original.replace("'use strict';", multipleConflicts ? "'use strict';\nvoid 'upstream canonical change';" : "'use strict';\nvoid 'upstream semantic conflict';") : original + "\nvoid 'upstream canonical change';\n");
  if (!ordinaryClean) fs.appendFileSync(path.join(worktree, 'plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'), "\nvoid 'independent upstream canonical change';\n");
  generate(); git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'fixture incoming canonical generation');
  const base = git(worktree, 'rev-parse', 'HEAD'), baseTree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  git(worktree, 'switch', 'ticket/T-53-31');
  const project = path.join(signing.directory, 'project-' + crypto.randomUUID()), graphDir = path.join(project, '.planning/graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(project, '.planning/PLAN.md'), '# Approved supported generated merge\n');
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: { 'T-53-31': {
    phase: 53, branch: 'ticket/T-53-31', pr_base: 'main', plan: '.planning/PLAN.md',
    files: [canonical, mirror, ...identityPaths, ...(ordinaryClean ? ['ordinary-ticket.txt'] : [])], repo: 'fixture/repository',
  } } }));
  const board = { 'T-53-31': { pr: 501, branch: 'ticket/T-53-31', base: 'main' } };
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify(wrappedBoard ? { tickets: board } : board));
  const entryPackage = path.join(signing.directory, 'entry-' + crypto.randomUUID());
  if (generatedEntry) fs.cpSync(path.join(worktree, 'plugins/shipyard'), entryPackage, { recursive: true });
  const script = generatedEntry ? path.join(entryPackage, 'host/plugins/delivery-pipeline/scripts/base-merge.cjs') : path.join(scripts, 'base-merge.cjs');
  const run = injection => {
    const preload = path.join(signing.directory, 'injection-' + crypto.randomUUID() + '.cjs');
    if (injection) fs.writeFileSync(preload, injection);
    return spawnSync(process.execPath, [...(injection ? ['--require', preload] : []), script, 'T-53-31', '--worktree', worktree,
      '--base', 'main', '--graph', graphDir, '--no-fetch', '--json'], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  };
  return { worktree, graphDir, head, headTree, base, baseTree, script, run, generate,
    proofDirectory: path.join(signing.directory, '.local/state/shipyard/codex/finalization', hash(worktree), 'generated-base-merges') };
}
function inspectSuccess(f, response) {
  assert.equal(response.status, 0, response.stderr + response.stdout);
  const result = JSON.parse(response.stdout), head = git(f.worktree, 'rev-parse', 'HEAD');
  assert.equal(result.result, 'regenerated supported package'); assert.equal(result.commit, head);
  assert.equal(git(f.worktree, 'show', '-s', '--format=%P', head), f.head + ' ' + f.base);
  assert.notEqual(result.tree, f.headTree); assert.notEqual(result.tree, f.baseTree); git(f.worktree, 'verify-commit', head);
  assert.equal(git(f.worktree, 'status', '--porcelain=v1', '--untracked-files=no'), '');
  for (const ref of ['MERGE_HEAD', 'AUTO_MERGE']) assert.throws(() => git(f.worktree, 'rev-parse', '--verify', ref));
  assert.match(fs.readFileSync(path.join(f.worktree, canonical), 'utf8'), /ticket canonical change/);
  assert.match(fs.readFileSync(path.join(f.worktree, canonical), 'utf8'), /upstream canonical change/);
  assert.match(fs.readFileSync(path.join(f.worktree, 'plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'), 'utf8'), /independent upstream canonical change/);
  const checked = coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: head });
  assert.equal(checked.covered, true, checked.reason); assert.equal(checked.record.kind, 'base-merge');
  assert.deepEqual(checked.record.parents, [f.head, f.base]); assert.equal(checked.record.tree, result.tree);
  const proofs = fs.readdirSync(f.proofDirectory).filter(name => name.endsWith('.json'));
  assert.equal(proofs.length, 1);
  const operation = JSON.parse(fs.readFileSync(path.join(f.proofDirectory, proofs[0]))).payload;
  const sourceEntries = (operation.combined_stages || operation.observed.stages).filter(row => row.stage === 0);
  const treeEntries = execTree(f.worktree, operation.generation.source_tree);
  assert.ok(sourceEntries.length > 100);
  assert.deepEqual(treeEntries, sourceEntries.map(({ mode, oid, path }) => ({ mode, oid, path })));
  const physicalSource = path.join(f.proofDirectory, operation.id, operation.generation.directory, 'source');
  const sourceFiles = inventory(physicalSource).filter(entry => entry.type === 'file');
  assert.equal(sourceFiles.length, sourceEntries.length);
  const objectFormat = git(f.worktree, 'rev-parse', '--show-object-format');
  for (const entry of sourceEntries) {
    const actual = sourceFiles.find(file => file.path === entry.path);
    assert.ok(actual, entry.path); assert.equal(actual.mode, entry.mode === '100755' ? 0o755 : 0o644);
    const bytes = fs.readFileSync(path.join(physicalSource, entry.path));
    assert.equal(actual.bytes, bytes.length); assert.equal(actual.sha256, hash(bytes));
    assert.equal(crypto.createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), entry.oid);
  }
  verifyPackage(path.join(f.worktree, 'plugins/shipyard'));
  const before = inventory(path.join(f.worktree, 'plugins/shipyard')); f.generate();
  assert.deepEqual(inventory(path.join(f.worktree, 'plugins/shipyard')), before);
  assert.equal(git(f.worktree, 'status', '--porcelain=v1', '--untracked-files=no'), '');
  const cold = spawnSync(process.execPath, ['-e', 'const c=require(process.argv[1]);const r=c.verify(JSON.parse(process.argv[2]));if(!r.covered||r.record.kind!=="base-merge")throw Error(r.reason);',
    path.join(f.worktree, 'plugins/shipyard/host/plugins/delivery-pipeline/scripts/conveyor-coverage.cjs'), JSON.stringify({ worktree: f.worktree, repo: 'fixture/repository', commit: head })],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(cold.status, 0, cold.stderr);
  return result;
}
function execTree(worktree, tree) {
  const bytes = require('node:child_process').execFileSync('git', ['-C', worktree, 'ls-tree', '-r', '-z', tree],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return bytes.split('\0').filter(Boolean).map(row => {
    const match = /^(\d{6}) blob ([a-f0-9]{40,64})\t([^]+)$/.exec(row); assert.ok(match, row);
    return { mode: match[1], oid: match[2], path: match[3] };
  });
}
function retainedOperation(f) {
  const files = fs.readdirSync(f.proofDirectory).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(f.proofDirectory, files[0]))).payload;
}
function partialApplyInjection(f, phase) {
  return `const fs=require('node:fs'),cp=require('node:child_process');const root=${JSON.stringify(f.worktree)},proof=${JSON.stringify(f.proofDirectory)},phase=${JSON.stringify(phase)};
    let writes=0,adds=0;const intended=()=>{if(!fs.existsSync(proof))return null;const file=fs.readdirSync(proof).find(n=>n.endsWith('.json'));if(!file)return null;return JSON.parse(fs.readFileSync(proof+'/'+file)).payload;};
    const write=fs.writeFileSync;fs.writeFileSync=function(file,...rest){const result=write.call(this,file,...rest);const op=intended();if(typeof file==='string'&&file.startsWith(root+'/plugins/shipyard/')&&op?.apply){writes++;if(phase==='write'&&writes===1)process.exit(95);}return result;};
    const chmod=fs.chmodSync;fs.chmodSync=function(file,...rest){const result=chmod.call(this,file,...rest);if(phase==='chmod'&&typeof file==='string'&&file.startsWith(root+'/plugins/shipyard/')&&intended()?.apply)process.exit(96);return result;};
    const exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const result=exec.call(this,command,args,...rest);if(command==='git'&&args[1]===root&&args[2]==='add'&&intended()?.apply){adds++;if((phase==='first-add'&&adds===1)||(phase==='multiple-adds'&&adds===2))process.exit(97);}return result;};`;
}
if (require.main === module) {
  test('legacy real finished signed merge remains admitted without new signing or altered original identity', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing), root = path.resolve(__dirname, '../..'), legacy = path.join(signing.directory, 'legacy-source');
      fs.mkdirSync(legacy); fs.cpSync(path.join(root, 'scripts'), path.join(legacy, 'scripts'), { recursive: true });
      fs.cpSync(path.join(root, 'plugins'), path.join(legacy, 'plugins'), { recursive: true });
      const oldScripts = path.join(legacy, 'plugins/delivery-pipeline/scripts');
      historicalCiScripts(oldScripts);
      const counter = path.join(signing.directory, 'legacy-finished-sign-count'), entry = path.join(signing.directory, 'legacy-finished-entry.cjs');
      fs.writeFileSync(entry, `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='commit-tree'&&args.some(a=>a.startsWith('-S')))fs.appendFileSync(${JSON.stringify(counter)},'1');return r;};const h=require(${JSON.stringify(path.join(oldScripts,'codex-delivery-host.cjs'))}).generatedBaseMergeAuthority({worktree:${JSON.stringify(f.worktree)},ticket:'T-53-31',graphDir:${JSON.stringify(f.graphDir)},requestedBase:'main',noFetch:true});process.on('exit',()=>h.release());h.prepare();try{cp.execFileSync('git',['-C',${JSON.stringify(f.worktree)},'merge','--no-edit','main'],{stdio:'pipe'});}catch(e){if(e.status!==1)throw e;}h.observe();h.complete([]);`);
      const first = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 180000, maxBuffer: 8*1024*1024 });
      assert.equal(first.status, 0, first.stderr + first.stdout);
      const old = retainedOperation(f), oid = git(f.worktree, 'rev-parse', 'HEAD');
      assert.equal(old.phase, 'completed'); assert.equal(old.signing, undefined); assert.equal(old.intent_protocol, undefined);
      const injection = `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='commit-tree'&&args.some(a=>a.startsWith('-S')))fs.appendFileSync(${JSON.stringify(counter)},'1');return r;};`;
      const response = f.run(injection); assert.equal(response.status, 0, response.stderr + response.stdout);
      assert.equal(JSON.parse(response.stdout).commit, oid); assert.equal(fs.readFileSync(counter, 'utf8'), '1');
      assert.equal(retainedOperation(f).id, old.id); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), oid);
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: oid }).covered, true);
    } finally { signing.close(); }
  });

  test('legacy real captured producer post-object gap never gains a second signing during current recovery', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing), root = path.resolve(__dirname, '../..'), legacy = path.join(signing.directory, 'legacy-source');
      fs.mkdirSync(legacy); fs.cpSync(path.join(root, 'scripts'), path.join(legacy, 'scripts'), { recursive: true });
      fs.cpSync(path.join(root, 'plugins'), path.join(legacy, 'plugins'), { recursive: true });
      const oldScripts = path.join(legacy, 'plugins/delivery-pipeline/scripts');
      historicalCiScripts(oldScripts);
      const counter = path.join(signing.directory, 'legacy-sign-count'), entry = path.join(signing.directory, 'legacy-merge-entry.cjs');
      fs.writeFileSync(entry, `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='commit-tree'&&args.some(a=>a.startsWith('-S'))){fs.appendFileSync(${JSON.stringify(counter)},'1');process.exit(86);}return r;};const h=require(${JSON.stringify(path.join(oldScripts,'codex-delivery-host.cjs'))}).generatedBaseMergeAuthority({worktree:${JSON.stringify(f.worktree)},ticket:'T-53-31',graphDir:${JSON.stringify(f.graphDir)},requestedBase:'main',noFetch:true});process.on('exit',()=>h.release());h.prepare();try{cp.execFileSync('git',['-C',${JSON.stringify(f.worktree)},'merge','--no-edit','main'],{stdio:'pipe'});}catch(e){if(e.status!==1)throw e;}h.observe();h.complete([]);`);
      const first = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 180000, maxBuffer: 8*1024*1024 });
      assert.equal(first.status, 86, first.stderr + first.stdout);
      const op = retainedOperation(f); assert.equal(op.phase, 'staged'); assert.equal(op.commit, undefined); assert.equal(op.signing, undefined);
      const injection = `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='commit-tree'&&args.some(a=>a.startsWith('-S')))fs.appendFileSync(${JSON.stringify(counter)},'1');return r;};`;
      const before = inventory(f.worktree), proof = inventory(f.proofDirectory), resumed = f.run(injection);
      assert.equal(fs.readFileSync(counter, 'utf8'), '1', 'legacy original had already physically signed; current recovery must not sign again');
      assert.notEqual(resumed.status, 0, 'unbound legacy original object must not be adopted');
      assert.deepEqual(inventory(f.worktree), before); assert.deepEqual(inventory(f.proofDirectory), proof);
      assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
    } finally { signing.close(); }
  });

  test('generated merge recovery retains SHA256 exact original generated and ordinary signed merges', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mode of ['generated', 'ordinary']) await t.test(mode, bounded, () => {
        const f = divergentFixture(signing, { ordinaryClean: mode === 'ordinary', objectFormat: 'sha256' });
        const injection = `const cp=require('node:child_process'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&(${JSON.stringify(mode)}==='generated'?args[2]==='commit-tree':args.includes('merge')&&args.includes('--no-edit')))process.exit(86);return r;};`;
        const first = f.run(injection); assert.equal(first.status, 86, first.stderr + first.stdout);
        const op = retainedOperation(f); let oid;
        if (mode === 'generated') {
          const prefix = fs.readdirSync(op.signing.root.path)[0]; oid = prefix + fs.readdirSync(path.join(op.signing.root.path, prefix))[0];
        } else oid = git(f.worktree, 'rev-parse', 'HEAD');
        assert.equal(oid.length, 64);
        const response = f.run(); assert.equal(response.status, 0, response.stderr + response.stdout);
        const result = JSON.parse(response.stdout); assert.equal(result.commit, oid);
        assert.match(git(f.worktree, 'cat-file', 'commit', oid), /^gpgsig-sha256 /m);
        assert.equal(git(f.worktree, 'show', '-s', '--format=%P', oid), f.head + ' ' + f.base);
        assert.equal(git(f.worktree, 'status', '--porcelain=v1', '--untracked-files=no'), ''); git(f.worktree, 'verify-commit', oid);
        assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: oid }).covered, true);
      });
    } finally { signing.close(); }
  });

  test('ordinary merge recovery preserves resolved origin base when no merge operation is needed', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing, { ordinaryClean: true });
      git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head);
      const response = f.run(); assert.equal(response.status, 0, response.stderr + response.stdout);
      assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
      assert.equal(fs.existsSync(path.join(f.worktree, 'ordinary-base.txt')), false);
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: f.head }).covered, false);
    } finally { signing.close(); }
  });
  test('ordinary merge recovery recovers exact fast-forward without granting new merge coverage', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing, { ordinaryClean: true });
      git(f.worktree, 'branch', '-f', 'main', f.head); git(f.worktree, 'switch', 'main');
      fs.writeFileSync(path.join(f.worktree, 'ordinary-future.txt'), 'future\n'); git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'incoming descendant');
      const incoming = git(f.worktree, 'rev-parse', 'HEAD'); git(f.worktree, 'switch', 'ticket/T-53-31');
      const injection = `const cp=require('node:child_process'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args.includes('merge')&&args.includes('--no-edit'))process.exit(86);return r;};`;
      const first = f.run(injection); assert.equal(first.status, 86, first.stderr + first.stdout);
      assert.equal(retainedOperation(f).ordinary_intent.kind, 'fast-forward');
      const response = f.run(); assert.equal(response.status, 0, response.stderr + response.stdout);
      assert.equal(JSON.parse(response.stdout).commit, incoming); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), incoming);
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: incoming }).covered, false);
    } finally { signing.close(); }
  });
  test('ordinary merge recovery refuses changed tracked source, index and signer before coverage or proof writes', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['source', 'index', 'signer']) await t.test(mutation, bounded, () => {
        const f = divergentFixture(signing, { ordinaryClean: true });
        const injection = `const cp=require('node:child_process'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args.includes('merge')&&args.includes('--no-edit'))process.exit(86);return r;};`;
        assert.equal(f.run(injection).status, 86); const head = git(f.worktree, 'rev-parse', 'HEAD');
        if (mutation === 'signer') git(f.worktree, 'config', 'user.signingkey', '0000000000000000000000000000000000000000');
        else { fs.appendFileSync(path.join(f.worktree, 'ordinary-ticket.txt'), 'foreign\n'); if (mutation === 'index') git(f.worktree, 'add', '--', 'ordinary-ticket.txt'); }
        const before = inventory(f.worktree), proof = inventory(f.proofDirectory), response = f.run();
        assert.notEqual(response.status, 0); assert.deepEqual(inventory(f.worktree), before); assert.deepEqual(inventory(f.proofDirectory), proof);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), head);
        assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: head }).covered, false);
      });
    } finally { signing.close(); }
  });
  test('ordinary merge recovery recovers post-HEAD and post-coverage interruptions as the exact original merge', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['head', 'coverage']) await t.test(phase, bounded, () => {
        const f = divergentFixture(signing, { ordinaryClean: true }), counter = path.join(signing.directory, 'ordinary-calls-' + phase);
        const injection = `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync,link=fs.linkSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args.includes('merge')&&args.includes('--no-edit')){fs.appendFileSync(${JSON.stringify(counter)},'1');if(${JSON.stringify(phase)}==='head')process.exit(86);}return r;};fs.linkSync=function(a,b,...rest){const r=link.call(this,a,b,...rest);if(${JSON.stringify(phase)}==='coverage'&&b.startsWith(${JSON.stringify(path.join(signing.directory,'coverage'))})&&b.endsWith('.json'))process.exit(87);return r;};`;
        const first = f.run(injection); assert.equal(first.status, phase === 'head' ? 86 : 87, first.stderr + first.stdout);
        const originalOID = git(f.worktree, 'rev-parse', 'HEAD'), op = retainedOperation(f);
        assert.equal(op.phase, 'prepared'); assert.equal(op.commit, undefined); assert.equal(op.ordinary_head, undefined);
        assert.equal(op.ordinary_intent.kind, 'merge'); assert.notEqual(originalOID, f.head);
        const response = f.run(); assert.equal(response.status, 0, response.stderr + response.stdout);
        const result = JSON.parse(response.stdout); assert.equal(result.commit, originalOID);
        assert.equal(fs.readFileSync(counter, 'utf8'), '1'); assert.equal(retainedOperation(f).id, op.id);
        assert.equal(retainedOperation(f).phase, 'ordinary');
        assert.equal(git(f.worktree, 'show', '-s', '--format=%P', originalOID), f.head + ' ' + f.base);
        assert.equal(git(f.worktree, 'status', '--porcelain=v1', '--untracked-files=no'), ''); git(f.worktree, 'verify-commit', originalOID);
        const checked = coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: originalOID });
        assert.equal(checked.covered, true, checked.reason); assert.equal(checked.record.kind, 'base-merge');
        assert.equal(git(f.worktree, 'rev-list', '--count', '--merges', `${f.head}..HEAD`), '1');
      });
    } finally { signing.close(); }
  });
  test('ordinary merge recovery refuses a different signed HEAD even with identical original parents and tree', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing, { ordinaryClean: true });
      const injection = `const cp=require('node:child_process'),exec=cp.execFileSync;cp.execFileSync=function(cmd,args,...rest){const r=exec.call(this,cmd,args,...rest);if(cmd==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args.includes('merge')&&args.includes('--no-edit'))process.exit(86);return r;};`;
      const first = f.run(injection); assert.equal(first.status, 86, first.stderr + first.stdout);
      const op = retainedOperation(f), original = git(f.worktree, 'rev-parse', 'HEAD');
      const foreign = git(f.worktree, 'commit-tree', '-S' + signing.signer, op.ordinary_intent.tree, '-p', f.head, '-p', f.base, '-m', 'foreign signed merge');
      git(f.worktree, 'update-ref', 'HEAD', foreign, original);
      const before = inventory(f.worktree), proof = inventory(f.proofDirectory), response = f.run();
      assert.notEqual(response.status, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), foreign);
      assert.deepEqual(inventory(f.worktree), before); assert.deepEqual(inventory(f.proofDirectory), proof);
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: foreign }).covered, false);
    } finally { signing.close(); }
  });

  test('generated signing recovery refuses missing, ambiguous, substituted and aliased objects without replay', bounded, async t => {
    const snapshot = directory => {
      const entries = [], visit = (dir, prefix) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const file = path.join(dir, name), stat = fs.lstatSync(file), relative = prefix + name;
          const entry = { path: relative, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
          if (stat.isSymbolicLink()) entries.push({ ...entry, type: 'symlink', target: fs.readlinkSync(file) });
          else if (stat.isDirectory()) { entries.push({ ...entry, type: 'directory' }); visit(file, relative + '/'); }
          else { assert.equal(stat.isFile(), true); entries.push({ ...entry, type: 'file', bytes: stat.size, sha256: hash(fs.readFileSync(file)) }); }
        }
      }; visit(directory, ''); return entries;
    };
    const signing = signingFixture();
    try {
      for (const mutation of ['missing', 'ambiguous', 'substituted', 'symlink']) await t.test(mutation, bounded, () => {
        const f = divergentFixture(signing), count = path.join(signing.directory, 'sign-count-' + mutation);
        const injection = `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const r=exec.call(this,command,args,...rest);if(command==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='commit-tree'){fs.appendFileSync(${JSON.stringify(count)},'1');process.exit(86);}return r;};`;
        assert.equal(f.run(injection).status, 86);
        const op = retainedOperation(f), objectRoot = op.signing.root.path, prefix = fs.readdirSync(objectRoot)[0], folder = path.join(objectRoot, prefix), suffix = fs.readdirSync(folder)[0], object = path.join(folder, suffix);
        if (mutation === 'missing') fs.unlinkSync(object);
        if (mutation === 'ambiguous') fs.copyFileSync(object, path.join(folder, (suffix[0] === 'a' ? 'b' : 'a') + suffix.slice(1)));
        if (mutation === 'substituted') {
          fs.chmodSync(object, 0o600);
          fs.copyFileSync(path.join(f.worktree, '.git', 'objects', f.head.slice(0, 2), f.head.slice(2)), object);
        }
        if (mutation === 'symlink') { fs.renameSync(object, object + '.retained'); fs.symlinkSync(object + '.retained', object); }
        const before = inventory(f.worktree), proof = snapshot(f.proofDirectory), response = f.run();
        assert.notEqual(response.status, 0); assert.equal(fs.readFileSync(count, 'utf8'), '1');
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
        assert.deepEqual(inventory(f.worktree), before); assert.deepEqual(snapshot(f.proofDirectory), proof);
        assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: f.head }).covered, false);
      });
    } finally { signing.close(); }
  });
  test('generated signing recovery recovers exact object after signed creation before OID persistence without re-signing', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing), count = path.join(signing.directory, 'physical-signing-count');
      const injection = `const cp=require('node:child_process'),fs=require('node:fs'),exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const signed=command==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='commit-tree';const r=exec.call(this,command,args,...rest);if(signed){fs.appendFileSync(${JSON.stringify(count)},'sign\\n');process.exit(86);}return r;};`;
      const first = f.run(injection); assert.equal(first.status, 86, first.stderr + first.stdout);
      const op = retainedOperation(f); assert.equal(op.phase, 'staged'); assert.equal(op.commit, undefined); assert.ok(op.signing);
      const objectRoot = op.signing.root.path, objects = fs.readdirSync(objectRoot).flatMap(prefix => fs.readdirSync(path.join(objectRoot, prefix)).map(suffix => prefix + suffix));
      assert.equal(objects.length, 1); const originalOID = objects[0];
      const result = inspectSuccess(f, f.run()); assert.equal(result.commit, originalOID);
      assert.equal(fs.readFileSync(count, 'utf8'), 'sign\n');
      assert.equal(retainedOperation(f).id, op.id); assert.equal(git(f.worktree, 'rev-list', '--count', '--merges', `${f.head}..HEAD`), '1');
      assert.equal(inspectSuccess(f, f.run()).commit, originalOID); assert.equal(fs.readFileSync(count, 'utf8'), 'sign\n');
    } finally { signing.close(); }
  });

  for (const wrappedBoard of [false, true]) for (const generatedEntry of [false, true]) test(`${wrappedBoard ? 'wrapped' : 'flat'} delivery state: actual divergent whole generations produce a signed covered combined merge through ${generatedEntry ? 'generated' : 'canonical'} entrypoint`, bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing, { generatedEntry, wrappedBoard }); inspectSuccess(f, f.run());
      const before = git(f.worktree, 'rev-parse', 'HEAD'); inspectSuccess(f, f.run()); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), before);
    } finally { signing.close(); }
  });
  test('authenticated mechanical canonical resolution leaves only generated stages eligible', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing, { mechanicalCanonical: true });
      const result = inspectSuccess(f, f.run());
      assert.ok(result.taken_from_base.includes('plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'));
      const operation = retainedOperation(f);
      assert.ok(operation.observed.unmerged.includes('plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'));
      assert.equal(operation.combined_stages.some(row => row.stage !== 0 && row.path.startsWith('plugins/delivery-pipeline/')), false);
    } finally { signing.close(); }
  });
  test('cold mechanical recovery retains original per-path intent before checkout, removal and combined-state persistence', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['retained', 'checkout', 'remove', 'combined']) await t.test(phase, bounded, () => {
        const f = divergentFixture(signing, { mechanicalCanonical: true, mechanicalPaths: true });
        const injection = `const fs=require('node:fs'),cp=require('node:child_process');const phase=${JSON.stringify(phase)},root=${JSON.stringify(f.worktree)},proof=${JSON.stringify(f.proofDirectory)};
          const rename=fs.renameSync;fs.renameSync=function(a,b,...rest){const r=rename.call(this,a,b,...rest);if(b.startsWith(proof)&&b.endsWith('.json')){const p=JSON.parse(fs.readFileSync(b)).payload;if(p.mechanical&&((phase==='retained'&&!p.taken.length)||(phase==='combined'&&p.taken.length&&!p.generation)))process.exit(86);}return r;};
          const exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const r=exec.call(this,command,args,...rest);if(command==='git'&&args[1]===root&&((phase==='checkout'&&args[2]==='checkout')||(phase==='remove'&&args[2]==='rm')))process.exit(87);return r;};`;
        assert.equal(f.run(injection).status, ['retained', 'combined'].includes(phase) ? 86 : 87);
        const original = retainedOperation(f);
        assert.equal(original.phase, 'conflicted'); assert.ok(original.mechanical.paths.length >= 3);
        assert.ok(original.mechanical.paths.some(entry => entry.intended.type === 'absent'));
        for (const entry of original.mechanical.paths) if (entry.original_pin)
          assert.equal(hash(fs.readFileSync(entry.original_pin.path)), entry.original.sha256);
        const result = inspectSuccess(f, f.run());
        assert.equal(retainedOperation(f).id, original.id);
        assert.equal(git(f.worktree, 'rev-list', '--count', '--merges', `${f.head}..HEAD`), '1');
        assert.deepEqual(result.taken_from_base, original.mechanical.paths.map(entry => entry.path));
        assert.equal(fs.readFileSync(path.join(f.worktree, 'mechanical-file.txt'), 'utf8'), 'base resolution\n');
        assert.equal(fs.statSync(path.join(f.worktree, 'mechanical-file.txt')).mode & 0o777, 0o755);
        assert.equal(fs.existsSync(path.join(f.worktree, 'mechanical-delete.txt')), false);
        assert.equal(inspectSuccess(f, f.run()).commit, result.commit);
      });
    } finally { signing.close(); }
  });
  test('partial mechanical recovery refuses foreign bytes, modes, stages, source and retained originals without writes', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['bytes', 'mode', 'stage', 'source', 'original', 'deleted-path']) await t.test(mutation, bounded, () => {
        const f = divergentFixture(signing, { mechanicalPaths: true });
        const injection = `const cp=require('node:child_process'),exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const r=exec.call(this,command,args,...rest);if(command==='git'&&args[1]===${JSON.stringify(f.worktree)}&&args[2]==='checkout')process.exit(87);return r;};`;
        assert.equal(f.run(injection).status, 87);
        const op = retainedOperation(f), entry = op.mechanical.paths.find(entry => entry.path === 'mechanical-file.txt');
        const target = path.join(f.worktree, entry.path);
        if (mutation === 'bytes') fs.writeFileSync(target, 'foreign mechanical content\n');
        if (mutation === 'mode') fs.chmodSync(target, 0o600);
        if (mutation === 'stage') { fs.writeFileSync(target, 'foreign staged content\n'); git(f.worktree, 'add', '--', entry.path); }
        if (mutation === 'source') fs.appendFileSync(path.join(f.worktree, canonical), '\nvoid "foreign source";\n');
        if (mutation === 'original') fs.appendFileSync(entry.original_pin.path, 'foreign retained content');
        if (mutation === 'deleted-path') fs.writeFileSync(path.join(f.worktree, 'mechanical-delete.txt'), 'foreign deleted content\n');
        const before = inventory(f.worktree), proof = inventory(f.proofDirectory);
        const response = f.run(); assert.notEqual(response.status, 0, response.stdout);
        assert.deepEqual(inventory(f.worktree), before); assert.deepEqual(inventory(f.proofDirectory), proof);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
        assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: f.head }).covered, false);
      });
    } finally { signing.close(); }
  });
  test('unresolved canonical source conflict stays owned and uncommitted with both semantic sides retained', bounded, () => {
    const signing = signingFixture();
    try {
      const f = divergentFixture(signing, { conflict: true }), r = f.run();
      assert.notEqual(r.status, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
      const stages = git(f.worktree, 'ls-files', '--unmerged', '--', canonical); assert.match(stages, / 2\t/); assert.match(stages, / 3\t/);
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: f.head }).covered, false);
      assert.equal(retainedOperation(f).phase, 'manual');
      git(f.worktree, 'checkout', '--ours', '--', '.'); git(f.worktree, 'add', '.');
      git(f.worktree, 'commit', '--no-edit');
      const manualHead = git(f.worktree, 'rev-parse', 'HEAD');
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: manualHead }).covered, false);
      const retry = f.run(); assert.equal(retry.status, 0, retry.stderr);
      assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), manualHead);
      assert.equal(retainedOperation(f).phase, 'manual');
      assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: manualHead }).covered, false);
    } finally { signing.close(); }
  });
  test('same-original generated merge resumes signed-object, HEAD, cleanup and ambiguous coverage interruptions without a second commit', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['conflicted', 'staged', 'signed', 'head', 'cleanup', 'coverage']) await t.test(phase, bounded, () => {
        const f = divergentFixture(signing);
        const injection = `const fs=require('node:fs'),cp=require('node:child_process');let once=false;const phase=${JSON.stringify(phase)};
          const rename=fs.renameSync;fs.renameSync=function(a,b,...rest){const result=rename.call(this,a,b,...rest);if(!once&&b.endsWith('.json')&&b.includes('generated-base-merges')){const p=JSON.parse(fs.readFileSync(b)).payload;if(p.phase===phase){once=true;process.exit(91);}}return result;};
          const exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const result=exec.call(this,command,args,...rest);if(!once&&command==='git'&&((phase==='head'&&args[2]==='update-ref'&&args[3]==='HEAD')||(phase==='cleanup'&&args[2]==='merge'&&args[3]==='--quit'))){once=true;process.exit(92);}return result;};
          const link=fs.linkSync;fs.linkSync=function(a,b,...rest){const result=link.call(this,a,b,...rest);if(!once&&phase==='coverage'&&b.startsWith(process.env.SHIPYARD_COVERAGE_ROOT)&&b.endsWith('.json')){once=true;process.exit(93);}return result;};`;
        const first = f.run(injection); assert.notEqual(first.status, 0, first.stdout);
        const files = fs.readdirSync(f.proofDirectory).filter(name => name.endsWith('.json')); assert.equal(files.length, 1);
        const retained = JSON.parse(fs.readFileSync(path.join(f.proofDirectory, files[0]))).payload;
        const result = inspectSuccess(f, f.run());
        if (retained.commit) assert.equal(result.commit, retained.commit);
        const commits = git(f.worktree, 'rev-list', '--merges', `${f.head}..HEAD`).split('\n').filter(Boolean); assert.equal(commits.length, 1);
      });
    } finally { signing.close(); }
  });
  test('cold generated merge reconciles exact partial writes, chmod and multiple staged conflicts to the one intended covered merge', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['write', 'chmod', 'first-add', 'multiple-adds']) await t.test(phase, bounded, () => {
        const f = divergentFixture(signing, { modeIntent: phase === 'chmod', multipleConflicts: true });
        const first = f.run(partialApplyInjection(f, phase));
        assert.equal(first.status, phase === 'write' ? 95 : phase === 'chmod' ? 96 : 97, first.stderr + first.stdout);
        const original = retainedOperation(f);
        assert.equal(original.phase, 'conflicted'); assert.ok(original.apply.paths.length >= 3);
        assert.ok(original.apply.paths.every(entry => entry.original_stages.length && entry.intended_stages.length === 1));
        const generation = path.join(f.proofDirectory, original.id, original.generation.directory);
        const before = inventory(generation);
        for (const entry of original.apply.paths) {
          const retained = fs.readFileSync(path.join(generation, entry.original_file));
          assert.equal(hash(retained), entry.original.sha256); assert.equal(retained.length, entry.original.bytes);
        }
        const currentStages = git(f.worktree, 'ls-files', '--stage');
        if (phase === 'first-add' || phase === 'multiple-adds') {
          const resolved = original.apply.paths.filter(entry => currentStages.includes(`${entry.intended_stages[0].oid} 0\t${entry.path}`));
          assert.equal(resolved.length, phase === 'first-add' ? 1 : 2);
        }
        const result = inspectSuccess(f, f.run());
        assert.equal(result.tree, original.apply.tree);
        assert.deepEqual(inventory(generation), before, 'last authoritative combined generation remains intact');
        const completed = retainedOperation(f); assert.equal(completed.id, original.id);
        assert.equal(completed.commit, result.commit); assert.equal(completed.generation.directory, original.generation.directory);
        assert.equal(git(f.worktree, 'rev-list', '--count', '--merges', `${f.head}..HEAD`), '1');
        assert.equal(inspectSuccess(f, f.run()).commit, result.commit);
      });
    } finally { signing.close(); }
  });
  test('partial generated apply refuses third bytes, modes, stages and unrelated index or source without foreign overwrite', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['bytes', 'mode', 'stage', 'index', 'source', 'retained-original']) await t.test(mutation, bounded, () => {
        const f = divergentFixture(signing);
        assert.equal(f.run(partialApplyInjection(f, 'first-add')).status, 97);
        const op = retainedOperation(f), entry = op.apply.paths[0], target = path.join(f.worktree, entry.path);
        if (mutation === 'bytes') fs.writeFileSync(target, 'third generated bytes');
        if (mutation === 'mode') fs.chmodSync(target, 0o600);
        if (mutation === 'stage') {
          fs.writeFileSync(target, 'third generated stage'); git(f.worktree, 'add', '--', entry.path);
          fs.writeFileSync(target, fs.readFileSync(path.join(f.proofDirectory, op.id, op.generation.directory, 'package', entry.path.slice('plugins/shipyard/'.length))));
        }
        if (['index', 'source'].includes(mutation)) {
          fs.appendFileSync(path.join(f.worktree, canonical), '\nvoid "third source";\n');
          if (mutation === 'index') git(f.worktree, 'add', '--', canonical);
        }
        if (mutation === 'retained-original') fs.appendFileSync(path.join(f.proofDirectory, op.id, op.generation.directory, entry.original_file), 'third retained original');
        const proofBytes = fs.readFileSync(path.join(f.proofDirectory, fs.readdirSync(f.proofDirectory).find(file => file.endsWith('.json'))));
        const index = fs.readFileSync(path.join(f.worktree, '.git/index')), targetBytes = fs.readFileSync(target);
        const response = f.run(); assert.notEqual(response.status, 0, response.stdout);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
        assert.deepEqual(fs.readFileSync(path.join(f.worktree, '.git/index')), index);
        assert.deepEqual(fs.readFileSync(target), targetBytes);
        assert.deepEqual(fs.readFileSync(path.join(f.proofDirectory, fs.readdirSync(f.proofDirectory).find(file => file.endsWith('.json')))), proofBytes);
        assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: f.head }).covered, false);
      });
    } finally { signing.close(); }
  });
  test('interrupted generation retention and repeated generation keep the last sealed complete output before any apply', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['initial-retain', 'regenerate']) await t.test(phase, bounded, () => {
        const f = divergentFixture(signing);
        let retained;
        if (phase === 'regenerate') {
          assert.equal(f.run(partialApplyInjection(f, 'first-add')).status, 97);
          retained = retainedOperation(f);
        }
        const injection = phase === 'initial-retain'
          ? `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=function(a,b,...rest){if(b.startsWith(${JSON.stringify(f.proofDirectory)})&&b.endsWith('.json')){const p=JSON.parse(fs.readFileSync(a)).payload;if(p.generation&&p.apply)process.exit(98);}return rename.call(this,a,b,...rest);};`
          : `const cp=require('node:child_process'),exec=cp.execFileSync;cp.execFileSync=function(command,args,...rest){const r=exec.call(this,command,args,...rest);if(command===process.execPath&&args[0].includes('/generation-')&&args[0].endsWith('/scripts/package-shipyard-codex.cjs'))process.exit(99);return r;};`;
        const before = retained ? inventory(path.join(f.proofDirectory, retained.id, retained.generation.directory)) : null;
        const response = f.run(injection); assert.equal(response.status, retained ? 99 : 98, response.stderr + response.stdout);
        if (retained) {
          assert.equal(retainedOperation(f).generation.directory, retained.generation.directory);
          assert.deepEqual(inventory(path.join(f.proofDirectory, retained.id, retained.generation.directory)), before);
        } else assert.equal(retainedOperation(f).generation, undefined);
        const result = inspectSuccess(f, f.run());
        if (retained) assert.equal(result.tree, retained.apply.tree);
        assert.equal(git(f.worktree, 'rev-list', '--count', '--merges', `${f.head}..HEAD`), '1');
      });
    } finally { signing.close(); }
  });
  test('protected original proof refuses physical, source, identity, index, base and signer substitutions without adoption', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['proof', 'proof-mode', 'proof-symlink', 'source', 'package-bytes', 'package-mode', 'identity', 'index', 'merge-head', 'auto-merge', 'plan', 'graph', 'base', 'signer']) await t.test(mutation, bounded, () => {
        const f = divergentFixture(signing);
        const injection = "const fs=require('node:fs');const rename=fs.renameSync;fs.renameSync=function(a,b,...rest){const result=rename.call(this,a,b,...rest);if(b.includes('generated-base-merges')&&b.endsWith('.json')&&JSON.parse(fs.readFileSync(b)).payload.phase==='staged')process.exit(94);return result;};";
        assert.notEqual(f.run(injection).status, 0);
        const proof = path.join(f.proofDirectory, fs.readdirSync(f.proofDirectory).find(name => name.endsWith('.json')));
        const original = JSON.parse(fs.readFileSync(proof)).payload, scratch = path.join(f.proofDirectory, original.id, original.generation.directory);
        if (mutation === 'proof') fs.appendFileSync(proof, 'truncated');
        if (mutation === 'proof-mode') fs.chmodSync(proof, 0o644);
        if (mutation === 'proof-symlink') { const moved = proof + '.original'; fs.renameSync(proof, moved); fs.symlinkSync(moved, proof); }
        if (mutation === 'source') fs.appendFileSync(path.join(scratch, 'source', canonical), '\nvoid "foreign";\n');
        if (mutation === 'package-bytes') fs.appendFileSync(path.join(scratch, 'package/host', canonical), '\nvoid "foreign";\n');
        if (mutation === 'package-mode') fs.chmodSync(path.join(scratch, 'package/host', canonical), 0o755);
        if (mutation === 'identity') fs.appendFileSync(path.join(scratch, 'package/package-build.json'), 'x');
        if (mutation === 'index') { fs.appendFileSync(path.join(f.worktree, canonical), '\nvoid "foreign";\n'); git(f.worktree, 'add', canonical); }
        if (mutation === 'merge-head') fs.writeFileSync(path.join(f.worktree, '.git/MERGE_HEAD'), f.head + '\n');
        if (mutation === 'auto-merge') git(f.worktree, 'update-ref', 'AUTO_MERGE', f.headTree);
        if (mutation === 'plan') fs.appendFileSync(path.resolve(f.graphDir, '../PLAN.md'), '\nforeign');
        if (mutation === 'graph') fs.appendFileSync(path.join(f.graphDir, 'tickets.json'), '\n');
        if (mutation === 'base') git(f.worktree, 'update-ref', 'refs/heads/main', f.head);
        if (mutation === 'signer') git(f.worktree, 'config', 'user.signingkey', '0'.repeat(40));
        const r = f.run(); assert.notEqual(r.status, 0, r.stdout); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
        assert.equal(coverage.verify({ worktree: f.worktree, repo: 'fixture/repository', commit: f.head }).covered, false);
      });
    } finally { signing.close(); }
  });
}
module.exports = { divergentFixture, inspectSuccess };

if (require.main === module) test('generated merge process ownership survives age and fences replaced owners', bounded, () => {
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-process-lock-'));
  const modulePath = path.join(scripts, 'lock.cjs');
  const locks = require(modulePath);
  try {
    const handle = locks.acquireGeneratedMergeLock(directory, 'merge');
    const ownerFile = path.join(handle.path, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerFile));
    fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, at: '2000-01-01T00:00:00Z' }));
    const contend = timezone => spawnSync(process.execPath, ['-e',
      'const l=require(process.argv[1]).acquireGeneratedMergeLock(process.argv[2],"merge");if(l){l.release();process.exit(1)}',
      modulePath, directory], { encoding: 'utf8', timeout: 10000, env: { ...process.env, TZ: timezone, LC_ALL: 'C' } });
    for (const timezone of ['Pacific/Honolulu', 'Asia/Tokyo', 'UTC']) {
      const contender = contend(timezone);
      assert.equal(contender.status, 0, contender.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile)), { ...owner, at: '2000-01-01T00:00:00Z' });
    }
    const blocked = spawnSync(process.execPath, ['-e',
      'const l=require(process.argv[1]).acquireGeneratedMergeLock(process.argv[2],"merge");process.exit(l?1:0)',
      modulePath, directory], { encoding: 'utf8', timeout: 10000 });
    assert.equal(blocked.status, 0);
    handle.assertOwned();
    fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, token: 'replacement' }));
    assert.throws(() => handle.assertOwned(), { code: 'LOCK_OWNERSHIP_LOST' });
    fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, generated_process: 'reused PID lifetime' }));
    const replacement = locks.acquireGeneratedMergeLock(directory, 'merge');
    assert.ok(replacement);
    assert.throws(() => handle.assertOwned(), { code: 'LOCK_OWNERSHIP_LOST' });
    replacement.release();
    fs.mkdirSync(path.join(directory, 'merge.lock'));
    fs.writeFileSync(path.join(directory, 'merge.lock/owner.json'), JSON.stringify({
      ...owner, pid: 2147483647, generated_process: 'dead owner' }));
    const recovered = locks.acquireGeneratedMergeLock(directory, 'merge');
    assert.ok(recovered); recovered.release();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
