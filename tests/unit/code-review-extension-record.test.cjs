'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realHomedir = os.homedir;
const realState = path.join(fs.realpathSync(realHomedir()), '.local/state/shipyard/code-review-publications');
const usedNamespaces = new Set();
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-extension-')));
let current = path.join(base, 'unset-home');
os.homedir = () => current;
process.on('exit', () => { os.homedir = realHomedir; fs.rmSync(base, { recursive: true, force: true }); });
const flow = require(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/phase-code-review.cjs'));

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), REPOSITORY = '/repo/identity';
const record = (overrides = {}) => ({ head: HEAD, base_commit: BASE, operator: 'Ada Lovelace',
  created_at: '2026-11-02T10:00:00.000Z', reason: 'Fresh evidence needs one more pass', ...overrides });
let counter = 0;

function fixture({ homeInsideWorktree = false, repository = REPOSITORY, repo = null, pr = 52 } = {}) {
  const root = path.join(base, `case-${++counter}`);
  const worktree = path.join(root, 'worktree'), planning = path.join(root, 'planning');
  fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(planning, { recursive: true });
  const home = homeInsideWorktree ? path.join(worktree, 'home') : path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  current = home;
  const state = path.join(home, '.local/state/shipyard/code-review-publications');
  const directory = path.join(state, crypto.createHash('sha256')
    .update(JSON.stringify([repository, repo === null ? null : repo.trim().toLowerCase()])).digest('hex'));
  usedNamespaces.add(path.basename(directory));
  return { root, home, worktree, planning, state, directory, file: path.join(directory, `${pr}.extensions.json`),
    input: { repository, repo, pr, roots: [worktree, planning] },
    ctx: { repository, repo, pr, worktree, mode: { project_root: planning } } };
}

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

const noMkdir = run => {
  const original = fs.mkdirSync;
  let calls = 0;
  const result = stubbed({ mkdirSync(...args) { calls++; return original.apply(this, args); } }, run);
  assert.equal(calls, 0, 'the read path must never call mkdir');
  return result;
};

function seeded(options) {
  const f = fixture(options);
  flow.appendExtension(f.ctx, record());
  return f;
}

test('the test home, worktree and state resolve inside the test temp directory, not the real state', () => {
  const f = fixture();
  assert.notEqual(realHomedir(), os.homedir());
  assert(inside(fs.realpathSync(os.tmpdir()), base));
  for (const dir of [os.homedir(), f.home, f.worktree, f.planning, f.directory, f.file]) assert(inside(base, dir), dir);
  assert(!inside(realState, f.file));
  assert(!inside(path.dirname(realState), f.file));
});

test('appendExtension creates a private store outside the worktree and readExtensions returns it unchanged', () => {
  const f = fixture();
  const stored = record();
  assert.deepEqual(flow.appendExtension(f.ctx, stored), stored);
  assert(inside(base, f.file)); assert(!inside(f.worktree, f.file)); assert(!inside(f.planning, f.file));
  assert.equal(fs.lstatSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(f.state).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.directory), ['52.extensions.json']);
  assert.deepEqual(flow.readExtensions(f.input), [stored]);
  const file = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['pr', 'records', 'repository', 'schema', 'selector']);
  assert.deepEqual({ schema: file.schema, repository: file.repository, selector: file.selector, pr: file.pr },
    { schema: 'shipyard.code-review-extension.v1', repository: REPOSITORY, selector: null, pr: 52 });
});

test('readExtensions on a never-used PR returns no records and creates nothing', () => {
  const f = fixture();
  const before = snapshot(f.home);
  assert.deepEqual(noMkdir(() => flow.readExtensions(f.input)), []);
  assert.equal(fs.existsSync(path.join(f.home, '.local')), false);
  assert.equal(fs.existsSync(f.state), false);
  assert.deepEqual(snapshot(f.home), before);
});

test('readExtensions validates the chain with lstat only: a partial chain and an absent file return no records', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.home, '.local'), { mode: 0o700 });
  let before = snapshot(f.home);
  assert.deepEqual(noMkdir(() => flow.readExtensions(f.input)), []);
  assert.equal(fs.existsSync(path.join(f.home, '.local/state/shipyard')), false);
  assert.deepEqual(snapshot(f.home), before);
  fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  before = snapshot(f.home);
  assert.deepEqual(noMkdir(() => flow.readExtensions(f.input)), []);
  assert.deepEqual(snapshot(f.home), before);
});

test('each store is bound to its own selector and normalizes the selector like the publication namespace', () => {
  const f = fixture({ repo: ' Owner/Repo ' });
  flow.appendExtension(f.ctx, record());
  const raw = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(raw.selector, 'owner/repo');
  assert.deepEqual(flow.readExtensions({ ...f.input, repo: 'owner/repo' }), [record()]);
  assert.deepEqual(flow.readExtensions({ ...f.input, repo: null }), []);
  assert.deepEqual(flow.readExtensions({ ...f.input, pr: 53 }), []);
});

const fileMutations = {
  'json': file => fs.writeFileSync(file, '{'),
  'array': file => fs.writeFileSync(file, '[]'),
  'scalar': file => fs.writeFileSync(file, '7'),
  'null': file => fs.writeFileSync(file, 'null'),
  'schema': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, schema: 'shipyard.code-review-publication.v1' })),
  'repository': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, repository: '/wrong/repository' })),
  'selector': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, selector: 'other/repo' })),
  'pr': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, pr: 53 })),
  'extra-key': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, comment_id: 7 })),
  'missing-key': (file, data) => { const { selector, ...rest } = data; fs.writeFileSync(file, JSON.stringify(rest)); },
  'records-not-array': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: {} })),
  'record-extra-key': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [{ ...data.records[0], id: 1 }] })),
  'record-missing-key': (file, data) => {
    const { reason, ...rest } = data.records[0]; fs.writeFileSync(file, JSON.stringify({ ...data, records: [rest] }));
  },
  'bad-head': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ head: 'a'.repeat(39) })] })),
  'upper-head': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ head: 'A'.repeat(40) })] })),
  'bad-base': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ base_commit: 'xyz' })] })),
  'time-no-millis': (file, data) => fs.writeFileSync(file,
    JSON.stringify({ ...data, records: [record({ created_at: '2026-11-02T10:00:00Z' })] })),
  'time-offset': (file, data) => fs.writeFileSync(file,
    JSON.stringify({ ...data, records: [record({ created_at: '2026-11-02T10:00:00.000+01:00' })] })),
  'time-impossible': (file, data) => fs.writeFileSync(file,
    JSON.stringify({ ...data, records: [record({ created_at: '2026-13-45T10:00:00.000Z' })] })),
  'empty-reason': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ reason: '' })] })),
  'long-reason': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ reason: 'é'.repeat(101) })] })),
  'control-reason': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ reason: 'two\nlines' })] })),
  'empty-operator': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ operator: '' })] })),
  'long-operator': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ operator: 'é'.repeat(65) })] })),
  'control-operator': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record({ operator: 'Ada\u0007' })] })),
  'too-many-records': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data,
    records: Array.from({ length: 17 }, (_, index) => record({ head: String(index).padStart(40, '0') })) })),
  'duplicate-records': (file, data) => fs.writeFileSync(file, JSON.stringify({ ...data, records: [record(), record()] })),
  'oversize': file => fs.writeFileSync(file, ' '.repeat(8193)),
  'mode': file => fs.chmodSync(file, 0o644),
  'directory': file => { fs.unlinkSync(file); fs.mkdirSync(file); },
  'symlink': file => { fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file); },
};

for (const [mutation, mutate] of Object.entries(fileMutations)) {
  test('unsafe or invalid extension file makes readExtensions throw: ' + mutation, () => {
    const f = seeded();
    mutate(f.file, JSON.parse(fs.readFileSync(f.file, 'utf8')));
    const before = snapshot(f.home);
    assert.throws(() => flow.readExtensions(f.input));
    assert.deepEqual(snapshot(f.home), before);
  });
}

test('a file owned by another uid makes readExtensions throw', () => {
  const f = seeded();
  const lstat = fs.lstatSync;
  assert.throws(() => stubbed({ lstatSync(name, ...args) {
    const stat = lstat.call(this, name, ...args);
    if (name === f.file) stat.uid += 1;
    return stat;
  } }, () => flow.readExtensions(f.input)), /unsafe extension record/);
});

test('an unreadable extension file makes readExtensions throw', () => {
  const f = seeded();
  const open = fs.openSync;
  assert.throws(() => stubbed({ openSync(name, ...args) {
    if (name === f.file) throw Object.assign(new Error('unreadable state'), { code: 'EACCES' });
    return open.call(this, name, ...args);
  } }, () => flow.readExtensions(f.input)), /unreadable state/);
});

for (const mode of [0o755, 0o770, 0o701]) {
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

for (const [label, replaced] of [['.local/state', '.local/state'], ['shipyard', '.local/state/shipyard']]) {
  test(`ancestor-symlink: ${label} replaced by a symlink to a real store makes readExtensions throw`, () => {
    const f = seeded();
    const ancestor = path.join(f.home, replaced);
    fs.renameSync(ancestor, ancestor + '.real'); fs.symlinkSync(ancestor + '.real', ancestor);
    assert.deepEqual(fs.readdirSync(f.directory.replace(ancestor, ancestor + '.real')), ['52.extensions.json']);
    const before = snapshot(f.home);
    assert.throws(() => noMkdir(() => flow.readExtensions(f.input)), /unsafe publication namespace/);
    assert.deepEqual(snapshot(f.home), before);
  });
}

test('a group-writable or foreign-owned ancestor directory makes readExtensions throw', () => {
  const f = seeded();
  fs.chmodSync(path.join(f.home, '.local'), 0o775);
  assert.throws(() => flow.readExtensions(f.input), /unsafe publication namespace/);
  fs.chmodSync(path.join(f.home, '.local'), 0o700);
  const lstat = fs.lstatSync;
  for (const [owned, message] of [[f.home, /unsafe publication home/], [path.join(f.home, '.local/state'), /unsafe publication namespace/]]) {
    assert.throws(() => stubbed({ lstatSync(name, ...args) {
      const stat = lstat.call(this, name, ...args);
      if (name === owned) stat.uid += 1;
      return stat;
    } }, () => flow.readExtensions(f.input)), message);
  }
});

test('a state directory inside the worktree or planning checkout is refused by both paths', () => {
  const f = fixture({ homeInsideWorktree: true });
  const before = snapshot(f.home);
  assert.throws(() => flow.readExtensions(f.input), /inside a source or planning checkout/);
  assert.throws(() => flow.appendExtension(f.ctx, record()), /inside a source or planning checkout/);
  assert.deepEqual(snapshot(f.home), before);
});

test('appending the same head and base twice stores one record and returns the existing one', () => {
  const f = fixture();
  const first = flow.appendExtension(f.ctx, record());
  const bytes = fs.readFileSync(f.file, 'hex');
  const again = flow.appendExtension(f.ctx, record({ operator: 'Someone Else', created_at: '2026-11-02T11:00:00.000Z', reason: 'second attempt' }));
  assert.deepEqual(again, first);
  assert.equal(fs.readFileSync(f.file, 'hex'), bytes);
  assert.equal(flow.readExtensions(f.input).length, 1);
  flow.appendExtension(f.ctx, record({ head: 'c'.repeat(40) }));
  flow.appendExtension(f.ctx, record({ base_commit: 'd'.repeat(40) }));
  assert.equal(flow.readExtensions(f.input).length, 3);
});

test('the store is bounded by count: a seventeenth distinct record is refused', () => {
  const f = fixture();
  const heads = Array.from({ length: 17 }, (_, index) => String(index + 1).padStart(40, '0'));
  for (const head of heads.slice(0, 16)) flow.appendExtension(f.ctx, record({ head }));
  const bytes = fs.readFileSync(f.file, 'hex');
  assert.throws(() => flow.appendExtension(f.ctx, record({ head: heads[16] })), /limit/);
  assert.equal(fs.readFileSync(f.file, 'hex'), bytes);
  assert.equal(flow.readExtensions(f.input).length, 16);
  assert.deepEqual(flow.appendExtension(f.ctx, record({ head: heads[0] })).head, heads[0]);
});

test('the store is bounded by size: an append that would pass 8192 bytes is refused and leaves the file unchanged', () => {
  const f = fixture({ repository: '/repo/' + 'x'.repeat(600) });
  let refused = null, count = 0;
  for (let index = 1; index <= 16 && !refused; index++) {
    const before = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'hex') : null;
    try {
      flow.appendExtension(f.ctx, record({ head: String(index).padStart(40, '0'), operator: 'o'.repeat(128), reason: 'r'.repeat(200) }));
      count++;
    } catch (error) { refused = { error, before }; }
  }
  assert(refused, 'the size bound must refuse before the count bound');
  assert.match(refused.error.message, /bound/);
  assert(count > 0 && count < 16);
  assert.equal(fs.readFileSync(f.file, 'hex'), refused.before);
  assert(fs.statSync(f.file).size <= 8192);
  assert.equal(flow.readExtensions(f.input).length, count);
});

const invalidRecords = {
  'bad head': { head: 'g'.repeat(40) },
  'short base': { base_commit: 'b'.repeat(39) },
  'empty operator': { operator: '' },
  'long operator': { operator: 'é'.repeat(65) },
  'control operator': { operator: 'Ada\nLovelace' },
  'empty reason': { reason: '' },
  'long reason': { reason: 'é'.repeat(101) },
  'newline reason': { reason: 'first\nsecond' },
  'nul reason': { reason: 'first\u0000second' },
  'delete reason': { reason: 'first\u007fsecond' },
  'time without millis': { created_at: '2026-11-02T10:00:00Z' },
  'time with offset': { created_at: '2026-11-02T10:00:00.000+00:00' },
  'impossible time': { created_at: '2026-02-31T10:00:00.000Z' },
  'time not a string': { created_at: 1730541600000 },
};

for (const [label, overrides] of Object.entries(invalidRecords)) {
  test('appendExtension refuses an invalid record before touching the file system: ' + label, () => {
    const f = fixture();
    assert.throws(() => flow.appendExtension(f.ctx, record(overrides)));
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(fs.existsSync(path.join(f.home, '.local')), false);
  });
}

test('appendExtension refuses a record with an extra key, a non-object and an unusable PR', () => {
  const f = fixture();
  assert.throws(() => flow.appendExtension(f.ctx, { ...record(), id: 1 }));
  assert.throws(() => flow.appendExtension(f.ctx, null));
  assert.throws(() => flow.appendExtension(f.ctx, []));
  for (const pr of [0, -1, 1.5, '52', '../52', null, undefined]) {
    assert.throws(() => flow.appendExtension({ ...f.ctx, pr }, record()), /pull request/);
    assert.throws(() => flow.readExtensions({ ...f.input, pr }), /pull request/);
  }
  assert.equal(fs.existsSync(f.state), false);
});

test('appendExtension leaves no lock or temporary file and refuses an unsafe existing store', () => {
  const f = seeded();
  flow.appendExtension(f.ctx, record({ head: 'c'.repeat(40) }));
  assert.deepEqual(fs.readdirSync(f.directory), ['52.extensions.json']);
  fs.chmodSync(f.file, 0o644);
  const before = snapshot(f.home);
  assert.throws(() => flow.appendExtension(f.ctx, record({ head: 'd'.repeat(40) })), /unsafe extension record/);
  assert.deepEqual(snapshot(f.home), before);
});

test('the real state directory received none of the namespaces this file used', () => {
  assert(usedNamespaces.size > 0);
  for (const name of usedNamespaces) assert.equal(fs.existsSync(path.join(realState, name)), false, name);
  assert.equal(os.homedir(), current);
});
