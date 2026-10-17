'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-ordering-home-')));
const originalHomedir = os.homedir;
os.homedir = () => home;
for (const name of ['HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const roleArtifact = require(path.join(SCRIPTS, 'role-artifact.cjs'));
const { recordInflight } = require(path.join(SCRIPTS, 'dispatch-record.cjs'));
const { createRunStore } = require(path.join(SCRIPTS, 'run-store.cjs'));
const runScope = require(path.join(SCRIPTS, 'run-scope.cjs'));

let fixtures = 0;

const roots = [];
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-ordering-project-')));
  roots.push(root);
  const provenance = path.join(root, '.planning', 'graph', 'provenance');
  fs.mkdirSync(provenance, { recursive: true });
  for (const name of ['legacy-a', 'legacy-b', 'legacy-c']) fs.writeFileSync(path.join(provenance, name + '.json'), '{"legacy":"' + name + '"}');
  return { root, graph: path.join(root, '.planning', 'graph'), provenance, runStoreDir: path.join(root, '.planning', 'graph', 'runs'),
    writerRoot: path.join(home, '.local', 'state', 'shipyard', 'planning-writers', 'shared-' + (fixtures += 1)) };
}
process.on('exit', () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { out.push('d ' + path.relative(dir, file)); walk(file); }
      else out.push('f ' + path.relative(dir, file) + ' ' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function seedRunStore(storeDir) {
  const store = createRunStore({ storeDir, now: () => 1000 });
  const run = runScope.createRunScope({ run_id: 'ordering-run', repository_id: 'shipyard/test', phase: 50,
    ticket: 'T-50-09', worktree: '/tmp/shipyard-adoption-ordering', runtime: 'codex', owner_id: 'owner-a',
    dispatch: { dispatch_id: 'dispatch-ordering-run', role: 'executor', model: 'luna', effort: 'max' } });
  store.create({ schema: 'shipyard.run-record.v1', version: 1, run,
    owner: { owner_id: 'owner-a', lease_id: run.lease.lease_id, epoch: 0, acquired_at: 1000, heartbeat_at: 1000, expires_at: 2000, status: 'active' },
    retry: {}, checkpoint: null, successor: null, idempotency: {}, history: [] });
}

function seedWriterRoot(writerRoot) {
  const key = path.join(writerRoot, 'a'.repeat(64));
  fs.mkdirSync(key, { recursive: true });
  fs.writeFileSync(path.join(key, 'lease.json'), JSON.stringify({ schema: 'fixture', status: 'released', epoch: 3 }));
}

function watch(targets) {
  const touched = [];
  const names = ['readFileSync', 'writeFileSync', 'openSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync',
    'mkdirSync', 'renameSync', 'linkSync', 'unlinkSync', 'appendFileSync', 'rmSync', 'realpathSync'];
  const stubs = names.map((name) => {
    const original = fs[name];
    return mock.method(fs, name, function (target, ...rest) {
      if (typeof target === 'string' && targets.some((root) => target === root || target.startsWith(root + path.sep))) touched.push(name + ' ' + target);
      return original.call(this, target, ...rest);
    });
  });
  return { touched, restore: () => stubs.forEach((stub) => stub.mock.restore()) };
}

const admission = (fixture, id) => ({ graphDir: fixture.graph, worktree: fixture.root, ticket: 'T-01-01', role: 'executor',
  dispatch_id: id, pid: process.pid, host: 'claude', refreshBoard: false });

test('adoption inside recordInflight leaves run-store and planning-writer state byte-identical and untouched', () => {
  const fixture = project();
  seedRunStore(fixture.runStoreDir);
  seedWriterRoot(fixture.writerRoot);
  const storeBefore = tree(fixture.runStoreDir), writerBefore = tree(fixture.writerRoot);
  assert.ok(storeBefore.length > 0 && writerBefore.length > 0, 'both state roots are populated before the call');
  assert.equal(roleArtifact.classifyLegacyProvenance(fixture.root).state, 'adoptable');
  const watcher = watch([fixture.runStoreDir, fixture.writerRoot]);
  try { recordInflight(admission(fixture, 'ordering-adoption')); }
  finally { watcher.restore(); }
  assert.equal(roleArtifact.classifyLegacyProvenance(fixture.root).state, 'adopted', 'the call really went through adoption');
  assert.deepEqual(tree(fixture.runStoreDir), storeBefore);
  assert.deepEqual(tree(fixture.writerRoot), writerBefore);
  assert.deepEqual(watcher.touched, [], 'adoption never reads or writes either state root');
});

test('a refused adoption creates neither state root nor an authority directory and releases its lock', () => {
  const fixture = project();
  fs.symlinkSync('/etc/hosts', path.join(fixture.provenance, 'link.json'));
  const provenanceBefore = tree(fixture.provenance);
  const watcher = watch([fixture.runStoreDir, fixture.writerRoot]);
  let failure;
  try { recordInflight(admission(fixture, 'ordering-refused')); } catch (error) { failure = error; }
  finally { watcher.restore(); }
  assert.ok(failure, 'an unsafe member refuses admission');
  assert.equal(failure.code, 'LEGACY_HISTORY_UNSAFE');
  assert.equal(fs.existsSync(fixture.runStoreDir), false, 'no run store was created');
  assert.equal(fs.existsSync(fixture.writerRoot), false, 'no planning-writer root was created');
  assert.equal(fs.existsSync(roleArtifact.archiveAuthorityDirectory(fixture.root)), false, 'no authority directory exists');
  assert.equal(fs.existsSync(path.join(fixture.graph, 'dispatches.json')), false, 'no dispatches.json was written');
  assert.deepEqual(tree(fixture.provenance), provenanceBefore);
  assert.deepEqual(watcher.touched, []);
  fs.unlinkSync(path.join(fixture.provenance, 'link.json'));
  assert.doesNotThrow(() => recordInflight(admission(fixture, 'ordering-after-refusal')), 'no lock is left held by the refusal');
});

test('a refused adoption leaves populated run-store and planning-writer state byte-identical', () => {
  const fixture = project();
  seedRunStore(fixture.runStoreDir);
  seedWriterRoot(fixture.writerRoot);
  fs.writeFileSync(path.join(fixture.provenance, 'not allowed.json'), '{}');
  const storeBefore = tree(fixture.runStoreDir), writerBefore = tree(fixture.writerRoot);
  assert.throws(() => recordInflight(admission(fixture, 'ordering-populated-refusal')), (error) => error.code === 'LEGACY_HISTORY_UNSAFE');
  assert.deepEqual(tree(fixture.runStoreDir), storeBefore);
  assert.deepEqual(tree(fixture.writerRoot), writerBefore);
  assert.equal(fs.existsSync(roleArtifact.archiveAuthorityDirectory(fixture.root)), false);
});
