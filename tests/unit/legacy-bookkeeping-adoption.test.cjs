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

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function writeLegacyRecord(root, members) {
  const directory = roleArtifact.archiveAuthorityDirectory(root);
  const file = path.join(directory, 'catalogue.json');
  const key = fs.readFileSync(path.join(directory, 'hmac.key'));
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.payload[roleArtifact.LEGACY_BOOKKEEPING_FIELD] = {
    schema: roleArtifact.LEGACY_BOOKKEEPING_SCHEMA, version: roleArtifact.LEGACY_BOOKKEEPING_VERSION,
    status: roleArtifact.LEGACY_STATUS, members };
  envelope.mac = crypto.createHmac('sha256', key).update(stable(envelope.payload)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(envelope) + '\n', { mode: 0o600 });
}

function inventoryOf(root) {
  return roleArtifact.classifyLegacyProvenance(root).members;
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
  roleArtifact.trustedBookkeepingMutation(root, () => {});
  sidecars(root, 3);
  writeLegacyRecord(root, inventoryOf(root));
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
