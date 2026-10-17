'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-adoption-home-')));
const originalHomedir = os.homedir;
os.homedir = () => home;
for (const name of ['HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });

const roleArtifact = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');

const roots = [];
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-adoption-project-')));
  roots.push(root);
  return root;
}
process.on('exit', () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function sidecars(root, count) {
  const dir = path.join(root, '.planning/graph/provenance');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, 'dispatch-' + i + '.json'), '{"n":' + i + '}');
  return dir;
}

function snapshot(root) {
  const out = [];
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { out.push('d ' + file); walk(file); }
      else if (stat.isSymbolicLink()) out.push('l ' + file + ' ' + fs.readlinkSync(file));
      else out.push('f ' + file + ' ' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

function adopt(root, callback = () => {}, written) {
  return roleArtifact.trustedBookkeepingMutation(root, callback, written);
}

function catalogueOf(root) {
  return JSON.parse(fs.readFileSync(path.join(roleArtifact.archiveAuthorityDirectory(root), 'catalogue.json'), 'utf8'));
}

function catalogueBytes(root) {
  return fs.readFileSync(path.join(roleArtifact.archiveAuthorityDirectory(root), 'catalogue.json'));
}

function refusal(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail('expected a refusal');
}

const authorityRoot = () => path.join(home, '.local');

function authorityAbsent(root) {
  return !fs.existsSync(roleArtifact.archiveAuthorityDirectory(root));
}

test('constants are defined once and the catalogue label is unchanged', () => {
  assert.equal(roleArtifact.LEGACY_BOOKKEEPING_FIELD, 'legacy_bookkeeping');
  assert.equal(roleArtifact.LEGACY_BOOKKEEPING_SCHEMA, 'shipyard.legacy-bookkeeping.v1');
  assert.equal(roleArtifact.LEGACY_BOOKKEEPING_VERSION, 1);
  assert.equal(roleArtifact.LEGACY_STATUS, 'historical-unverified');
});

test('no directory and an empty directory classify as absent without side effects', () => {
  const root = project();
  const homeBefore = snapshot(home);
  const first = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(first.state, 'absent');
  assert.equal(first.unreadable, null);
  fs.mkdirSync(path.join(root, '.planning/graph/provenance'), { recursive: true });
  const second = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(second.state, 'absent');
  assert.deepEqual(snapshot(home), homeBefore);
  assert.ok(authorityAbsent(root));
});

test('64 sidecars without a catalogue are adoptable with a full inventory and nothing is created', () => {
  const root = project();
  sidecars(root, 64);
  const before = snapshot(root), homeBefore = snapshot(home);
  const result = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(result.state, 'adoptable');
  assert.equal(result.members.length, 64);
  assert.ok(result.members.every(member => /^[a-f0-9]{64}$/.test(member.sha256) && member.bytes > 0));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(home), homeBefore);
  assert.ok(authorityAbsent(root));
  assert.deepEqual(roleArtifact.legacyBookkeepingMembers(root), []);
});

test('unsafe members are blocked and never trusted', () => {
  const variants = {
    symlink: dir => fs.symlinkSync('/etc/hosts', path.join(dir, 'link.json')),
    nested: dir => fs.mkdirSync(path.join(dir, 'nested')),
    space: dir => fs.writeFileSync(path.join(dir, 'has space.json'), '{}'),
    wrongSuffix: dir => fs.writeFileSync(path.join(dir, 'notes.txt'), '{}')
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const root = project();
    const dir = sidecars(root, 3);
    mutate(dir);
    const before = snapshot(root);
    const result = roleArtifact.classifyLegacyProvenance(root);
    assert.equal(result.state, 'blocked', name);
    assert.ok(result.findings.some(finding => finding.code === 'LEGACY_HISTORY_UNSAFE'), name);
    assert.deepEqual(snapshot(root), before, name);
    assert.ok(authorityAbsent(root), name);
  }
});

test('a symlinked provenance directory is blocked', () => {
  const root = project();
  const target = path.join(root, 'elsewhere');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'a.json'), '{}');
  fs.mkdirSync(path.join(root, '.planning/graph'), { recursive: true });
  fs.symlinkSync(target, path.join(root, '.planning/graph/provenance'));
  const result = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(result.state, 'blocked');
  assert.equal(result.findings[0].code, 'LEGACY_HISTORY_UNSAFE');
});

test('an inventory that would overflow the catalogue bound is blocked', () => {
  const root = project();
  const dir = path.join(root, '.planning/graph/provenance');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 32000; i++) fs.writeFileSync(path.join(dir, 'm' + i + '.json'), '{}');
  const result = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some(finding => finding.code === 'LEGACY_HISTORY_UNSAFE' && /byte bound/.test(finding.detail)));
});

test('a catalogue with authenticated pins and only pinned members is authenticated', () => {
  const root = project();
  fs.mkdirSync(path.join(root, '.planning/graph'), { recursive: true });
  const member = '.planning/graph/provenance/dispatch-one.json';
  roleArtifact.trustedBookkeepingMutation(root, () => {
    fs.mkdirSync(path.dirname(path.join(root, member)), { recursive: true });
    fs.writeFileSync(path.join(root, member), '{"d":1}');
  }, [member]);
  const pinsBefore = roleArtifact.historicalBookkeepingPins(root);
  const result = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(result.state, 'authenticated');
  assert.deepEqual(roleArtifact.historicalBookkeepingPins(root), pinsBefore);
});

test('an unknown member beside an authenticated catalogue is blocked', () => {
  const root = project();
  const member = '.planning/graph/provenance/dispatch-one.json';
  roleArtifact.trustedBookkeepingMutation(root, () => {
    fs.mkdirSync(path.dirname(path.join(root, member)), { recursive: true });
    fs.writeFileSync(path.join(root, member), '{"d":1}');
  }, [member]);
  fs.writeFileSync(path.join(root, '.planning/graph/provenance/forged.json'), '{}');
  const result = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(result.state, 'blocked');
  assert.equal(result.findings[0].code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
});

test('a catalogue with an empty bookkeeping state does not make sidecars authenticated', () => {
  const root = project();
  roleArtifact.trustedBookkeepingMutation(root, () => {});
  sidecars(root, 2);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adoptable');
});

test('adopted history: unchanged, changed, missing and unknown members', () => {
  const root = project();
  adopt(root);
  sidecars(root, 3);
  adopt(root);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted');
  assert.equal(roleArtifact.legacyBookkeepingMembers(root).length, 3);
  const dir = path.join(root, '.planning/graph/provenance');
  fs.unlinkSync(path.join(dir, 'dispatch-0.json'));
  const missing = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(missing.state, 'adopted');
  assert.deepEqual(missing.warnings, [{ code: 'LEGACY_HISTORY_MISSING', path: '.planning/graph/provenance/dispatch-0.json' }]);
  fs.writeFileSync(path.join(dir, 'dispatch-1.json'), '{"n":"changed"}');
  const changed = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(changed.state, 'blocked');
  assert.equal(changed.findings[0].code, 'LEGACY_HISTORY_CHANGED');
  fs.writeFileSync(path.join(dir, 'dispatch-1.json'), '{"n":1}');
  fs.writeFileSync(path.join(dir, 'extra.json'), '{}');
  const unknown = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(unknown.state, 'blocked');
  assert.equal(unknown.findings[0].code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
});

test('a forged catalogue is an authority finding, not unreadable', () => {
  const root = project();
  roleArtifact.trustedBookkeepingMutation(root, () => {});
  sidecars(root, 2);
  const file = path.join(roleArtifact.archiveAuthorityDirectory(root), 'catalogue.json');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.payload.records = { forged: {} };
  fs.writeFileSync(file, JSON.stringify(envelope) + '\n', { mode: 0o600 });
  const result = roleArtifact.classifyLegacyProvenance(root);
  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some(finding => finding.code === 'ARCHIVE_AUTHORITY_INVALID'));
  assert.equal(result.unreadable, null);
});

function injectUnreadable() {
  const original = fs.lstatSync;
  return mock.method(fs, 'lstatSync', function (target, ...rest) {
    if (typeof target === 'string' && target.startsWith(authorityRoot())) {
      const error = new Error("EPERM: operation not permitted, lstat '" + target + "'");
      error.code = 'EPERM'; error.syscall = 'lstat';
      throw error;
    }
    return original.call(this, target, ...rest);
  });
}

test('unreadable authority namespace is reported, never absent or adoptable', () => {
  const root = project();
  sidecars(root, 64);
  const before = snapshot(root), homeBefore = snapshot(home);
  const stub = injectUnreadable();
  let result;
  try { assert.doesNotThrow(() => { result = roleArtifact.classifyLegacyProvenance(root); }); }
  finally { stub.mock.restore(); }
  assert.equal(result.state, 'unreadable');
  assert.deepEqual(result.unreadable, { code: 'EPERM', syscall: 'lstat' });
  assert.deepEqual(result.members, []);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(home), homeBefore);
  assert.ok(authorityAbsent(root));
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adoptable');
});

test('an unsafe member still blocks while the authority state is unreadable', () => {
  const root = project();
  const dir = sidecars(root, 64);
  fs.symlinkSync('/etc/hosts', path.join(dir, 'link.json'));
  const stub = injectUnreadable();
  let result;
  try { result = roleArtifact.classifyLegacyProvenance(root); } finally { stub.mock.restore(); }
  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some(finding => finding.code === 'LEGACY_HISTORY_UNSAFE'));
});

test('a real unreadable authority directory is reported as unreadable', { skip: process.getuid && process.getuid() === 0
  ? 'running as root: chmod 000 does not deny access' : false }, () => {
  const root = project();
  roleArtifact.trustedBookkeepingMutation(root, () => {});
  sidecars(root, 4);
  const shipyard = path.join(home, '.local/state/shipyard');
  fs.chmodSync(shipyard, 0);
  let result;
  try { result = roleArtifact.classifyLegacyProvenance(root); } finally { fs.chmodSync(shipyard, 0o700); }
  assert.equal(result.state, 'unreadable');
  assert.ok(['EACCES', 'EPERM'].includes(result.unreadable.code));
});

const provenanceDir = root => path.join(root, '.planning/graph/provenance');

test('first admission adopts 64 sidecars once, bytes untouched, never as authenticated pins', () => {
  const root = project();
  sidecars(root, 64);
  const dir = provenanceDir(root);
  const before = snapshot(dir);
  let invoked = 0;
  adopt(root, () => {
    invoked++;
    fs.writeFileSync(path.join(root, '.planning/graph/dispatches.json'), '{"a":1}');
  });
  assert.equal(invoked, 1);
  assert.deepEqual(snapshot(dir), before);
  const { payload } = catalogueOf(root);
  const record = payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD];
  assert.equal(record.schema, roleArtifact.LEGACY_BOOKKEEPING_SCHEMA);
  assert.equal(record.version, roleArtifact.LEGACY_BOOKKEEPING_VERSION);
  assert.equal(record.status, 'historical-unverified');
  assert.ok(!Number.isNaN(Date.parse(record.adopted_at)));
  assert.equal(record.members.length, 64);
  for (const member of record.members) {
    assert.deepEqual(Object.keys(member).sort(), ['bytes', 'path', 'sha256']);
    const content = fs.readFileSync(path.join(root, member.path));
    assert.equal(member.bytes, content.length);
    assert.equal(member.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  }
  const pins = roleArtifact.historicalBookkeepingPins(root);
  assert.deepEqual(pins.map(pin => pin.path), ['.planning/graph/dispatches.json']);
  assert.ok(payload.bookkeeping_state.every(pin => !pin.path.startsWith('.planning/graph/provenance/')));
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted');
  assert.equal(roleArtifact.legacyBookkeepingMembers(root).length, 64);
  const recordBefore = JSON.stringify(record);
  adopt(root);
  assert.equal(JSON.stringify(catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD]), recordBefore);
  assert.deepEqual(snapshot(dir), before);
});

test('a later authenticated sidecar becomes a pin while legacy members stay recorded and unpinned', () => {
  const root = project();
  sidecars(root, 5);
  adopt(root);
  const recordBefore = JSON.stringify(catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD]);
  const member = '.planning/graph/provenance/dispatch-new.json';
  adopt(root, () => fs.writeFileSync(path.join(root, member), '{"new":1}'), [member]);
  assert.deepEqual(roleArtifact.historicalBookkeepingPins(root).map(pin => pin.path), [member]);
  assert.equal(JSON.stringify(catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD]), recordBefore);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted');
});

test('a changed legacy member blocks the mutation before the callback and keeps the catalogue', () => {
  const root = project();
  sidecars(root, 4);
  adopt(root);
  const catalogue = catalogueBytes(root);
  fs.writeFileSync(path.join(provenanceDir(root), 'dispatch-2.json'), '{"n":"tampered"}');
  const after = snapshot(provenanceDir(root));
  let invoked = false;
  const error = refusal(() => adopt(root, () => { invoked = true; }));
  assert.equal(error.code, 'LEGACY_HISTORY_CHANGED');
  assert.match(error.message, /dispatch-2\.json/);
  assert.equal(invoked, false);
  assert.deepEqual(catalogueBytes(root), catalogue);
  assert.deepEqual(snapshot(provenanceDir(root)), after);
});

test('an unknown member added after adoption blocks and keeps the unknown message prefix', () => {
  const root = project();
  sidecars(root, 4);
  adopt(root);
  const catalogue = catalogueBytes(root);
  fs.writeFileSync(path.join(provenanceDir(root), 'planted-by-older-host.json'), '{}');
  let invoked = false;
  const error = refusal(() => adopt(root, () => { invoked = true; }));
  assert.equal(error.code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
  assert.match(error.message, /^unknown host provenance member/);
  assert.match(error.message, /planted-by-older-host\.json/);
  assert.equal(invoked, false);
  assert.deepEqual(catalogueBytes(root), catalogue);
  assert.ok(fs.existsSync(path.join(provenanceDir(root), 'planted-by-older-host.json')));
});

test('an unknown member beside an authenticated record is refused with the same code and prefix', () => {
  const root = project();
  const member = '.planning/graph/provenance/dispatch-one.json';
  adopt(root, () => {
    fs.mkdirSync(provenanceDir(root), { recursive: true });
    fs.writeFileSync(path.join(root, member), '{"d":1}');
  }, [member]);
  fs.writeFileSync(path.join(provenanceDir(root), 'forged.json'), '{}');
  const error = refusal(() => adopt(root));
  assert.equal(error.code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
  assert.match(error.message, /unknown host provenance/);
  assert.equal(catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD], undefined);
});

test('a legacy member removed after adoption is allowed and never re-adopted', () => {
  const root = project();
  sidecars(root, 3);
  adopt(root);
  const recordBefore = JSON.stringify(catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD]);
  fs.unlinkSync(path.join(provenanceDir(root), 'dispatch-0.json'));
  assert.doesNotThrow(() => adopt(root));
  assert.equal(JSON.stringify(catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD]), recordBefore);
});

test('unsafe history refuses before the callback and creates no authority directory or key', () => {
  const variants = {
    symlink: dir => fs.symlinkSync('/etc/hosts', path.join(dir, 'link.json')),
    nested: dir => fs.mkdirSync(path.join(dir, 'nested')),
    badName: dir => fs.writeFileSync(path.join(dir, 'has space.json'), '{}')
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const root = project();
    const dir = sidecars(root, 3);
    mutate(dir);
    const before = snapshot(root), homeBefore = snapshot(home);
    let invoked = false;
    const error = refusal(() => adopt(root, () => { invoked = true; }));
    assert.equal(error.code, 'LEGACY_HISTORY_UNSAFE', name);
    assert.equal(invoked, false, name);
    assert.ok(authorityAbsent(root), name);
    assert.deepEqual(snapshot(root), before, name);
    assert.deepEqual(snapshot(home), homeBefore, name);
  }
});

test('an oversize inventory refuses before the callback and creates no authority state', () => {
  const root = project();
  const dir = provenanceDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 32000; i++) fs.writeFileSync(path.join(dir, 'm' + i + '.json'), '{}');
  const homeBefore = snapshot(home);
  let invoked = false;
  const error = refusal(() => adopt(root, () => { invoked = true; }));
  assert.equal(error.code, 'LEGACY_HISTORY_UNSAFE');
  assert.match(error.message, /byte bound/);
  assert.equal(invoked, false);
  assert.ok(authorityAbsent(root));
  assert.deepEqual(snapshot(home), homeBefore);
});

test('adoption of one worktree does not touch another worktree catalogue', () => {
  const first = project(), second = project();
  sidecars(first, 64);
  sidecars(second, 3);
  adopt(first);
  const firstBytes = catalogueBytes(first);
  assert.ok(authorityAbsent(second));
  adopt(second);
  assert.equal(catalogueOf(first).payload.legacy_bookkeeping.members.length, 64);
  assert.equal(catalogueOf(second).payload.legacy_bookkeeping.members.length, 3);
  assert.deepEqual(catalogueBytes(first), firstBytes);
});

test('a failed callback leaves no adoption record and the history adoptable', () => {
  const root = project();
  sidecars(root, 3);
  const before = snapshot(provenanceDir(root));
  assert.throws(() => adopt(root, () => { throw new Error('writer failed'); }), /writer failed/);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adoptable');
  assert.deepEqual(snapshot(provenanceDir(root)), before);
  adopt(root);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted');
});

test('a writer that declares a recorded legacy path is refused before the callback', () => {
  const root = project();
  sidecars(root, 3);
  adopt(root);
  const legacy = '.planning/graph/provenance/dispatch-1.json';
  const before = snapshot(provenanceDir(root));
  let invoked = false;
  const error = refusal(() => adopt(root, () => { invoked = true; }, [legacy]));
  assert.equal(error.code, 'LEGACY_HISTORY_CHANGED');
  assert.equal(invoked, false);
  assert.deepEqual(snapshot(provenanceDir(root)), before);
});

test('a callback that rewrites a legacy member is refused and the catalogue is not advanced', () => {
  const root = project();
  sidecars(root, 3);
  adopt(root);
  const catalogue = catalogueBytes(root);
  const error = refusal(() => adopt(root, () => fs.writeFileSync(path.join(provenanceDir(root), 'dispatch-1.json'), '{"n":"rewritten"}')));
  assert.equal(error.code, 'LEGACY_HISTORY_CHANGED');
  assert.deepEqual(catalogueBytes(root), catalogue);
});

test('an unreadable authority namespace adopts nothing and writes nothing', () => {
  const root = project();
  sidecars(root, 64);
  const before = snapshot(root), homeBefore = snapshot(home);
  const stub = injectUnreadable();
  let invoked = false, error;
  try { error = refusal(() => adopt(root, () => { invoked = true; })); }
  finally { stub.mock.restore(); }
  assert.equal(error.code, 'EPERM');
  assert.equal(error.syscall, 'lstat');
  assert.equal(invoked, false);
  assert.ok(authorityAbsent(root));
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(home), homeBefore);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adoptable');
});

const STAGING = 'dispatch-9.json.4242.0a1b2c3d-1111-4222-8333-444455556666.tmp';

test('editor and checkout noise is not a record: it never blocks, is never adopted and never trusted', () => {
  for (const noise of ['.DS_Store', '.gitkeep', STAGING]) {
    const root = project();
    const dir = sidecars(root, 3);
    fs.writeFileSync(path.join(dir, noise), 'not a record');
    const result = roleArtifact.classifyLegacyProvenance(root);
    assert.equal(result.state, 'adoptable', noise);
    assert.deepEqual(result.findings, [], noise);
    assert.ok(!result.members.some(member => member.path.endsWith(noise)), noise);
    adopt(root, () => fs.writeFileSync(path.join(root, '.planning/graph/dispatches.json'), '{"a":1}'));
    const record = catalogueOf(root).payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD];
    assert.equal(record.members.length, 3, noise);
    assert.ok(record.members.every(member => !member.path.endsWith(noise)), noise);
    assert.ok(roleArtifact.historicalBookkeepingPins(root).every(pin => !pin.path.endsWith(noise)), noise);
    assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted', noise);
    assert.equal(fs.readFileSync(path.join(dir, noise), 'utf8'), 'not a record', noise);
    adopt(root);
  }
});

test('noise beside an empty history still classifies as absent', () => {
  const root = project();
  const dir = path.join(root, '.planning/graph/provenance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'absent');
});

test('noise that is a symlink, a directory or a near-miss name is still unsafe', () => {
  const variants = {
    symlinkedNoise: dir => fs.symlinkSync('/etc/hosts', path.join(dir, '.DS_Store')),
    directoryNoise: dir => fs.mkdirSync(path.join(dir, '.gitkeep')),
    symlinkedStaging: dir => fs.symlinkSync('/etc/hosts', path.join(dir, STAGING)),
    shortToken: dir => fs.writeFileSync(path.join(dir, 'dispatch-9.json.4242.abc.tmp'), 'x'),
    otherDotfile: dir => fs.writeFileSync(path.join(dir, '.hidden'), 'x'),
    noPid: dir => fs.writeFileSync(path.join(dir, 'dispatch-9.json.0a1b2c3d-1111-4222-8333-444455556666.tmp'), 'x'),
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const root = project();
    const dir = sidecars(root, 2);
    mutate(dir);
    const result = roleArtifact.classifyLegacyProvenance(root);
    assert.equal(result.state, 'blocked', name);
    assert.ok(result.findings.some(finding => finding.code === 'LEGACY_HISTORY_UNSAFE'), name);
  }
});

test('noise appearing after adoption does not block the next mutation', () => {
  const root = project();
  const dir = sidecars(root, 2);
  adopt(root);
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(dir, STAGING), 'x');
  let invoked = 0;
  adopt(root, () => { invoked++; });
  assert.equal(invoked, 1);
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted');
});
