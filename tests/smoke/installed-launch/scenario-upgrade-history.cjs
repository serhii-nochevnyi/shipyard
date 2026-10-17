'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./lib.cjs');

const PROVENANCE = '.planning/graph/provenance';
const DESTRUCTIVE = /\b(delete|remove|archive|move)\b/i;

function git(fixture, cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: fixture.home },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function seed(root, count, prefix = 'dispatch-legacy') {
  const directory = path.join(root, PROVENANCE);
  fs.mkdirSync(directory, { recursive: true });
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}-${String(index).padStart(3, '0')}.json`;
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify({ dispatch_id: name.slice(0, -5), ticket: 'T-01-01', role: 'executor', n: index }, null, 2) + '\n');
    files.push(file);
  }
  return files;
}

function snapshot(files) {
  return new Map(files.map((file) => [file, fs.readFileSync(file)]));
}

function assertUnchanged(before, label) {
  for (const [file, bytes] of before) {
    assert.ok(fs.existsSync(file), `${label}: ${file} must still exist`);
    assert.ok(fs.readFileSync(file).equals(bytes), `${label}: ${file} must be byte-identical`);
  }
}

function inspect(fixture, root) {
  const script = `
const ra = require(${JSON.stringify(path.join(fixture.scriptsDir, 'role-artifact.cjs'))});
const dir = ra.archiveAuthorityDirectory(${JSON.stringify(root)});
const out = { dir, members: [], pins: [], catalogue: null };
try { out.members = ra.legacyBookkeepingMembers(${JSON.stringify(root)}); out.pins = ra.historicalBookkeepingPins(${JSON.stringify(root)}).map((pin) => pin.path); } catch (error) { out.error = error.message; }
try { out.catalogue = require('node:fs').readFileSync(require('node:path').join(dir, 'catalogue.json')).toString('base64'); } catch {}
process.stdout.write(JSON.stringify(out));
`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', env: { PATH: fixture.path, HOME: fixture.home },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function requestFile(fixture, worktree, runId) {
  const file = path.join(fixture.workRoot, `request-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    scope: { run_id: runId, ticket: 'T-50-24', phase: 50, worktree, runtime: 'codex', provider: 'openai' },
    role: 'pr-sentinel',
    signals: {},
    context: { prompt: 'Guard the open pull request of ticket T-50-24 and report what you performed or refused.' },
  }));
  return file;
}

function launch(fixture, worktree, runId) {
  const host = path.join(fixture.scriptsDir, 'codex-delivery-host.cjs');
  return lib.runClassified({ ...fixture, project: worktree }, host, ['--args-file', requestFile(fixture, worktree, runId)]);
}

function assertReached(result, label) {
  assert.equal(result.outcome.kind, 'reached', `${label}: ${JSON.stringify(result.outcome)}\n${result.run.stderr}`);
  assert.equal(result.lines.length, 1, `${label}: exactly one native exec`);
}

function assertRefused(result, code, label) {
  assert.equal(result.outcome.kind, 'refused', `${label}: ${JSON.stringify(result.outcome)}\n${result.run.stderr}`);
  assert.deepEqual(result.outcome.labels, [code], `${label}: ${result.run.stderr}`);
  assert.deepEqual(result.lines, [], `${label}: a refusal must precede the native call`);
  assert.ok(!DESTRUCTIVE.test(result.run.stderr), `${label}: a remedy must never touch history\n${result.run.stderr}`);
}

function withFixture(body) {
  const fixture = lib.createFixture();
  try { return body(fixture); } finally { fixture.cleanup(); }
}

const done = [];

withFixture((fixture) => {
  const files = seed(fixture.project, 64);
  const before = snapshot(files);
  const first = launch(fixture, fixture.project, 'upgrade-headline-1');
  assertReached(first, 'case 1 first');
  assertUnchanged(before, 'case 1 first');
  const adopted = inspect(fixture, fixture.project);
  assert.equal(adopted.members.length, 64, 'the 64 legacy sidecars are adopted');
  assert.ok(adopted.members.every((member) => member.status === undefined || member.status === 'historical-unverified'));
  assert.ok(adopted.members.every((member) => !adopted.pins.includes(member.path)), 'no legacy member is a pin');
  const second = launch(fixture, fixture.project, 'upgrade-headline-2');
  assertReached(second, 'case 1 second');
  assertUnchanged(before, 'case 1 second');
  const again = inspect(fixture, fixture.project);
  assert.equal(JSON.stringify(again.members), JSON.stringify(adopted.members), 'no second adoption');
  assert.ok(again.members.every((member) => !again.pins.includes(member.path)));
  lib.assertHarnessIsolation(fixture, { admitted: true });
  done.push('1');
});

withFixture((fixture) => {
  const files = seed(fixture.project, 5);
  const graph = path.join(fixture.project, '.planning/graph');
  const rows = {};
  for (const id of ['dispatch-orphan-a', 'dispatch-orphan-b']) {
    rows[id] = { ticket: 'T-01-01', role: 'executor', dispatch_id: id, pid: 2147483646, host: 'codex', started_at: '2026-01-01T00:00:00.000Z' };
  }
  fs.writeFileSync(path.join(graph, 'dispatches.json'), JSON.stringify({ tickets: {}, rounds: {}, reservations: {}, inflight: rows }, null, 2) + '\n');
  git(fixture, fixture.project, ['add', '-f', '.planning/graph/dispatches.json']);
  git(fixture, fixture.project, ['commit', '-q', '-m', 'tracked store']);
  const before = snapshot(files);
  assertReached(launch(fixture, fixture.project, 'upgrade-partial-1'), 'case 2');
  assertUnchanged(before, 'case 2');
  lib.assertHarnessIsolation(fixture, { admitted: true });
  done.push('2');
});

withFixture((fixture) => {
  const files = seed(fixture.project, 3);
  const before = snapshot(files);
  const linked = path.join(fixture.workRoot, 'linked');
  git(fixture, fixture.project, ['worktree', 'add', '-q', '-b', 'linked-first', linked]);
  const fromLinked = launch(fixture, fs.realpathSync(linked), 'upgrade-linked-1');
  assertReached(fromLinked, 'case 3 linked');
  assertUnchanged(before, 'case 3 linked');
  const pinned = inspect(fixture, fixture.project);
  assert.equal(pinned.members.length, 3, 'the linked-worktree launch adopts the project history');
  const fromRoot = launch(fixture, fixture.project, 'upgrade-linked-2');
  assertReached(fromRoot, 'case 3 project root');
  assertUnchanged(before, 'case 3 project root');
  lib.assertHarnessIsolation(fixture, { admitted: true });
  done.push('3');
});

withFixture((fixture) => {
  const files = seed(fixture.project, 4);
  assertReached(launch(fixture, fixture.project, 'upgrade-changed-1'), 'case 4 adoption');
  const catalogue = inspect(fixture, fixture.project).catalogue;
  assert.ok(catalogue, 'adoption wrote the catalogue');
  fs.appendFileSync(files[1], ' ');
  const changedBytes = fs.readFileSync(files[1]);
  const refused = launch(fixture, fixture.project, 'upgrade-changed-2');
  assertRefused(refused, 'LEGACY_HISTORY_CHANGED', 'case 4');
  assert.ok(refused.run.stderr.includes(path.basename(files[1])), 'the refusal names the file');
  assert.equal(inspect(fixture, fixture.project).catalogue, catalogue, 'the catalogue is untouched');
  assert.ok(fs.readFileSync(files[1]).equals(changedBytes) && files.every((file) => fs.existsSync(file)), 'nothing deleted or rewritten');
  lib.assertHarnessIsolation(fixture, { admitted: true });
  done.push('4');
});

withFixture((fixture) => {
  const files = seed(fixture.project, 4);
  assertReached(launch(fixture, fixture.project, 'upgrade-unknown-1'), 'case 5 adoption');
  const catalogue = inspect(fixture, fixture.project).catalogue;
  const [extra] = seed(fixture.project, 1, 'dispatch-newer-host');
  const refused = launch(fixture, fixture.project, 'upgrade-unknown-2');
  assertRefused(refused, 'LEGACY_HISTORY_UNKNOWN_MEMBER', 'case 5');
  assert.ok(/upgrade/i.test(refused.run.stderr), 'the remedy says to update the host that wrote it');
  assert.equal(inspect(fixture, fixture.project).catalogue, catalogue, 'the catalogue is untouched');
  assert.ok([...files, extra].every((file) => fs.existsSync(file)), 'nothing deleted');
  lib.assertHarnessIsolation(fixture, { admitted: true });
  done.push('5');
});

withFixture((fixture) => {
  const files = seed(fixture.project, 3);
  const target = path.join(fixture.workRoot, 'symlink-target.json');
  fs.writeFileSync(target, '{}\n');
  const link = path.join(fixture.project, PROVENANCE, 'dispatch-symlinked.json');
  fs.symlinkSync(target, link);
  const refused = launch(fixture, fixture.project, 'upgrade-symlink-1');
  assertRefused(refused, 'LEGACY_HISTORY_UNSAFE', 'case 6');
  const state = inspect(fixture, fixture.project);
  assert.ok(!fs.existsSync(state.dir), 'a refused first admission leaves no authority directory');
  assert.ok(fs.lstatSync(link).isSymbolicLink() && files.every((file) => fs.existsSync(file)), 'nothing deleted');
  lib.assertHarnessIsolation(fixture);
  done.push('6');
});

withFixture((fixture) => {
  const store = path.join(fixture.project, '.planning/graph/dispatches.json');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify({ tickets: {}, rounds: {}, reservations: {}, inflight: {} }, null, 2) + '\n');
  git(fixture, fixture.project, ['add', '-f', '.planning/graph/dispatches.json']);
  git(fixture, fixture.project, ['commit', '-q', '-m', 'tracked store']);
  const clone = path.join(fixture.workRoot, 'clone');
  git(fixture, fixture.workRoot, ['clone', '-q', fixture.project, clone]);
  assert.ok(!fs.existsSync(path.join(clone, PROVENANCE)), 'a fresh clone carries no provenance');
  const result = launch(fixture, fs.realpathSync(clone), 'upgrade-clone-1');
  assertReached(result, 'case 7');
  const tracked = git(fixture, clone, ['ls-files', '.planning/graph/dispatches.json']) !== '';
  console.log('MEASURE: ' + JSON.stringify({
    case: 'fresh-clone',
    provenance_directory: fs.existsSync(path.join(clone, PROVENANCE)),
    run_directory: fs.existsSync(path.join(clone, '.shipyard-role-artifacts')),
    tracked_store: tracked,
  }));
  lib.assertHarnessIsolation(fixture, { admitted: true });
  done.push('7');
});

withFixture((fixture) => {
  const layout = lib.stageClaudeLayout(fixture);
  lib.installFakeClaude(fixture);
  const host = path.join(layout.scriptsDir, 'claude-role-host.cjs');
  const preflight = (project) => spawnSync(process.execPath, [host, '--preflight', '--args-file',
    lib.writeClaudeRoleRequest(fixture, project)], {
    cwd: project.root, encoding: 'utf8', env: { PATH: fixture.path, HOME: fixture.home, ...layout.env },
  });
  const partial = lib.stageClaudeProject(fixture, 'upgrade-partial');
  const partialFiles = seed(partial.root, 3);
  const partialBefore = snapshot(partialFiles);
  const ok = preflight(partial);
  assert.equal(ok.status, 0, 'Claude preflight over partial history: ' + ok.stderr);
  assert.ok(!/LEGACY_HISTORY_/.test(ok.stderr), ok.stderr);
  assertUnchanged(partialBefore, 'claude partial');
  const unsafe = lib.stageClaudeProject(fixture, 'upgrade-symlink');
  seed(unsafe.root, 2);
  const target = path.join(fixture.workRoot, 'claude-symlink-target.json');
  fs.writeFileSync(target, '{}\n');
  fs.symlinkSync(target, path.join(unsafe.root, PROVENANCE, 'dispatch-symlinked.json'));
  const refused = preflight(unsafe);
  assert.notEqual(refused.status, 0, 'Claude preflight must refuse a symlinked member');
  assert.ok(/hint\[LEGACY_HISTORY_UNSAFE\]/.test(refused.stderr), refused.stderr);
  assert.ok(!DESTRUCTIVE.test(refused.stderr), refused.stderr);
  assert.deepEqual(lib.installFakeClaude(fixture).readLog(), [], 'a preflight never reaches the native CLI');
  lib.assertHarnessIsolation(fixture);
  done.push('claude');
});

assert.deepEqual(done, ['1', '2', '3', '4', '5', '6', '7', 'claude']);
console.log('installed-launch upgrade-history: OK (cases ' + done.join(', ') + ')');
