'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unrecorded-home-')));
const originalHomedir = os.homedir;
os.homedir = () => home;
for (const name of ['HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const roleArtifact = require(path.join(SCRIPTS, 'role-artifact.cjs'));
const dispatchRecord = require(path.join(SCRIPTS, 'dispatch-record.cjs'));

const PROVENANCE = '.planning/graph/provenance/';
const roots = [];
process.on('exit', () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unrecorded-project-')));
  roots.push(root);
  return root;
}

function sidecars(root, count) {
  const dir = path.join(root, PROVENANCE);
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

const catalogueFile = root => path.join(roleArtifact.archiveAuthorityDirectory(root), 'catalogue.json');
const authorityAbsent = root => !fs.existsSync(roleArtifact.archiveAuthorityDirectory(root));
const refusal = fn => { try { fn(); } catch (error) { return error; } return assert.fail('expected a refusal'); };
const pinned = root => {
  const member = PROVENANCE + 'dispatch-one.json';
  roleArtifact.trustedBookkeepingMutation(root, () => {
    fs.mkdirSync(path.dirname(path.join(root, member)), { recursive: true });
    fs.writeFileSync(path.join(root, member), '{"d":1}');
  }, [member]);
};

test('a catalogue and its pinned members have no findings', () => {
  const root = project();
  pinned(root);
  assert.deepEqual(roleArtifact.provenanceFindings(root), { findings: [], unreadable: null });
});

test('an unknown member beside a catalogue is found and refuses before the callback', () => {
  const root = project();
  pinned(root);
  fs.writeFileSync(path.join(root, PROVENANCE, 'forged.json'), '{}');
  const found = roleArtifact.provenanceFindings(root).findings;
  assert.deepEqual(found.map(item => [item.code, item.path]), [['LEGACY_HISTORY_UNKNOWN_MEMBER', PROVENANCE + 'forged.json']]);
  const bytes = fs.readFileSync(catalogueFile(root));
  let invoked = false;
  const error = refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => { invoked = true; }, []));
  assert.equal(error.code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
  assert.match(error.message, /^unknown host provenance member before trusted mutation /);
  assert.equal(invoked, false);
  assert.deepEqual(fs.readFileSync(catalogueFile(root)), bytes);
});

test('history from an older release is unknown: refused before any authority state exists, files untouched', () => {
  const root = project();
  sidecars(root, 3);
  const before = snapshot(root), homeBefore = snapshot(home);
  assert.deepEqual(roleArtifact.provenanceFindings(root).findings.map(item => item.path),
    [0, 1, 2].map(i => PROVENANCE + 'dispatch-' + i + '.json'));
  let invoked = false;
  const error = refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => { invoked = true; }));
  assert.equal(error.code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
  assert.equal(error.details.path, PROVENANCE + 'dispatch-0.json');
  assert.equal(invoked, false);
  assert.ok(authorityAbsent(root));
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(home), homeBefore);
});

test('host admission over unrecorded history refuses without a row, a store or a lock, then runs once the files are moved', () => {
  const root = project();
  const dir = sidecars(root, 2);
  const graph = path.join(root, '.planning', 'graph');
  const input = id => ({ graphDir: graph, worktree: root, ticket: 'T-01-01', role: 'executor', dispatch_id: id,
    pid: process.pid, host: 'claude', refreshBoard: false });
  const before = snapshot(root);
  assert.equal(refusal(() => dispatchRecord.recordInflight(input('first'))).code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
  assert.deepEqual(snapshot(root), before);
  assert.ok(authorityAbsent(root));
  fs.rmSync(dir, { recursive: true });
  assert.doesNotThrow(() => dispatchRecord.recordInflight(input('second')), 'the refusal left no lock behind');
  assert.ok(roleArtifact.historicalBookkeepingPins(root).some(pin => pin.path === PROVENANCE + 'second.json'));
});

test('a catalogue that a 0.73 launch adopted is refused the same way and its record stays inert', () => {
  const root = project();
  pinned(root);
  const dir = sidecars(root, 2);
  const file = catalogueFile(root);
  const key = fs.readFileSync(path.join(path.dirname(file), 'hmac.key'));
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
      : JSON.stringify(value);
  const { payload } = JSON.parse(fs.readFileSync(file, 'utf8'));
  payload.legacy_bookkeeping = { schema: 'shipyard.legacy-bookkeeping.v1', version: 1, status: 'historical-unverified',
    adopted_at: '2026-10-17T10:15:59.819Z', members: [0, 1].map(i => ({ path: PROVENANCE + 'dispatch-' + i + '.json', bytes: 7,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'dispatch-' + i + '.json'))).digest('hex') })) };
  fs.writeFileSync(file, JSON.stringify({ payload, mac: crypto.createHmac('sha256', key).update(stable(payload)).digest('hex') }) + '\n', { mode: 0o600 });
  const bytes = fs.readFileSync(file);
  assert.equal(refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => {}, [])).code, 'LEGACY_HISTORY_UNKNOWN_MEMBER');
  assert.deepEqual(fs.readFileSync(file), bytes);
  for (const name of ['dispatch-0.json', 'dispatch-1.json']) fs.rmSync(path.join(dir, name));
  assert.doesNotThrow(() => roleArtifact.trustedBookkeepingMutation(root, () => {}, []));
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).payload.legacy_bookkeeping, 'the old record is carried, not read');
});

test('a trusted mutation that publishes a sidecar it did not declare is refused and the catalogue is not advanced', () => {
  const root = project();
  pinned(root);
  const bytes = fs.readFileSync(catalogueFile(root));
  const error = refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => {
    fs.writeFileSync(path.join(root, PROVENANCE, 'sneaky.json'), '{}');
  }, []));
  assert.equal(error.code, 'ARCHIVE_AUTHORITY_INVALID');
  assert.match(error.message, /undeclared provenance member/);
  assert.deepEqual(fs.readFileSync(catalogueFile(root)), bytes);
});

test('a host admission after a writer without a worktree still passes and pins that writer sidecar', () => {
  const root = project();
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-01-01': { phase: '01' } } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ 'T-01-01': { status: 'pending', ready: true } }));
  const admit = (id, extra = {}) => dispatchRecord.recordInflight({ graphDir: graph, worktree: root, ticket: 'T-01-01', role: 'executor',
    dispatch_id: id, pid: process.pid, host: 'claude', refreshBoard: false, ...extra });
  admit('a1');
  admit('b1', { worktree: undefined });
  assert.doesNotThrow(() => admit('a2'));
  const pins = roleArtifact.historicalBookkeepingPins(root).map(pin => pin.path);
  assert.ok(pins.includes(PROVENANCE + 'b1.json'));
  assert.deepEqual(roleArtifact.provenanceFindings(root).findings, []);
});

test('a role-artifact directory sends a writer without a worktree through the trusted path', () => {
  const outcomes = {};
  for (const archive of [false, true]) {
    const root = project();
    const graph = path.join(root, '.planning', 'graph');
    fs.mkdirSync(graph, { recursive: true });
    fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-01-01': { phase: '01' } } }));
    fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ 'T-01-01': { status: 'pending', ready: true } }));
    if (archive) fs.mkdirSync(path.join(root, '.shipyard-role-artifacts'));
    dispatchRecord.recordInflight({ graphDir: graph, ticket: 'T-01-01', role: 'executor', dispatch_id: 'no-worktree',
      pid: process.pid, host: 'claude', refreshBoard: false });
    outcomes[archive] = [authorityAbsent(root), roleArtifact.historicalBookkeepingPins(root).length > 0];
  }
  assert.deepEqual(outcomes, { false: [true, false], true: [false, true] });
});

test('provenance findings of one worktree never touch another worktree catalogue', () => {
  const first = project(), second = project();
  pinned(first);
  sidecars(second, 2);
  const bytes = fs.readFileSync(catalogueFile(first));
  assert.equal(roleArtifact.provenanceFindings(second).findings.length, 2);
  refusal(() => roleArtifact.trustedBookkeepingMutation(second, () => {}));
  assert.ok(authorityAbsent(second));
  assert.deepEqual(fs.readFileSync(catalogueFile(first)), bytes);
  assert.deepEqual(roleArtifact.provenanceFindings(first), { findings: [], unreadable: null });
});

test('a forged catalogue is an authority finding, not unreadable', () => {
  const root = project();
  pinned(root);
  const envelope = JSON.parse(fs.readFileSync(catalogueFile(root), 'utf8'));
  envelope.payload.records = { forged: {} };
  fs.writeFileSync(catalogueFile(root), JSON.stringify(envelope) + '\n', { mode: 0o600 });
  const result = roleArtifact.provenanceFindings(root);
  assert.ok(result.findings.some(item => item.code === 'ARCHIVE_AUTHORITY_INVALID'));
  assert.equal(result.unreadable, null);
});

test('an authenticated member replaced by a symlink is an authority finding', () => {
  const root = project();
  pinned(root);
  const member = path.join(root, PROVENANCE, 'dispatch-one.json');
  fs.rmSync(member);
  fs.symlinkSync('/etc/hosts', member);
  const found = roleArtifact.provenanceFindings(root).findings;
  assert.deepEqual(found.map(item => [item.code, item.path]), [['ARCHIVE_AUTHORITY_INVALID', PROVENANCE + 'dispatch-one.json']]);
  assert.equal(refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => {}, [])).code, 'ARCHIVE_AUTHORITY_INVALID');
});

test('a provenance directory that is a symlink is an authority finding', () => {
  const root = project();
  fs.mkdirSync(path.join(root, '.planning/graph'), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, PROVENANCE.slice(0, -1)));
  const result = roleArtifact.provenanceFindings(root);
  assert.deepEqual(result.findings.map(item => item.code), ['ARCHIVE_AUTHORITY_INVALID']);
  assert.equal(refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => {})).code, 'ARCHIVE_AUTHORITY_INVALID');
});

test('an unreadable authority namespace is reported, never read as absent, and nothing is written', () => {
  const root = project();
  sidecars(root, 3);
  const before = snapshot(root), homeBefore = snapshot(home);
  const original = fs.lstatSync;
  const stub = mock.method(fs, 'lstatSync', function (target, ...rest) {
    if (typeof target === 'string' && target.startsWith(path.join(home, '.local'))) {
      throw Object.assign(new Error("EPERM: operation not permitted, lstat '" + target + "'"), { code: 'EPERM', syscall: 'lstat' });
    }
    return original.call(this, target, ...rest);
  });
  let result;
  try { assert.doesNotThrow(() => { result = roleArtifact.provenanceFindings(root); }); }
  finally { stub.mock.restore(); }
  assert.deepEqual(result, { findings: [], unreadable: { code: 'EPERM', syscall: 'lstat' } });
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(home), homeBefore);
});

test('a real unreadable authority directory is reported as unreadable', { skip: process.getuid && process.getuid() === 0
  ? 'running as root: chmod 000 does not deny access' : false }, () => {
  const root = project();
  pinned(root);
  const shipyard = path.join(home, '.local/state/shipyard');
  fs.chmodSync(shipyard, 0);
  let result;
  try { result = roleArtifact.provenanceFindings(root); } finally { fs.chmodSync(shipyard, 0o700); }
  assert.ok(['EACCES', 'EPERM'].includes(result.unreadable.code));
});

const STAGING = 'dispatch-9.json.4242.0a1b2c3d-1111-4222-8333-444455556666.tmp';
const WRITER_TMP = `.${STAGING}.tmp-4243`;

test('editor and checkout noise is not a record: never found, never blocks, never pinned', () => {
  const root = project();
  pinned(root);
  const dir = path.join(root, PROVENANCE);
  for (const noise of ['.DS_Store', '.gitkeep', STAGING, WRITER_TMP]) fs.writeFileSync(path.join(dir, noise), 'not a record');
  assert.deepEqual(roleArtifact.provenanceFindings(root).findings, []);
  let invoked = 0;
  roleArtifact.trustedBookkeepingMutation(root, () => { invoked++; }, []);
  assert.equal(invoked, 1);
  assert.deepEqual(roleArtifact.historicalBookkeepingPins(root).map(pin => pin.path), [PROVENANCE + 'dispatch-one.json']);
});

test('the inert writer name is the exact name lock.writeAtomic stages for a provenance record', () => {
  const lock = require(path.join(SCRIPTS, 'lock.cjs'));
  const dir = path.join(project(), PROVENANCE);
  fs.mkdirSync(dir, { recursive: true });
  const seen = [];
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { seen.push(path.basename(from)); return rename(from, to); };
  try { lock.writeAtomic(path.join(dir, `dispatch-9.json.${process.pid}.${crypto.randomUUID()}.tmp`), '{}'); }
  finally { fs.renameSync = rename; }
  assert.equal(seen.length, 1);
  fs.writeFileSync(path.join(dir, seen[0]), 'x');
  assert.ok(roleArtifact.provenanceInert(dir, seen[0]), seen[0]);
});

test('noise that is a symlink, a directory or a near-miss name is still unknown', () => {
  const variants = {
    symlinkedNoise: dir => fs.symlinkSync('/etc/hosts', path.join(dir, '.DS_Store')),
    directoryNoise: dir => fs.mkdirSync(path.join(dir, '.gitkeep')),
    symlinkedStaging: dir => fs.symlinkSync('/etc/hosts', path.join(dir, STAGING)),
    symlinkedWriterTmp: dir => fs.symlinkSync('/etc/hosts', path.join(dir, WRITER_TMP)),
    directoryWriterTmp: dir => fs.mkdirSync(path.join(dir, WRITER_TMP)),
    writerTmpWithoutDot: dir => fs.writeFileSync(path.join(dir, `${STAGING}.tmp-4243`), 'x'),
    writerTmpWithoutPid: dir => fs.writeFileSync(path.join(dir, `.${STAGING}.tmp-`), 'x'),
    writerTmpWithWordPid: dir => fs.writeFileSync(path.join(dir, `.${STAGING}.tmp-abc`), 'x'),
    writerTmpOfAShortToken: dir => fs.writeFileSync(path.join(dir, '.dispatch-9.json.4242.abc.tmp.tmp-4243'), 'x'),
    writerTmpOfARecord: dir => fs.writeFileSync(path.join(dir, '.dispatch-9.json.tmp-4243'), 'x'),
    shortToken: dir => fs.writeFileSync(path.join(dir, 'dispatch-9.json.4242.abc.tmp'), 'x'),
    otherDotfile: dir => fs.writeFileSync(path.join(dir, '.hidden'), 'x'),
    noPid: dir => fs.writeFileSync(path.join(dir, 'dispatch-9.json.0a1b2c3d-1111-4222-8333-444455556666.tmp'), 'x'),
    badName: dir => fs.writeFileSync(path.join(dir, 'has space.json'), '{}'),
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const root = project();
    pinned(root);
    mutate(path.join(root, PROVENANCE));
    const found = roleArtifact.provenanceFindings(root).findings;
    assert.equal(found.length, 1, name);
    assert.equal(found[0].code, 'LEGACY_HISTORY_UNKNOWN_MEMBER', name);
    assert.equal(refusal(() => roleArtifact.trustedBookkeepingMutation(root, () => {}, [])).code, 'LEGACY_HISTORY_UNKNOWN_MEMBER', name);
  }
});
