'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { stableStringify } = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Coverage Test');
  git('config', 'user.email', 'coverage@example.test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'file'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'one', '-m', `Shipyard-Verification-Evidence: ${'a'.repeat(64)}`);
  const commit = git('rev-parse', 'HEAD');
  const tree = git('show', '-s', '--format=%T', commit);
  const previousRoot = process.env.SHIPYARD_COVERAGE_ROOT;
  process.env.SHIPYARD_COVERAGE_ROOT = path.join(root, 'coverage-state');
  const close = () => {
    if (previousRoot === undefined) delete process.env.SHIPYARD_COVERAGE_ROOT;
    else process.env.SHIPYARD_COVERAGE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, commit, tree, close, git };
}

function sealedReceipt(store, dispatchId, ticket = 'T-43-17', compliance = 'verified', extra = {}) {
  createDurableRecorder(store);
  const key = fs.readFileSync(path.join(path.dirname(store), `.shipyard-dispatch-authority-${hash(path.resolve(store))}.key`));
  const receipt = { dispatch_id: dispatchId, compliance, runtime: dispatchId.startsWith('claude') ? 'claude' : 'codex', ...extra };
  const payload = { dispatch_id: dispatchId, ticket, receipt };
  const raw = { format: 'adr-014.durable-boundary.v1', payload,
    integrity: { algorithm: 'hmac-sha256', mac: crypto.createHmac('sha256', key)
      .update(stableStringify(payload)).digest('hex') } };
  fs.writeFileSync(path.join(store, `record-${hash(dispatchId)}.json`), JSON.stringify(raw), { mode: 0o600 });
  return { digest: hash(stableStringify(receipt)), keyFile: path.join(path.dirname(store), `.shipyard-dispatch-authority-${hash(path.resolve(store))}.key`) };
}

test('records and verifies a mechanical merge, refusing tampering and wrong keys', () => {
  const f = fixture();
  try {
    const input = { commit: f.commit, parents: [], tree: f.tree, ticket: 'T-43-17', repo: 'owner/repo',
      kind: 'base-merge', worktree: f.repo, base_merge: { base: 'main', requested_base: 'main', taken_from_base: [] } };
    const writer = coverage.createCoverageWriter();
    writer.record(input);
    assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: f.repo }).covered, true);
    assert.deepEqual(writer.record(input).base_merge.taken_from_base, []);
    assert.throws(() => writer.record({ ...input, ticket: 'T-43-18' }), /conflicting/);
    assert.equal(coverage.verify({ commit: f.commit, repo: 'other/repo', worktree: f.repo }).covered, false);
    assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: f.repo,
      keyPath: path.join(f.root, 'other.key') }).covered, false);
    const file = path.join(coverage.coverageRoot(), 'coverage', 'owner%2Frepo', `${f.commit}.json`);
    const raw = JSON.parse(fs.readFileSync(file));
    raw.payload.ticket = 'T-43-18';
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: f.repo }).covered, false);
    assert.equal(coverage.rolloutMarker(), null);
  } finally { f.close(); }
});

test('executor and fixer reopen separate runtime receipt stores and keep one rollout marker', () => {
  const f = fixture();
  try {
    const writer = coverage.createCoverageWriter();
    assert.equal(fs.statSync(coverage.coverageRoot()).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(coverage.coverageRoot(), 'coverage.key')).mode & 0o777, 0o600);
    assert.equal(coverage.coverageRoot().startsWith(f.repo), false);
    for (const [kind, runtime] of [['executor', 'claude'], ['fixer', 'codex']]) {
      const store = path.join(f.root, runtime, 'receipts');
      const dispatch = runtime + '-dispatch';
      const { digest, keyFile } = sealedReceipt(store, dispatch);
      const commit = kind === 'executor' ? f.commit : (() => {
        fs.writeFileSync(path.join(f.repo, 'file'), 'two\n');
        f.git('add', '.'); f.git('commit', '-qm', 'two', '-m', `Shipyard-Verification-Evidence: ${'a'.repeat(64)}`);
        return f.git('rev-parse', 'HEAD');
      })();
      const parents = f.git('show', '-s', '--format=%P', commit).split(' ').filter(Boolean);
      const tree = f.git('show', '-s', '--format=%T', commit);
      const entry = { commit, parents, tree, ticket: 'T-43-17', repo: 'owner/repo', kind,
        dispatch_id: dispatch, receipt_digest: digest, verification_digest: 'a'.repeat(64),
        receipt_store: store, worktree: f.repo };
      writer.record(entry);
      const marker = coverage.rolloutMarker();
      assert.equal(marker.repo, 'owner/repo');
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, true);
      const cli = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
      const child = spawnSync(process.execPath, [cli, 'verify', commit, '--repo', 'owner/repo', '--json'],
        { cwd: f.repo, encoding: 'utf8', env: process.env });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.equal(JSON.parse(child.stdout).covered, true);
      sealedReceipt(store, dispatch, 'T-43-18');
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, false);
      sealedReceipt(store, dispatch);
      sealedReceipt(store, dispatch, 'T-43-17', 'verified', { changed: true });
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, false);
      sealedReceipt(store, dispatch);
      if (kind === 'executor') {
        assert.throws(() => writer.record({ ...entry, receipt_digest: undefined }), /requires/);
        assert.throws(() => writer.record({ ...entry, receipt_store: undefined }), /requires/);
      }
      if (kind === 'fixer') assert.equal(marker.recorded_at, firstMarker);
      else var firstMarker = marker.recorded_at;
      fs.renameSync(keyFile, keyFile + '.away');
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, false);
      assert.equal(fs.existsSync(keyFile), false, 'verification must not recreate a missing authority key');
      fs.renameSync(keyFile + '.away', keyFile);
      sealedReceipt(store, dispatch, 'T-43-17', 'unverified');
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, false);
      fs.rmSync(store, { recursive: true });
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, false);
      assert.equal(fs.existsSync(store), false);
    }
  } finally { f.close(); }
});

test('CLI has no record command and default root is runtime independent', () => {
  const f = fixture();
  try {
    assert.equal(coverage.coverageRoot(), path.join(f.root, 'coverage-state'));
    const modulePath = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
    const roots = ['claude', 'codex'].map((runtime) => {
      const env = { ...process.env, HOME: f.root, SHIPYARD_RUNTIME: runtime };
      delete env.SHIPYARD_COVERAGE_ROOT;
      const child = spawnSync(process.execPath,
        ['-e', `process.stdout.write(require(${JSON.stringify(modulePath)}).coverageRoot())`],
        { encoding: 'utf8', env });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout;
    });
    assert.deepEqual(roots, [path.join(f.root, '.local', 'state', 'shipyard', 'coverage'),
      path.join(f.root, '.local', 'state', 'shipyard', 'coverage')]);
    const cli = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
    const result = spawnSync(process.execPath, [cli, 'record'], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 2);
    assert.equal(fs.existsSync(path.join(f.root, 'coverage-state')), false);
  } finally { f.close(); }
});

test('base-merge records its mechanical commit and leaves a hand conflict uncovered', () => {
  const f = fixture();
  try {
    const initial = f.commit;
    fs.writeFileSync(path.join(f.repo, 'shared'), 'shared base\n');
    fs.writeFileSync(path.join(f.repo, 'owned'), 'owned base\n');
    f.git('add', '.'); f.git('commit', '-qm', 'common');
    const common = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-qb', 'epic');
    fs.writeFileSync(path.join(f.repo, 'shared'), 'base edition\n');
    f.git('commit', '-qam', 'base edition');
    f.git('checkout', '-qb', 'ticket/T-43-17', common);
    fs.writeFileSync(path.join(f.repo, 'shared'), 'stale edition\n');
    fs.writeFileSync(path.join(f.repo, 'owned'), 'ticket edition\n');
    f.git('commit', '-qam', 'ticket edition');
    const graph = path.join(f.root, 'graph');
    fs.mkdirSync(graph);
    fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {
      'T-43-17': { files: ['owned'], repo: 'owner/repo' },
      'T-43-18': { files: ['shared'], repo: 'owner/repo' },
    } }));
    const cli = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/base-merge.cjs');
    const run = (ticket) => spawnSync(process.execPath,
      [cli, ticket, '--worktree', f.repo, '--base', 'epic', '--graph', graph, '--no-fetch', '--json'],
      { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(f.root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
    const mechanical = run('T-43-17');
    assert.equal(mechanical.status, 0, mechanical.stderr);
    const merge = f.git('rev-parse', 'HEAD');
    const checked = coverage.verify({ commit: merge, repo: 'owner/repo', worktree: f.repo });
    assert.equal(checked.covered, true, checked.reason);
    assert.deepEqual(checked.record.base_merge.taken_from_base, ['shared']);

    f.git('checkout', '-qb', 'ticket/T-43-18', common);
    fs.writeFileSync(path.join(f.repo, 'shared'), 'hand conflict\n');
    f.git('commit', '-qam', 'hand conflict');
    const hand = f.git('rev-parse', 'HEAD');
    const conflict = run('T-43-18');
    assert.equal(conflict.status, 1, conflict.stderr);
    assert.equal(JSON.parse(conflict.stdout).result, 'conflicts remain');
    assert.equal(coverage.verify({ commit: hand, repo: 'owner/repo', worktree: f.repo }).covered, false);
    assert.equal(f.git('rev-parse', 'HEAD'), hand);
    assert.notEqual(initial, hand);
  } finally { f.close(); }
});
