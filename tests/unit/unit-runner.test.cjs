'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const runner = path.join(__dirname, 'run.sh');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture timed out');
    await pause(25);
  }
}
function fixture(bodies) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-fixture-')));
  for (const dir of ['tests/unit', 'tests/smoke', 'scripts',
    'plugins/delivery-pipeline/scripts', 'capabilities/delivery-pipeline/checks']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'syntax.cjs'), '');
    fs.writeFileSync(path.join(root, dir, 'syntax.sh'), ':\n');
  }
  fs.copyFileSync(runner, path.join(root, 'tests/unit/run.sh'));
  fs.chmodSync(path.join(root, 'tests/unit/run.sh'), 0o755);
  const files = bodies.map((body, i) => {
    const name = `${String(i).padStart(2, '0')}.test.cjs`;
    fs.writeFileSync(path.join(root, 'tests/unit', name), body);
    return `tests/unit/${name}`;
  });
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.mkdirSync(path.join(root, 'tools'));
  if (process.platform === 'darwin') {
    const git = execFileSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(git, path.join(root, 'tools/git'));
  }
  fs.writeFileSync(path.join(root, 'hostile.gitconfig'), [
    '[commit]', ' gpgsign = true', '[tag]', ' gpgsign = true',
    '[gpg]', ' program = /nonexistent-unit-signing-program', '[user]', ' signingkey = hostile', '',
  ].join('\n'));
  return { root, files, dispose() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function launch(f, overrides = {}) {
  const child = spawn('/bin/bash', [path.join(f.root, 'tests/unit/run.sh')], {
    cwd: '/', env: { ...process.env,
      PATH: path.join(f.root, 'tools') + path.delimiter + process.env.PATH,
      GIT_CONFIG_GLOBAL: path.join(f.root, 'hostile.gitconfig'), GIT_CONFIG_NOSYSTEM: '0',
      TMPDIR: path.join(f.root, 'scratch'),
      CLAUDE_PLUGIN_ROOT: 'poison', CLAUDE_CODE_ENTRYPOINT: 'poison',
      CODEX_SANDBOX: 'poison', CODEX_SANDBOX_NETWORK_DISABLED: 'poison', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', bytes => chunks.push(bytes));
  child.stderr.on('data', bytes => chunks.push(bytes));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output: Buffer.concat(chunks).toString() }));
  });
  return { child, done };
}
const prelude = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.cwd(),id=path.basename(__filename),events=path.join(root,'events');
const event=kind=>fs.appendFileSync(events,JSON.stringify({kind,id,pid:process.pid,ppid:process.ppid})+'\\n');
event('start');
`;
const events = f => fs.existsSync(path.join(f.root, 'events'))
  ? fs.readFileSync(path.join(f.root, 'events'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

for (const failing of [false, true]) {
  test(`four direct workers, queued discovery, full ordered output and ${failing ? 'aggregate failure' : 'success'}`,
    { timeout: 30000 }, async () => {
      const f = fixture(Array.from({ length: 7 }, (_, i) => prelude + `
let checks=0;const check=(actual,expected)=>{assert.equal(actual,expected);checks++;};
for(const key of ['CLAUDE_PLUGIN_ROOT','CLAUDE_CODE_ENTRYPOINT','CODEX_SANDBOX','CODEX_SANDBOX_NETWORK_DISABLED'])check(process.env[key],undefined);
const keys=['HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','TMPDIR','TMP','TEMP','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR'];
for(const key of keys){const dir=process.env[key];check(dir.startsWith(root+'/scratch/'),true);fs.writeFileSync(path.join(dir,'owned'),id);}
const {execFileSync}=require('node:child_process');
for(const [key,value] of Object.entries({'user.name':'Shipyard Unit Tests','user.email':'unit-tests@shipyard.invalid','commit.gpgsign':'false','tag.gpgsign':'false','init.defaultBranch':'main'}))check(execFileSync('git',['config','--global','--get',key],{encoding:'utf8'}).trim(),value);
check(process.env.GIT_CONFIG_NOSYSTEM,'1');
const repo=path.join(process.env.TMPDIR,'repo');fs.mkdirSync(repo);
const git=args=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
git(['init','-q']);assert.equal(git(['symbolic-ref','--short','HEAD']),'main');
fs.writeFileSync(path.join(repo,'file'),'worker '+id);git(['add','file']);git(['commit','-qm','unsigned worker']);
assert.equal(git(['log','-1','--format=%an <%ae>']),'Shipyard Unit Tests <unit-tests@shipyard.invalid>');
git(['tag','-am','unsigned tag','probe']);assert.equal(git(['cat-file','-t','probe']),'tag');
assert.ok(!git(['cat-file','-p','probe']).includes('BEGIN PGP SIGNATURE'));
assert.ok(!git(['cat-file','-p','HEAD']).includes('gpgsig'));
fs.writeFileSync(path.join(root,id+'.resources'),JSON.stringify([...keys.map(key=>process.env[key]),process.env.GIT_CONFIG_GLOBAL]));
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release'))){clearInterval(timer);console.log('BEGIN '+id);process.stdout.write('O'.repeat(1100000)+'\\n');process.stderr.write('E'.repeat(1100000)+'\\n');console.log(checks+' passed, 0 failed');console.log('END '+id);event('end');process.exitCode=${failing && i === 2 ? 1 : 0};}},25);
`));
      const run = launch(f);
      try {
        await until(() => events(f).length === 4);
        await pause(150);
        assert.equal(events(f).length, 4, 'fifth stays queued');
        assert.equal(new Set(events(f).map(e => e.pid)).size, 4);
        assert.deepEqual(new Set(events(f).map(e => e.ppid)), new Set([run.child.pid]), 'direct Node children');
        fs.writeFileSync(path.join(f.root, 'tests/unit/99-late.test.cjs'), "throw Error('discovery was mutable');");
        fs.writeFileSync(path.join(f.root, 'release'), 'go');
        const result = await run.done;
        assert.equal(result.code, failing ? 1 : 0, result.output.slice(-2000));
        let active = 0, maximum = 0;
        for (const e of events(f)) { active += e.kind === 'start' ? 1 : -1; maximum = Math.max(maximum, active); }
        assert.equal(maximum, 4); assert.equal(active, 0);
        assert.deepEqual(events(f).filter(e => e.kind === 'start').map(e => e.id).sort(), f.files.map(file => path.basename(file)));
        const resources = f.files.map(file => JSON.parse(fs.readFileSync(path.join(f.root, path.basename(file)+'.resources'))));
        for (let i = 0; i < resources[0].length; i++) assert.equal(new Set(resources.map(row => row[i])).size, 7);
        let offset = -1;
        for (const file of f.files) {
          const id = path.basename(file);
          const index = result.output.indexOf('═══ '+file);
          assert.ok(index > offset); offset = index;
          assert.ok(result.output.includes('BEGIN '+id+'\n'+'O'.repeat(1100000)+'\n'+'E'.repeat(1100000)+'\n21 passed, 0 failed\nEND '+id));
        }
        assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
      } finally { run.child.kill('SIGTERM'); await run.done; f.dispose(); }
    });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} cleans workers and their real children before deleting resources`, { timeout: 30000 }, async () => {
    const f = fixture(Array.from({ length: 6 }, () => prelude + `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',\`const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[2],String(fs.existsSync(process.env.TMPDIR)));process.exit(0)});setInterval(()=>{},100);\`,path.join(root,id+'.child'),path.join(root,id+'.ended')],{stdio:'ignore'});
process.on('SIGTERM',()=>{child.kill('SIGTERM');child.once('exit',()=>process.exit(0));});
setInterval(()=>{},100);
`));
    const run = launch(f);
    try {
      await until(() => f.files.slice(0, 4).every(file => fs.existsSync(path.join(f.root, path.basename(file)+'.child'))));
      await pause(100);
      run.child.kill(signal);
      const result = await run.done;
      assert.equal(result.code, signal === 'SIGTERM' ? 143 : 130);
      assert.equal(events(f).filter(e => e.kind === 'start').length, 4);
      for (const file of f.files.slice(0, 4)) {
        const pid = Number(fs.readFileSync(path.join(f.root, path.basename(file)+'.child')));
        await until(() => { try { process.kill(pid, 0); return false; } catch (error) { if(error.code==='ESRCH')return true; throw error; } });
        assert.equal(fs.readFileSync(path.join(f.root, path.basename(file)+'.ended'), 'utf8'), 'true');
        assert.ok(result.output.includes('═══ '+file));
      }
      assert.deepEqual(fs.readdirSync(path.join(f.root, 'scratch')), []);
    } finally { run.child.kill('SIGTERM'); await run.done; f.dispose(); }
  });
}

test('original syntax checks reject malformed inputs before file launch and mode stays executable', async () => {
  assert.equal(fs.statSync(runner).mode & 0o777, 0o755);
  for (const [file, body] of [
    ...['scripts', 'plugins/delivery-pipeline/scripts', 'capabilities/delivery-pipeline/checks'].map(dir => [dir+'/syntax.cjs', 'const = ;']),
    ...['scripts', 'plugins/delivery-pipeline/scripts', 'tests/smoke', 'tests/unit'].map(dir => [dir+'/syntax.sh', 'if then']),
  ]) {
    const f = fixture([prelude]);
    try {
      fs.writeFileSync(path.join(f.root, file), body);
      const result = await launch(f).done;
      assert.equal(result.code, 1);
      assert.ok(result.output.includes('syntax error in '+file));
      assert.deepEqual(events(f), []);
    } finally { f.dispose(); }
  }
});


test('missing Node fails before discovery launch', async () => {
  const f = fixture([prelude]);
  try {
    const bin = path.join(f.root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
    const result = await launch(f, { PATH: bin }).done;
    assert.equal(result.code, 1);
    assert.ok(result.output.includes('node not found on PATH'));
    assert.deepEqual(events(f), []);
  } finally { f.dispose(); }
});
