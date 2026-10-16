'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-authority-race-')));
const originalHomedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });

const { suite, test: runTest, done, assert } = require('./assert-harness.cjs');
const ROLE_ARTIFACT = path.join(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const roleArtifact = require(ROLE_ARTIFACT);

let pendingCase = Promise.resolve();
function test(name, callback) {
  runTest(name, () => {
    const current = pendingCase.then(callback);
    pendingCase = current.catch(() => {});
    return current;
  });
}

function loadSeam(file) {
  const Module = require('node:module');
  const fs = require('node:fs');
  const path = require('node:path');
  const seamModule = new Module(file, module);
  seamModule.filename = file;
  seamModule.paths = Module._nodeModulePaths(path.dirname(file));
  const source = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '\n')
    + '\nmodule.exports = Object.freeze({ ...module.exports, __seam: '
    + '{ authorityState, withArchiveAuthorityLock, writeArchiveCatalogue } });\n';
  seamModule._compile(source, file);
  return seamModule.exports;
}

const childFile = path.join(home, 'race-child.cjs');
fs.writeFileSync(childFile, `'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
os.homedir = () => process.env.TEST_HOME;
const loadSeam = ${loadSeam.toString()};
const exported = loadSeam(process.env.ROLE_ARTIFACT);
const seam = exported.__seam;
const [scenario, worktree, barrier, ready] = process.argv.slice(2);
const authorityDirectory = () => exported.archiveAuthorityDirectory(worktree, true);
const keyFile = () => path.join(authorityDirectory(), 'hmac.key');
const named = (file, name) => typeof file === 'string' && path.basename(file) === name;
const isTemporary = file => typeof file === 'string' && /^hmac\\.key\\..+\\.tmp$/.test(path.basename(file));
const writing = flags => typeof flags === 'string' ? /[wa+]/.test(flags)
  : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
const wrap = (name, make) => { const original = fs[name]; fs[name] = make(original); return () => { fs[name] = original; }; };
const attempt = fn => { try { return { value: fn() }; } catch (error) { return { threw: { code: error.code, message: error.message } }; } };
const seed = () => seam.withArchiveAuthorityLock(worktree, () => seam.writeArchiveCatalogue(seam.authorityState(worktree, true)));
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function disturbOnOpen(target, limit, disturb) {
  const counts = { opens: 0, disturbed: 0 };
  const restore = wrap('openSync', original => function (file, flags, ...rest) {
    if (named(file, target)) {
      counts.opens++;
      if (counts.disturbed < limit) { counts.disturbed++; disturb(file, counts.disturbed); }
    }
    return original.call(this, file, flags, ...rest);
  });
  return { counts, restore };
}
const replaceFile = file => {
  const copy = file + '.copy';
  fs.copyFileSync(file, copy);
  fs.chmodSync(copy, 0o600);
  fs.renameSync(copy, file);
};
const touchFile = (file, round) => { const when = new Date(1700000000000 + round * 5000); fs.utimesSync(file, when, when); };

const scenarios = {
  'key-spy'() {
    const violations = [], temporaries = [], links = [];
    const restores = [
      wrap('writeFileSync', original => function (file, ...rest) {
        if (named(file, 'hmac.key')) violations.push('writeFileSync');
        if (isTemporary(file)) temporaries.push('writeFileSync');
        return original.call(this, file, ...rest);
      }),
      wrap('openSync', original => function (file, flags, ...rest) {
        if (named(file, 'hmac.key') && writing(flags)) violations.push('openSync');
        if (isTemporary(file) && writing(flags)) temporaries.push('openSync');
        return original.call(this, file, flags, ...rest);
      }),
      wrap('renameSync', original => function (from, to) {
        if (named(from, 'hmac.key') || named(to, 'hmac.key')) violations.push('renameSync');
        return original.call(this, from, to);
      }),
      wrap('copyFileSync', original => function (from, to, ...rest) {
        if (named(to, 'hmac.key')) violations.push('copyFileSync');
        return original.call(this, from, to, ...rest);
      }),
      wrap('linkSync', original => function (from, to) {
        if (named(to, 'hmac.key')) links.push(path.basename(String(from)));
        return original.call(this, from, to);
      }),
    ];
    let key;
    try { key = seam.authorityState(worktree, true).key; } finally { restores.forEach(restore => restore()); }
    const stat = fs.statSync(keyFile());
    return { violations, temporaries, links, keyBytes: stat.size, keyMode: stat.mode & 0o777,
      returned: key.toString('hex'), onDisk: fs.readFileSync(keyFile()).toString('hex'),
      leftovers: fs.readdirSync(authorityDirectory()).filter(name => /^hmac\\.key\\..+\\.tmp$/.test(name)) };
  },
  'lost-link-race'() {
    const competitor = crypto.randomBytes(32);
    let raced = 0;
    const restore = wrap('linkSync', original => function (from, to) {
      if (named(to, 'hmac.key') && !raced++) {
        const rival = path.join(path.dirname(to), 'rival-key.tmp');
        fs.writeFileSync(rival, competitor, { mode: 0o600 });
        original.call(this, rival, to);
        fs.unlinkSync(rival);
      }
      return original.call(this, from, to);
    });
    let result;
    try { result = attempt(() => seam.authorityState(worktree, true).key); } finally { restore(); }
    return { raced, threw: result.threw, matches: !!result.value && Buffer.compare(result.value, competitor) === 0,
      leftovers: fs.readdirSync(authorityDirectory()).filter(name => name.endsWith('.tmp')) };
  },
  'catalogue-transient'() {
    seed();
    const probe = disturbOnOpen('catalogue.json', 1, replaceFile);
    let result;
    try { result = attempt(() => exported.historicalBookkeepingPins(worktree)); } finally { probe.restore(); }
    return { ...result, ...probe.counts };
  },
  'catalogue-persistent'() {
    seed();
    const probe = disturbOnOpen('catalogue.json', Infinity, replaceFile);
    let result;
    try { result = attempt(() => exported.historicalBookkeepingPins(worktree)); } finally { probe.restore(); }
    return { ...result, ...probe.counts };
  },
  'catalogue-bad-mac'() {
    seed();
    const file = path.join(authorityDirectory(), 'catalogue.json');
    const envelope = JSON.parse(fs.readFileSync(file));
    envelope.mac = (envelope.mac[0] === '0' ? '1' : '0') + envelope.mac.slice(1);
    fs.writeFileSync(file, JSON.stringify(envelope) + '\\n');
    const probe = disturbOnOpen('catalogue.json', 0, () => {});
    let result;
    try { result = attempt(() => exported.historicalBookkeepingPins(worktree)); } finally { probe.restore(); }
    return { ...result, ...probe.counts };
  },
  'key-mtime-once'() {
    const key = seam.authorityState(worktree, true).key;
    const probe = disturbOnOpen('hmac.key', 1, touchFile);
    let result;
    try { result = attempt(() => seam.authorityState(worktree, false, false, false).key); } finally { probe.restore(); }
    return { threw: result.threw, opens: probe.counts.opens,
      matches: !!result.value && Buffer.compare(result.value, key) === 0 };
  },
  'key-mtime-persistent'() {
    seam.authorityState(worktree, true);
    const probe = disturbOnOpen('hmac.key', Infinity, touchFile);
    let result;
    try { result = attempt(() => seam.authorityState(worktree, false, false, false).key); } finally { probe.restore(); }
    return { threw: result.threw, opens: probe.counts.opens };
  },
  'key-short'() {
    const directory = authorityDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile(), crypto.randomBytes(31), { mode: 0o600 });
    const probe = disturbOnOpen('hmac.key', 0, () => {});
    let result;
    try { result = attempt(() => seam.authorityState(worktree, false, false, false).key); } finally { probe.restore(); }
    return { threw: result.threw, opens: probe.counts.opens };
  },
  'key-oversize'() {
    const directory = authorityDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile(), crypto.randomBytes(33), { mode: 0o600 });
    let lstats = 0;
    const restoreLstat = wrap('lstatSync', original => function (file, ...rest) {
      if (named(file, 'hmac.key')) lstats++;
      return original.call(this, file, ...rest);
    });
    const probe = disturbOnOpen('hmac.key', 0, () => {});
    let result;
    try { result = attempt(() => seam.authorityState(worktree, false, false, false).key); }
    finally { probe.restore(); restoreLstat(); }
    return { threw: result.threw, opens: probe.counts.opens, lstats };
  },
  'key-link-then-unlink'() {
    const directory = authorityDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = crypto.randomBytes(32);
    const temporary = path.join(directory, 'hmac.key.99999.staging.tmp');
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.linkSync(temporary, keyFile());
    const probe = disturbOnOpen('hmac.key', 1, () => fs.unlinkSync(temporary));
    let result;
    try { result = attempt(() => seam.authorityState(worktree, false, false, false).key); } finally { probe.restore(); }
    return { threw: result.threw, opens: probe.counts.opens, staged: fs.existsSync(temporary),
      matches: !!result.value && Buffer.compare(result.value, bytes) === 0 };
  },
  'stress'() {
    fs.writeFileSync(ready, '');
    while (!fs.existsSync(barrier)) sleep(1);
    return { key: seam.authorityState(worktree, true).key.toString('hex') };
  },
};

try { process.stdout.write(JSON.stringify({ ok: true, ...scenarios[scenario]() }) + '\\n'); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }) + '\\n'); }
`);

function spawnChild(scenario, worktree, extra = []) {
  const child = spawn(process.execPath, [childFile, scenario, worktree, ...extra], {
    env: { ...process.env, TEST_HOME: home, ROLE_ARTIFACT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finished = new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); }
      catch { reject(new Error('child exited ' + code + ': ' + stdout + stderr)); }
    });
  });
  return finished;
}

async function scenario(name) {
  const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-race-' + name + '-')));
  try {
    const result = await spawnChild(name, worktree);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

suite('archive authority — atomic key creation and stable unlocked reads');

test('the key is never written in place: one complete private link, no temporary left', async () => {
  const result = await scenario('key-spy');
  assert.deepEqual(result.violations, []);
  assert.ok(result.temporaries.length > 0, 'the key bytes were staged under a private temporary name');
  assert.equal(result.links.length, 1);
  assert.match(result.links[0], /^hmac\.key\..+\.tmp$/);
  assert.equal(result.keyBytes, 32);
  assert.equal(result.keyMode & 0o077, 0);
  assert.equal(result.returned, result.onDisk);
  assert.deepEqual(result.leftovers, []);
});

test('a creator that loses the link race returns the competitor key and leaves no temporary', async () => {
  const result = await scenario('lost-link-race');
  assert.equal(result.raced, 1, 'the competing key was linked first');
  assert.equal(result.threw, undefined, JSON.stringify(result.threw));
  assert.equal(result.matches, true);
  assert.deepEqual(result.leftovers, []);
});

test('a catalogue replaced between lstat and open is read after one retry', async () => {
  const result = await scenario('catalogue-transient');
  assert.equal(result.threw, undefined, JSON.stringify(result.threw));
  assert.deepEqual(result.value, []);
  assert.equal(result.opens, 2);
});

test('a catalogue replaced on every attempt is refused after exactly 5 attempts with the original message', async () => {
  const result = await scenario('catalogue-persistent');
  assert.equal(result.opens, 5);
  assert.equal(result.threw?.code, 'ARCHIVE_AUTHORITY_INVALID');
  assert.equal(result.threw?.message, 'archive authority changed before bounded reading');
});

test('a catalogue with a bad MAC is refused on the first attempt without retry', async () => {
  const result = await scenario('catalogue-bad-mac');
  assert.equal(result.opens, 1);
  assert.equal(result.threw?.code, 'ARCHIVE_AUTHORITY_INVALID');
  assert.equal(result.threw?.message, 'archive catalogue authentication failed');
});

test('a key whose stat changes once between lstat and open is read after one retry', async () => {
  const result = await scenario('key-mtime-once');
  assert.equal(result.threw, undefined, JSON.stringify(result.threw));
  assert.equal(result.matches, true);
  assert.equal(result.opens, 2);
});

test('a key whose stat changes on every attempt is refused after exactly 5 attempts with the original message', async () => {
  const result = await scenario('key-mtime-persistent');
  assert.equal(result.opens, 5);
  assert.equal(result.threw?.code, 'ARCHIVE_AUTHORITY_INVALID');
  assert.equal(result.threw?.message, 'archive authority changed before bounded reading');
});

test('a 31-byte key is refused at once as malformed without retry', async () => {
  const result = await scenario('key-short');
  assert.equal(result.opens, 1);
  assert.equal(result.threw?.code, 'ARCHIVE_AUTHORITY_INVALID');
  assert.equal(result.threw?.message, 'archive authority key is malformed');
});

test('an oversize key is refused at once by the bounded-file check without retry', async () => {
  const result = await scenario('key-oversize');
  assert.equal(result.opens, 0);
  assert.equal(result.lstats, 1);
  assert.equal(result.threw?.code, 'ARCHIVE_AUTHORITY_INVALID');
  assert.match(result.threw?.message, /private bounded regular file/);
});

test('a key read that straddles the creator unlinking its temporary name still succeeds', async () => {
  const result = await scenario('key-link-then-unlink');
  assert.equal(result.threw, undefined, JSON.stringify(result.threw));
  assert.equal(result.matches, true);
  assert.equal(result.staged, false);
});

test('concurrent first admission of fresh worktrees yields one key and no refusal', async () => {
  const rounds = 10, sessions = 6;
  for (let round = 0; round < rounds; round++) {
    const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-race-stress-')));
    const barrier = path.join(home, 'barrier-' + round);
    try {
      const readyFiles = Array.from({ length: sessions }, (_, index) => path.join(home, 'ready-' + round + '-' + index));
      const children = readyFiles.map(ready => spawnChild('stress', worktree, [barrier, ready]));
      const deadline = Date.now() + 30000;
      while (readyFiles.some(file => !fs.existsSync(file))) {
        assert.ok(Date.now() < deadline, 'every session reached the barrier');
        await sleepMs(5);
      }
      fs.writeFileSync(barrier, '');
      const results = await Promise.all(children);
      for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(new Set(results.map(result => result.key)).size, 1, 'one key for every session');
      assert.match(results[0].key, /^[a-f0-9]{64}$/);
      const directory = roleArtifact.archiveAuthorityDirectory(worktree);
      assert.equal(fs.readFileSync(path.join(directory, 'hmac.key')).toString('hex'), results[0].key);
      assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
    } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
  }
});

done();
