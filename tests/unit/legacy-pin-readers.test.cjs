'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pin-readers-home-')));
const originalHomedir = os.homedir;
os.homedir = () => home;
for (const name of ['HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const roleArtifact = require(path.join(SCRIPTS, 'role-artifact.cjs'));
const dispatchRecord = require(path.join(SCRIPTS, 'dispatch-record.cjs'));

const LEGACY = ['legacy-a', 'legacy-b', 'legacy-c'];
const PROVENANCE = '.planning/graph/provenance/';
const STORE = '.planning/graph/dispatches.json';
const roots = [];
process.on('exit', () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');

function adoptedProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pin-readers-project-')));
  roots.push(root);
  const provenance = path.join(root, '.planning', 'graph', 'provenance');
  fs.mkdirSync(provenance, { recursive: true });
  const digests = {};
  for (const name of LEGACY) {
    const content = '{"legacy":"' + name + '"}';
    fs.writeFileSync(path.join(provenance, name + '.json'), content);
    digests[PROVENANCE + name + '.json'] = sha(content);
  }
  const graph = path.join(root, '.planning', 'graph');
  dispatchRecord.recordInflight({ graphDir: graph, worktree: root, ticket: 'T-01-01', role: 'executor',
    dispatch_id: 'authenticated-1', pid: process.pid, host: 'claude', refreshBoard: false });
  assert.equal(roleArtifact.classifyLegacyProvenance(root).state, 'adopted', 'the fixture went through real adoption');
  return { root, graph, provenance, digests };
}

function catalogue(root) {
  return JSON.parse(fs.readFileSync(path.join(roleArtifact.archiveAuthorityDirectory(root), 'catalogue.json'), 'utf8'));
}

const AUDIT = Object.freeze([
  { name: 'role-artifact historicalBookkeepingPins', location: 'role-artifact.cjs historicalBookkeepingPins', driven: 'directly' },
  { name: 'role-artifact legacyBookkeepingMembers', location: 'role-artifact.cjs legacyBookkeepingMembers', driven: 'directly' },
  { name: 'role-artifact trustedBookkeepingMutation', location: 'role-artifact.cjs trustedBookkeepingMutation', driven: 'directly' },
  { name: 'dispatch-record authenticateBookkeeping', location: 'dispatch-record.cjs authenticateBookkeeping', driven: 'through recordInflight' },
  { name: 'dispatch-record refuseLegacyCollision', location: 'dispatch-record.cjs refuseLegacyCollision', driven: 'through recordInflight' },
  { name: 'dispatch-record readProvenance', location: 'dispatch-record.cjs readProvenance', driven: 'directly, test-only callers' },
  { name: 'codex-arch-review-context pin consumers', location: 'codex-arch-review-context.cjs', driven: 'at the shared accessor and by source audit' },
]);

test('the audit table is the complete reader inventory', () => {
  const names = AUDIT.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  const files = (needle) => fs.readdirSync(SCRIPTS).filter((name) => /\.(cjs|mjs)$/.test(name))
    .filter((name) => fs.readFileSync(path.join(SCRIPTS, name), 'utf8').includes(needle)).sort();
  assert.deepEqual(files('historicalBookkeepingPins'), ['codex-arch-review-context.cjs', 'dispatch-record.cjs', 'role-artifact.cjs']);
  assert.deepEqual(files('legacyBookkeepingMembers'), ['dispatch-record.cjs', 'role-artifact.cjs']);
  assert.deepEqual(files('bookkeeping_state'), ['role-artifact.cjs']);
  assert.deepEqual(files('legacy_bookkeeping'), ['role-artifact.cjs']);
  assert.deepEqual(files('readProvenance'), ['dispatch-record.cjs']);
});

test('adopted legacy members never enter the authenticated catalogue state', () => {
  const fixture = adoptedProject();
  const state = catalogue(fixture.root).payload;
  const legacyPaths = Object.keys(fixture.digests);
  assert.deepEqual(state.legacy_bookkeeping.members.map((member) => member.path).sort(), legacyPaths.sort());
  assert.equal(state.legacy_bookkeeping.status, 'historical-unverified');
  const authenticated = JSON.stringify({ records: state.records, bookkeeping_state: state.bookkeeping_state,
    latest_bookkeeping: state.latest_bookkeeping || null });
  for (const [legacyPath, digest] of Object.entries(fixture.digests)) {
    assert.ok(!authenticated.includes(legacyPath), 'authenticated state names ' + legacyPath);
    assert.ok(!authenticated.includes(digest), 'authenticated state carries the digest of ' + legacyPath);
  }
});

test('historicalBookkeepingPins returns only authenticated members', () => {
  const fixture = adoptedProject();
  const pins = roleArtifact.historicalBookkeepingPins(fixture.root);
  assert.deepEqual(pins.map((pin) => pin.path).sort(), [STORE, PROVENANCE + 'authenticated-1.json']);
  const rendered = JSON.stringify(pins);
  for (const [legacyPath, digest] of Object.entries(fixture.digests)) {
    assert.ok(!rendered.includes(legacyPath) && !rendered.includes(digest));
  }
});

test('legacyBookkeepingMembers is disjoint from the authenticated pins', () => {
  const fixture = adoptedProject();
  const legacy = roleArtifact.legacyBookkeepingMembers(fixture.root).map((member) => member.path);
  const pinned = new Set(roleArtifact.historicalBookkeepingPins(fixture.root).map((pin) => pin.path));
  assert.equal(legacy.length, LEGACY.length);
  assert.ok(legacy.every((member) => !pinned.has(member)));
});

test('trustedBookkeepingMutation keeps legacy members out of the pins it publishes', () => {
  const fixture = adoptedProject();
  const relative = PROVENANCE + 'authenticated-2.json';
  roleArtifact.trustedBookkeepingMutation(fixture.root, () => {
    fs.writeFileSync(path.join(fixture.provenance, 'authenticated-2.json'), '{"id":2}');
  }, [relative]);
  const state = catalogue(fixture.root).payload;
  assert.deepEqual(state.bookkeeping_state.map((pin) => pin.path).sort(),
    [STORE, PROVENANCE + 'authenticated-1.json', relative]);
  assert.equal(state.legacy_bookkeeping.members.length, LEGACY.length);
});

test('a changed legacy member is refused and is not promoted to a pin', () => {
  const fixture = adoptedProject();
  fs.writeFileSync(path.join(fixture.provenance, 'legacy-a.json'), '{"legacy":"edited"}');
  const before = fs.readFileSync(path.join(roleArtifact.archiveAuthorityDirectory(fixture.root), 'catalogue.json'));
  assert.throws(() => roleArtifact.trustedBookkeepingMutation(fixture.root, () => {}, []),
    (error) => error.code === 'LEGACY_HISTORY_CHANGED');
  assert.deepEqual(fs.readFileSync(path.join(roleArtifact.archiveAuthorityDirectory(fixture.root), 'catalogue.json')), before);
  assert.ok(roleArtifact.historicalBookkeepingPins(fixture.root).every((pin) => !pin.path.includes('legacy-')));
});

test('admission through recordInflight keeps legacy members out of the pins', () => {
  const fixture = adoptedProject();
  dispatchRecord.recordInflight({ graphDir: fixture.graph, worktree: fixture.root, ticket: 'T-01-02', role: 'executor',
    dispatch_id: 'authenticated-3', pid: process.pid, host: 'claude', refreshBoard: false });
  const pinned = roleArtifact.historicalBookkeepingPins(fixture.root).map((pin) => pin.path).sort();
  assert.deepEqual(pinned, [STORE, PROVENANCE + 'authenticated-1.json', PROVENANCE + 'authenticated-3.json']);
});

test('a dispatch id that collides with recorded legacy history is refused', () => {
  const fixture = adoptedProject();
  assert.throws(() => dispatchRecord.recordInflight({ graphDir: fixture.graph, worktree: fixture.root, ticket: 'T-01-03',
    role: 'executor', dispatch_id: LEGACY[0], pid: process.pid, host: 'claude', refreshBoard: false }),
  (error) => error.code === 'LEGACY_HISTORY_COLLISION');
  assert.equal(fs.readFileSync(path.join(fixture.provenance, 'legacy-a.json'), 'utf8'), '{"legacy":"legacy-a"}');
});

test('readProvenance consults no catalogue and has no production caller', () => {
  const fixture = adoptedProject();
  const raw = dispatchRecord.readProvenance(fixture.graph, LEGACY[1]);
  assert.deepEqual(raw, { legacy: LEGACY[1] });
  assert.ok(!('sha256' in raw) && !('authenticated' in raw), 'it hands back file content, never an attestation');
  const callers = fs.readdirSync(SCRIPTS).filter((name) => /\.(cjs|mjs)$/.test(name))
    .filter((name) => /readProvenance\(/.test(fs.readFileSync(path.join(SCRIPTS, name), 'utf8')));
  assert.deepEqual(callers, ['dispatch-record.cjs']);
  const source = fs.readFileSync(path.join(SCRIPTS, 'dispatch-record.cjs'), 'utf8');
  assert.equal(source.match(/readProvenance\(/g).length, 1, 'only the definition calls the name');
});

test('the review context builder takes its pins from the authenticated accessor alone', () => {
  const source = fs.readFileSync(path.join(SCRIPTS, 'codex-arch-review-context.cjs'), 'utf8');
  for (const forbidden of ['legacy_bookkeeping', 'legacyBookkeepingMembers', 'classifyLegacyProvenance', 'bookkeeping_state']) {
    assert.ok(!source.includes(forbidden), 'review context references ' + forbidden);
  }
  assert.equal(source.match(/roleArtifact\.historicalBookkeepingPins\(/g).length, 1, 'one producer, the accessor');
  const fixture = adoptedProject();
  const attestationInput = JSON.stringify({ historical_bookkeeping: roleArtifact.historicalBookkeepingPins(fixture.root) });
  for (const [legacyPath, digest] of Object.entries(fixture.digests)) {
    assert.ok(!attestationInput.includes(legacyPath) && !attestationInput.includes(digest));
  }
});
