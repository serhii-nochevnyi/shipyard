'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const store = require('../../plugins/delivery-pipeline/scripts/subscription-store.cjs');
const sub = require('../../plugins/delivery-pipeline/scripts/subscription-observation.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'plugins/delivery-pipeline/scripts/subscription-store.cjs');
const CODEX_PARENT = 'tests/fixtures/captured/codex-agent-stream-parent.jsonl';

function repoStatus() {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
}

const initialRepoStatus = repoStatus();

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sub-store-'));
process.on('exit', () => fs.rmSync(temporary, { recursive: true, force: true }));

let rootCounter = 0;
function freshStateRoot() {
  rootCounter += 1;
  return fs.mkdtempSync(path.join(temporary, `root-${rootCounter}-`));
}

function freshHome() {
  rootCounter += 1;
  return fs.mkdtempSync(path.join(temporary, `home-${rootCounter}-`));
}

function gitInit(dir) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  execFileSync('git', ['init', '--quiet', dir], { env });
}

function capturedLines(rel) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((line) => line.trim());
  assert.ok(JSON.parse(lines[0]).shipyard_fixture, `${rel} must start with a provenance line`);
  return lines.slice(1).map((line) => JSON.parse(line));
}

function codexParentEnvelope() {
  return sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes[0];
}

suite('subscription-store — resolveRoot safety');

test('refuses a stateRoot under a temp git working tree (a directory containing .git)', () => {
  const gitTree = fs.mkdtempSync(path.join(temporary, 'git-root-'));
  gitInit(gitTree);
  const stateRoot = path.join(gitTree, 'nested', 'state');
  assert.throws(
    () => store.resolveRoot({ runtime: 'codex', stateRoot }),
    (error) => error.code === 'UNSAFE_STATE_ROOT',
  );
  assert.ok(!fs.existsSync(stateRoot));
  assert.ok(!fs.existsSync(path.join(stateRoot, 'subscription')));
});

test('refuses a path with a .planning segment', () => {
  const parent = fs.mkdtempSync(path.join(temporary, 'planning-'));
  const stateRoot = path.join(parent, '.planning', 'state');
  assert.throws(
    () => store.resolveRoot({ runtime: 'claude', stateRoot }),
    (error) => error.code === 'UNSAFE_STATE_ROOT',
  );
  assert.ok(!fs.existsSync(stateRoot));
});

test('refuses a stateRoot that is itself a symlink', () => {
  const parent = fs.mkdtempSync(path.join(temporary, 'symlink-root-'));
  const real = path.join(parent, 'real');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(parent, 'link');
  fs.symlinkSync(real, link, 'dir');
  assert.throws(
    () => store.resolveRoot({ runtime: 'codex', stateRoot: link }),
    (error) => error.code === 'UNSAFE_STATE_ROOT',
  );
  assert.ok(!fs.existsSync(path.join(real, 'subscription')));
  assert.equal(fs.readdirSync(real).length, 0);
});

test('refuses a stateRoot whose subscription/ directory is a symlink into a temp git working tree', () => {
  const base = fs.mkdtempSync(path.join(temporary, 'symlinked-sub-'));
  const gitTree = fs.mkdtempSync(path.join(temporary, 'git-target-'));
  gitInit(gitTree);
  fs.symlinkSync(gitTree, path.join(base, 'subscription'), 'dir');
  assert.throws(
    () => store.resolveRoot({ runtime: 'codex', stateRoot: base }),
    (error) => error.code === 'UNSAFE_STATE_ROOT',
  );
  assert.equal(fs.readdirSync(gitTree).length, 1, 'only .git may exist inside the git tree the symlink points to');
});

test('accepts a stateRoot under os.tmpdir(), following any OS alias above the store', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sub-store-alias-'));
  const root = store.resolveRoot({ runtime: 'codex', stateRoot });
  assert.ok(fs.existsSync(root));
  assert.equal(fs.realpathSync(root), root, 'the returned root must already be canonical');
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

suite('subscription-store — directory and file modes');

test('after append, the store directory is 0700 and the sample file is 0600', () => {
  const stateRoot = freshStateRoot();
  const envelope = codexParentEnvelope();
  const result = store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2026-06-15T00:00:00Z') });
  assert.equal(result.appended, true);
  assert.equal(result.duplicate, false);
  const root = store.resolveRoot({ runtime: 'codex', stateRoot });
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const file = path.join(root, 'samples-2026-06.jsonl');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('after declareLabel, labels.json is 0600', () => {
  const stateRoot = freshStateRoot();
  const home = freshHome();
  store.declareLabel({ runtime: 'claude', home, label: 'alice', stateRoot });
  const root = store.resolveRoot({ runtime: 'claude', stateRoot });
  const labelsFile = path.join(root, 'labels.json');
  assert.equal(fs.statSync(labelsFile).mode & 0o777, 0o600);
});

suite('subscription-store — append dedupe by series, percent and reset');

test('appending the same envelope twice stores one line and reports duplicate:true', () => {
  const stateRoot = freshStateRoot();
  const envelope = codexParentEnvelope();
  const first = store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2026-05-01T00:00:00Z') });
  const second = store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2026-05-02T00:00:00Z') });
  assert.equal(first.appended, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.appended, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.list({ runtime: 'codex', stateRoot }).envelopes.length, 1);
});

test('a changed used_percent stores a new line', () => {
  const stateRoot = freshStateRoot();
  const envelope = codexParentEnvelope();
  store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2026-05-01T00:00:00Z') });
  const changed = { ...envelope };
  changed.used_percent = envelope.used_percent + 5;
  const result = store.append(changed, { runtime: 'codex', stateRoot, now: new Date('2026-05-02T00:00:00Z') });
  assert.equal(result.appended, true);
  assert.equal(store.list({ runtime: 'codex', stateRoot }).envelopes.length, 2);
});

test('a resets_at change within the tolerance is still a duplicate; beyond it stores a new line', () => {
  const stateRoot = freshStateRoot();
  const envelope = codexParentEnvelope();
  store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2026-05-01T00:00:00Z') });

  const withinTolerance = { ...envelope, resets_at: envelope.resets_at + sub.RESET_TOLERANCE_SECONDS };
  const stillDuplicate = store.append(
    withinTolerance, { runtime: 'codex', stateRoot, now: new Date('2026-05-02T00:00:00Z') },
  );
  assert.equal(stillDuplicate.duplicate, true);

  const beyondTolerance = { ...envelope, resets_at: envelope.resets_at + sub.RESET_TOLERANCE_SECONDS + 1 };
  const newLine = store.append(
    beyondTolerance, { runtime: 'codex', stateRoot, now: new Date('2026-05-03T00:00:00Z') },
  );
  assert.equal(newLine.appended, true);
  assert.equal(store.list({ runtime: 'codex', stateRoot }).envelopes.length, 2);
});

suite('subscription-store — prune (bounded retention by age and size)');

test('prune removes an entire month file once its month is older than the retention window', () => {
  const stateRoot = freshStateRoot();
  const envelope = codexParentEnvelope();
  store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2020-01-15T00:00:00Z') });
  const root = store.resolveRoot({ runtime: 'codex', stateRoot });
  const oldFile = path.join(root, 'samples-2020-01.jsonl');
  assert.ok(fs.existsSync(oldFile));

  const result = store.prune({
    runtime: 'codex', stateRoot, now: new Date('2026-09-28T00:00:00Z'), retentionDays: 35,
  });
  assert.equal(result.removed_files, 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.equal(store.list({ runtime: 'codex', stateRoot }).envelopes.length, 0);
});

test('samples inside the retention window survive a prune', () => {
  const stateRoot = freshStateRoot();
  const envelope = codexParentEnvelope();
  store.append(envelope, { runtime: 'codex', stateRoot, now: new Date('2026-09-20T00:00:00Z') });

  const result = store.prune({
    runtime: 'codex', stateRoot, now: new Date('2026-09-28T00:00:00Z'), retentionDays: 35,
  });
  assert.equal(result.removed_files, 0);
  assert.equal(store.list({ runtime: 'codex', stateRoot }).envelopes.length, 1);
});

test('prune caps a surviving file at maxFileBytes by dropping the oldest lines first', () => {
  const stateRoot = freshStateRoot();
  const base = codexParentEnvelope();
  const now = new Date('2026-09-20T00:00:00Z');
  const percents = [10, 20, 30, 40, 50, 60, 70, 80];
  for (const used_percent of percents) {
    store.append({ ...base, used_percent }, { runtime: 'codex', stateRoot, now });
  }
  const root = store.resolveRoot({ runtime: 'codex', stateRoot });
  const file = path.join(root, 'samples-2026-09.jsonl');
  const beforeSize = fs.statSync(file).size;
  const cap = Math.floor(beforeSize / 2);
  assert.ok(cap > 0);

  const result = store.prune({
    runtime: 'codex', stateRoot, now: new Date('2026-09-28T00:00:00Z'), retentionDays: 35, maxFileBytes: cap,
  });
  assert.equal(result.trimmed_files, 1);
  const afterSize = fs.statSync(file).size;
  assert.ok(afterSize <= cap, `expected <=${cap} bytes, got ${afterSize}`);
  assert.ok(afterSize < beforeSize);

  const { envelopes } = store.list({ runtime: 'codex', stateRoot });
  assert.ok(envelopes.length >= 1 && envelopes.length < percents.length);
  assert.equal(envelopes[envelopes.length - 1].used_percent, 80, 'the most recent sample must survive the cap');
});

suite('subscription-store — operator-declared account labels');

test('a missing label returns null from readLabel', () => {
  const stateRoot = freshStateRoot();
  const home = freshHome();
  assert.equal(store.readLabel({ runtime: 'codex', home, stateRoot }), null);
});

test('declareLabel with an @ address throws INVALID_LABEL', () => {
  const stateRoot = freshStateRoot();
  const home = freshHome();
  assert.throws(
    () => store.declareLabel({ runtime: 'codex', home, label: 'a@b.c', stateRoot }),
    (error) => error.code === 'INVALID_LABEL',
  );
});

test('two different runtime homes keep independent labels', () => {
  const stateRoot = freshStateRoot();
  const homeA = freshHome();
  const homeB = freshHome();
  store.declareLabel({ runtime: 'claude', home: homeA, label: 'alice', stateRoot });
  store.declareLabel({ runtime: 'claude', home: homeB, label: 'bob', stateRoot });
  assert.equal(store.readLabel({ runtime: 'claude', home: homeA, stateRoot }), 'alice');
  assert.equal(store.readLabel({ runtime: 'claude', home: homeB, stateRoot }), 'bob');
  store.clearLabel({ runtime: 'claude', home: homeA, stateRoot });
  assert.equal(store.readLabel({ runtime: 'claude', home: homeA, stateRoot }), null);
  assert.equal(store.readLabel({ runtime: 'claude', home: homeB, stateRoot }), 'bob');
});

suite('subscription-store — stored bytes exclude sensitive fields');

test('stored bytes from the Codex parent fixture contain none of the banned fields', () => {
  const stateRoot = freshStateRoot();
  const rawRows = capturedLines(CODEX_PARENT);
  assert.ok(JSON.stringify(rawRows).includes('creator_user_id'), 'fixture sanity: the raw row must carry it');
  const { envelopes } = sub.fromTranscriptRows(rawRows, {});
  const now = new Date('2026-09-20T00:00:00Z');
  for (const envelope of envelopes) store.append(envelope, { runtime: 'codex', stateRoot, now });
  const root = store.resolveRoot({ runtime: 'codex', stateRoot });
  const file = path.join(root, 'samples-2026-09.jsonl');
  const blob = fs.readFileSync(file, 'utf8');
  for (const banned of ['creator_user_id', 'credits', 'plan_type', 'balance', '@']) {
    assert.ok(!blob.includes(banned), `stored bytes must not contain ${banned}`);
  }
});

suite('subscription-store — module source contract');

test('the module source requires none of child_process, net, http, https or dgram', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.ok(!/require\(\s*['"](?:node:)?(?:child_process|net|https?|dgram)['"]\s*\)/.test(src));
});

test('the module exports are frozen', () => {
  assert.ok(Object.isFrozen(store));
});

suite('subscription-store — CLI');

test('CLI list returns JSON with envelopes and a status object', () => {
  const stateRoot = freshStateRoot();
  const out = execFileSync(
    process.execPath, [MODULE_PATH, 'list', '--runtime', 'codex', '--state-root', stateRoot], { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.envelopes));
  assert.equal(parsed.status.implemented, true);
});

test('CLI exits 2 on invalid input', () => {
  const stateRoot = freshStateRoot();
  const result = spawnSync(
    process.execPath, [MODULE_PATH, 'bogus', '--runtime', 'codex', '--state-root', stateRoot], { encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
});

test('CLI label --set/--show/--clear round-trip', () => {
  const stateRoot = freshStateRoot();
  const home = freshHome();
  execFileSync(process.execPath, [
    MODULE_PATH, 'label', '--runtime', 'claude', '--home', home, '--set', 'carol', '--state-root', stateRoot,
  ]);
  const shown = JSON.parse(execFileSync(process.execPath, [
    MODULE_PATH, 'label', '--runtime', 'claude', '--home', home, '--show', '--state-root', stateRoot,
  ], { encoding: 'utf8' }));
  assert.equal(shown.label, 'carol');
  execFileSync(process.execPath, [
    MODULE_PATH, 'label', '--runtime', 'claude', '--home', home, '--clear', '--state-root', stateRoot,
  ]);
  const cleared = JSON.parse(execFileSync(process.execPath, [
    MODULE_PATH, 'label', '--runtime', 'claude', '--home', home, '--show', '--state-root', stateRoot,
  ], { encoding: 'utf8' }));
  assert.equal(cleared.label, null);
});

suite('subscription-store — repository worktree isolation');

test('after this whole run, the repository worktree status is unchanged', () => {
  assert.equal(repoStatus(), initialRepoStatus);
});

done();
