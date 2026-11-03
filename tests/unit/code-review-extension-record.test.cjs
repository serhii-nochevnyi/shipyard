'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const realHomedir = os.homedir;
const realState = path.join(fs.realpathSync(realHomedir()), '.local/state/shipyard/code-review-publications');
const usedNamespaces = new Set();
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-extension-')));
let current = path.join(base, 'unset-home');
os.homedir = () => current;
process.on('exit', () => { os.homedir = realHomedir; fs.rmSync(base, { recursive: true, force: true }); });
const script = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
const flow = require(script);

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), REPOSITORY = '/repo/identity';
const record = (overrides = {}) => ({ head: HEAD, base_commit: BASE, operator: 'Ada Lovelace',
  created_at: '2026-11-02T10:00:00.000Z', reason: 'Fresh evidence needs one more pass', ...overrides });
const headN = index => String(index).padStart(40, '0');
let counter = 0;

function fixture({ homeInsideWorktree = false, repository = REPOSITORY, repo = null, pr = 52 } = {}) {
  const root = path.join(base, `case-${++counter}`);
  const worktree = path.join(root, 'worktree'), planning = path.join(root, 'planning');
  fs.mkdirSync(path.join(planning, '.planning'), { recursive: true }); fs.mkdirSync(worktree, { recursive: true });
  const home = homeInsideWorktree ? path.join(worktree, 'home') : path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  current = home;
  const state = path.join(home, '.local/state/shipyard/code-review-publications');
  const directory = path.join(state, crypto.createHash('sha256')
    .update(JSON.stringify([repository, repo === null ? null : repo.trim().toLowerCase()])).digest('hex'));
  usedNamespaces.add(path.basename(directory));
  return { root, home, worktree, planning, state, directory, file: path.join(directory, `${pr}.extensions.json`),
    config: path.join(planning, '.planning/config.json'),
    input: { repository, repo, pr, roots: [worktree, planning] },
    ctx: { repository, repo, pr, worktree, mode: { project_root: planning } } };
}
const seeded = options => { const f = fixture(options); flow.appendExtension(f.ctx, record()); return f; };
const stored = f => JSON.parse(fs.readFileSync(f.file, 'utf8'));
const put = (f, data) => fs.writeFileSync(f.file, JSON.stringify(data));

function snapshot(root) {
  const entries = [];
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file);
    entries.push({ path: relative, mode: stat.mode & 0o7777, uid: stat.uid,
      type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file',
      content: stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file, 'hex') : null });
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
  };
  walk(root, '.');
  return entries;
}

function stubbed(patches, run) {
  const saved = Object.fromEntries(Object.keys(patches).map(name => [name, fs[name]]));
  Object.assign(fs, patches);
  try { return run(); } finally { Object.assign(fs, saved); }
}
const { lstatSync: realLstat, openSync: realOpen, closeSync: realClose } = fs;
const asOwnedBy = (target, run) => stubbed({ lstatSync(name, ...args) {
  const stat = realLstat.call(this, name, ...args);
  if (name === target) stat.uid += 1;
  return stat;
} }, run);

const noMkdir = run => {
  const original = fs.mkdirSync;
  let calls = 0;
  const result = stubbed({ mkdirSync(...args) { calls++; return original.apply(this, args); } }, run);
  assert.equal(calls, 0, 'the read path must never call mkdir');
  return result;
};

test('the test home, worktree and state resolve inside the test temp directory, not the real state', () => {
  const f = fixture();
  assert.notEqual(realHomedir(), os.homedir());
  assert(inside(fs.realpathSync(os.tmpdir()), base));
  for (const dir of [os.homedir(), f.home, f.worktree, f.planning, f.directory, f.file]) assert(inside(base, dir), dir);
  assert(!inside(path.dirname(realState), f.file));
});

test('appendExtension creates a private store outside the worktree and readExtensions returns it unchanged', () => {
  const f = fixture();
  assert.deepEqual(flow.appendExtension(f.ctx, record()), record());
  assert(!inside(f.worktree, f.file)); assert(!inside(f.planning, f.file));
  assert.equal(fs.lstatSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(f.state).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.directory), ['52.extensions.json']);
  assert.deepEqual(flow.readExtensions(f.input), [record()]);
  const file = stored(f);
  assert.deepEqual(Object.keys(file).sort(), ['pr', 'records', 'repository', 'schema', 'selector']);
  assert.deepEqual({ schema: file.schema, repository: file.repository, selector: file.selector, pr: file.pr },
    { schema: 'shipyard.code-review-extension.v1', repository: REPOSITORY, selector: null, pr: 52 });
});

test('readExtensions creates nothing: never-used PR, partial chain, absent file and missing home all read empty', () => {
  const f = fixture();
  let before = snapshot(f.home);
  assert.deepEqual(noMkdir(() => flow.readExtensions(f.input)), []);
  assert.equal(fs.existsSync(path.join(f.home, '.local')), false);
  assert.deepEqual(snapshot(f.home), before);
  fs.mkdirSync(path.join(f.home, '.local'), { mode: 0o700 });
  before = snapshot(f.home);
  assert.deepEqual(noMkdir(() => flow.readExtensions(f.input)), []);
  assert.equal(fs.existsSync(path.join(f.home, '.local/state/shipyard')), false);
  fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  before = snapshot(f.home);
  assert.deepEqual(noMkdir(() => flow.readExtensions(f.input)), []);
  assert.deepEqual(snapshot(f.home), before);
  current = path.join(base, 'no-such-home');
  assert.deepEqual(flow.readExtensions(f.input), []);
});

test('the selector is normalized like the publication namespace and each PR has its own file', () => {
  const f = fixture({ repo: ' Owner/Repo ' });
  flow.appendExtension(f.ctx, record());
  assert.equal(stored(f).selector, 'owner/repo');
  assert.deepEqual(flow.readExtensions({ ...f.input, repo: 'owner/repo' }), [record()]);
  assert.deepEqual(flow.readExtensions({ ...f.input, repo: null }), []);
  assert.deepEqual(flow.readExtensions({ ...f.input, pr: 53 }), []);
});

// @contract: one table serves the read validator and the append validator.
const badRecords = {
  'short head': { head: 'a'.repeat(39) }, 'upper head': { head: 'A'.repeat(40) }, 'bad base': { base_commit: 'xyz' },
  'time without millis': { created_at: '2026-11-02T10:00:00Z' },
  'time with offset': { created_at: '2026-11-02T10:00:00.000+01:00' },
  'impossible time': { created_at: '2026-02-31T10:00:00.000Z' },
  'empty reason': { reason: '' }, 'long reason': { reason: 'é'.repeat(101) },
  'newline reason': { reason: 'two\nlines' }, 'delete reason': { reason: 'a\u007fb' },
  'empty operator': { operator: '' }, 'long operator': { operator: 'é'.repeat(65) },
  'control operator': { operator: 'Ada\u0007' },
};

for (const [label, overrides] of Object.entries(badRecords)) {
  test('an invalid record is refused by both paths and append creates nothing: ' + label, () => {
    const f = seeded();
    put(f, { ...stored(f), records: [record(overrides)] });
    assert.throws(() => flow.readExtensions(f.input), /extension record identity or schema mismatch/);
    const g = fixture();
    assert.throws(() => flow.appendExtension(g.ctx, record(overrides)), /extension record is invalid/);
    assert.equal(fs.existsSync(path.join(g.home, '.local')), false);
  });
}

const fileMutations = {
  'json': f => fs.writeFileSync(f.file, '{'), 'array': f => fs.writeFileSync(f.file, '[]'),
  'scalar': f => fs.writeFileSync(f.file, '7'),
  'schema': f => put(f, { ...stored(f), schema: 'shipyard.code-review-publication.v1' }),
  'repository': f => put(f, { ...stored(f), repository: '/wrong/repository' }),
  'selector': f => put(f, { ...stored(f), selector: 'other/repo' }),
  'pr': f => put(f, { ...stored(f), pr: 53 }),
  'extra-key': f => put(f, { ...stored(f), comment_id: 7 }),
  'missing-key': f => { const { selector, ...rest } = stored(f); put(f, rest); },
  'records-not-array': f => put(f, { ...stored(f), records: {} }),
  'record-extra-key': f => put(f, { ...stored(f), records: [{ ...record(), id: 1 }] }),
  'too-many-records': f => put(f, { ...stored(f), records: Array.from({ length: 17 }, (_, i) => record({ head: headN(i) })) }),
  'duplicate-records': f => put(f, { ...stored(f), records: [record(), record()] }),
  'mode': f => fs.chmodSync(f.file, 0o644),
  'oversize': f => put(f, { ...stored(f), padding: ' '.repeat(9000) }),
  'oversize-valid-json': f => fs.writeFileSync(f.file, JSON.stringify(stored(f)) + ' '.repeat(9000)),
  'directory': f => { fs.unlinkSync(f.file); fs.mkdirSync(f.file); fs.chmodSync(f.file, 0o600); },
  'fifo': f => { fs.unlinkSync(f.file); execFileSync('mkfifo', [f.file]); fs.chmodSync(f.file, 0o600); },
  'symlink': f => { fs.renameSync(f.file, f.file + '.saved'); fs.symlinkSync(f.file + '.saved', f.file); },
  'hard-link': f => fs.linkSync(f.file, f.file + '.link'),
};

const fileSafety = new Set(['mode', 'oversize', 'oversize-valid-json', 'directory', 'fifo', 'symlink', 'hard-link']);
for (const [mutation, mutate] of Object.entries(fileMutations)) {
  test('unsafe or invalid extension file makes readExtensions throw: ' + mutation, () => {
    const f = seeded();
    mutate(f);
    const before = snapshot(f.home);
    assert.throws(() => flow.readExtensions(f.input),
      fileSafety.has(mutation) ? /unsafe extension record/ : Error);
    assert.deepEqual(snapshot(f.home), before);
  });
}

test('a FIFO swapped in between lstat and open cannot hang the read', () => {
  const f = seeded();
  const good = path.join(f.directory, 'good');
  fs.copyFileSync(f.file, good); fs.chmodSync(good, 0o600);
  fs.unlinkSync(f.file); execFileSync('mkfifo', [f.file]); fs.chmodSync(f.file, 0o600);
  const code = `const fs = require('node:fs'); const [script, input, file, good] = process.argv.slice(1);
    const lstat = fs.lstatSync;
    fs.lstatSync = (name, ...args) => lstat(name === file ? good : name, ...args);
    try { require(script).readExtensions(JSON.parse(input)); process.exit(1); } catch (error) { process.stdout.write(error.message); }`;
  const child = spawnSync(process.execPath, ['-e', code, script, JSON.stringify(f.input), f.file, good],
    { env: { ...process.env, HOME: f.home }, timeout: 10000 });
  assert.equal(child.status, 0, 'the read must refuse the swapped FIFO instead of blocking in open');
  assert.match(String(child.stdout), /extension record changed/);
});

test('a file owned by another uid and an unreadable file make readExtensions throw', () => {
  const f = seeded();
  assert.throws(() => asOwnedBy(f.file, () => flow.readExtensions(f.input)), /unsafe extension record/);
  assert.throws(() => stubbed({ openSync(name, ...args) {
    if (name === f.file) throw Object.assign(new Error('unreadable state'), { code: 'EACCES' });
    return realOpen.call(this, name, ...args);
  } }, () => flow.readExtensions(f.input)), /unreadable state/);
});

for (const mode of [0o755, 0o770]) {
  for (const [label, target] of [['publications directory', f => f.state], ['hashed directory', f => f.directory]]) {
    test(`namespace-mode: ${label} at ${mode.toString(8)} makes readExtensions throw without creating anything`, () => {
      const f = seeded();
      fs.chmodSync(target(f), mode);
      const before = snapshot(f.home);
      assert.throws(() => noMkdir(() => flow.readExtensions(f.input)), /unsafe publication namespace/);
      assert.deepEqual(snapshot(f.home), before);
    });
  }
}

for (const replaced of ['.local/state', '.local/state/shipyard']) {
  test(`ancestor-symlink: ${replaced} replaced by a symlink to a real store makes readExtensions throw`, () => {
    const f = seeded();
    const ancestor = path.join(f.home, replaced);
    fs.renameSync(ancestor, ancestor + '.real'); fs.symlinkSync(ancestor + '.real', ancestor);
    assert.deepEqual(fs.readdirSync(f.directory.replace(ancestor, ancestor + '.real')), ['52.extensions.json']);
    const before = snapshot(f.home);
    assert.throws(() => noMkdir(() => flow.readExtensions(f.input)), /unsafe publication namespace/);
    assert.deepEqual(snapshot(f.home), before);
  });
}

test('a group-writable or foreign-owned home or ancestor directory makes readExtensions throw', () => {
  const f = seeded();
  fs.chmodSync(path.join(f.home, '.local'), 0o775);
  assert.throws(() => flow.readExtensions(f.input), /unsafe publication namespace/);
  fs.chmodSync(path.join(f.home, '.local'), 0o700);
  assert.throws(() => asOwnedBy(f.home, () => flow.readExtensions(f.input)), /unsafe publication home/);
  assert.throws(() => asOwnedBy(path.join(f.home, '.local/state'), () => flow.readExtensions(f.input)), /unsafe publication namespace/);
});

test('a state directory inside the worktree or planning checkout is refused by both paths', () => {
  const f = fixture({ homeInsideWorktree: true });
  const before = snapshot(f.home);
  assert.throws(() => flow.readExtensions(f.input), /inside a source or planning checkout/);
  assert.throws(() => flow.appendExtension(f.ctx, record()), /inside a source or planning checkout/);
  assert.deepEqual(snapshot(f.home), before);
});

test('roots are required and unusable input fails with a clear error, not a TypeError', () => {
  const f = fixture();
  const { roots, ...withoutRoots } = f.input;
  for (const input of [withoutRoots, { ...f.input, roots: [] }, { ...f.input, roots: [null] }])
    assert.throws(() => flow.readExtensions(input), /checkout roots are required/);
  assert.throws(() => flow.readExtensions({ ...f.input, repository: undefined }), /repository identity is required/);
  assert.throws(() => flow.readExtensions(undefined), /pull request number is required/);
  for (const pr of [0, -1, 1.5, '52', '../52', null, undefined]) {
    assert.throws(() => flow.readExtensions({ ...f.input, pr }), /pull request number is required/);
    assert.throws(() => flow.appendExtension({ ...f.ctx, pr }, record()), /pull request number is required/);
  }
  assert.throws(() => flow.appendExtension({ ...f.ctx, mode: undefined }, record()), /code review mode is required/);
  assert.throws(() => flow.appendExtension(f.ctx, { ...record(), id: 1 }), /extension record is invalid/);
  assert.throws(() => flow.appendExtension(f.ctx, null), /extension record is invalid/);
  assert.equal(fs.existsSync(path.join(f.home, '.local')), false);
  const absent = { ...f.input }; delete absent.repo;
  assert.deepEqual(flow.readExtensions(absent), []);
});

test('appending the same head and base twice stores one record and returns the existing one', () => {
  const f = fixture();
  const first = flow.appendExtension(f.ctx, record());
  const bytes = fs.readFileSync(f.file, 'hex');
  const again = flow.appendExtension(f.ctx, record({ operator: 'Someone Else', created_at: '2026-11-02T11:00:00.000Z', reason: 'second' }));
  assert.deepEqual(again, first);
  assert.equal(fs.readFileSync(f.file, 'hex'), bytes);
  flow.appendExtension(f.ctx, record({ head: 'c'.repeat(40) }));
  flow.appendExtension(f.ctx, record({ base_commit: 'd'.repeat(40) }));
  assert.equal(flow.readExtensions(f.input).length, 3);
  assert.deepEqual(fs.readdirSync(f.directory), ['52.extensions.json']);
});

test('the store is bounded by count: a seventeenth distinct record is refused', () => {
  const f = fixture();
  for (let index = 1; index <= 16; index++) flow.appendExtension(f.ctx, record({ head: headN(index) }));
  const bytes = fs.readFileSync(f.file, 'hex');
  assert.throws(() => flow.appendExtension(f.ctx, record({ head: headN(17) })), /limit/);
  assert.equal(fs.readFileSync(f.file, 'hex'), bytes);
  assert.equal(flow.appendExtension(f.ctx, record({ head: headN(1) })).head, headN(1));
});

test('the store is bounded by size: an append that would pass 8192 bytes is refused and leaves the file unchanged', () => {
  const f = fixture({ repository: '/repo/' + 'x'.repeat(600) });
  let refused = null, count = 0;
  for (let index = 1; index <= 16 && !refused; index++) {
    const before = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'hex') : null;
    try { flow.appendExtension(f.ctx, record({ head: headN(index), operator: 'o'.repeat(128), reason: 'r'.repeat(200) })); count++; }
    catch (error) { refused = { error, before }; }
  }
  assert(refused && count > 0 && count < 16, 'the size bound must refuse before the count bound');
  assert.match(refused.error.message, /bound/);
  assert.equal(fs.readFileSync(f.file, 'hex'), refused.before);
  assert(fs.statSync(f.file).size <= 8192);
});

for (const point of ['before the temporary file', 'before the atomic write']) {
  test('config invalidation ' + point + ' refuses with CONFIG_INVALID and saves no record', () => {
    const f = seeded();
    const before = snapshot(f.home);
    const invalidate = () => fs.writeFileSync(f.config, '[]');
    let opened, temporaryOpens = 0;
    const early = point === 'before the temporary file';
    const temporary = path.join(f.directory, `.52.extensions.json.tmp-${process.pid}`);
    const patches = {
      lstatSync(name, ...args) {
        try { return realLstat.call(this, name, ...args); }
        finally { if (early && name === f.file && !fs.existsSync(f.config)) invalidate(); }
      },
      openSync(name, ...args) {
        const fd = realOpen.call(this, name, ...args);
        if (name === temporary) { temporaryOpens++; opened = fd; }
        return fd;
      },
      closeSync(fd) {
        const result = realClose.call(this, fd);
        if (!early && fd === opened) { opened = undefined; invalidate(); }
        return result;
      },
    };
    assert.throws(() => stubbed(patches, () => flow.appendExtension(f.ctx, record({ head: 'c'.repeat(40) }))),
      error => error.code === 'CONFIG_INVALID');
    assert.equal(temporaryOpens, early ? 0 : 1);
    fs.rmSync(f.config, { force: true });
    assert.deepEqual(flow.readExtensions(f.input), [record()]);
    assert.deepEqual(snapshot(f.home), before);
  });
}

test('concurrent processes appending to the same PR keep every record (the lock serializes them)', async () => {
  const f = fixture();
  const code = `const flow = require(process.argv[1]); const ctx = JSON.parse(process.argv[2]);
    for (const head of JSON.parse(process.argv[3]))
      flow.appendExtension(ctx, { head, base_commit: '${BASE}', operator: 'Ada', created_at: '2026-11-02T10:00:00.000Z', reason: 'parallel' });`;
  const env = { ...process.env, HOME: f.home };
  assert(inside(base, env.HOME));
  const children = [0, 1, 2].map(child => new Promise((resolve, reject) => {
    const heads = Array.from({ length: 5 }, (_, index) => headN(child * 5 + index + 1));
    const proc = spawn(process.execPath, ['-e', code, script, JSON.stringify(f.ctx), JSON.stringify(heads)], { env });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('exit', status => status === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(children);
  assert.equal(flow.readExtensions(f.input).length, 15);
  assert.deepEqual(fs.readdirSync(f.directory), ['52.extensions.json']);
});

test('the real state directory received none of the namespaces this file used', () => {
  assert(usedNamespaces.size > 0);
  for (const name of usedNamespaces) assert.equal(fs.existsSync(path.join(realState, name)), false, name);
});
