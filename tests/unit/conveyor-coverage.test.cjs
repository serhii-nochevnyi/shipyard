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
  const { dispatch_role, ...receiptFields } = extra;
  const receipt = { dispatch_id: dispatchId, compliance, runtime: dispatchId.startsWith('claude') ? 'claude' : 'codex',
    role: 'executor', ...receiptFields };
  const payload = { dispatch_id: dispatchId, ticket, runtime: receipt.runtime,
    role: dispatch_role || receipt.role, receipt };
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
    assert.equal(coverage.rolloutMarker({ repo: 'owner/repo' }), null);
  } finally { f.close(); }
});

test('chain reports the first uncovered commit in oldest-first order and refuses an oversized chain', () => {
  const f = fixture();
  try {
    const base = f.commit;
    const commits = [];
    for (const subject of ['covered change', 'hand change', 'later change']) {
      fs.appendFileSync(path.join(f.repo, 'file'), subject + '\n');
      f.git('commit', '-qam', subject);
      commits.push(f.git('rev-parse', 'HEAD'));
    }
    const writer = coverage.createCoverageWriter();
    const commit = commits[0];
    writer.record({ commit, parents: [base], tree: f.git('show', '-s', '--format=%T', commit),
      ticket: 'T-43-19', repo: 'owner/repo', kind: 'base-merge', worktree: f.repo,
      base_merge: { base: 'main', requested_base: 'main', taken_from_base: [] } });
    const result = coverage.chain({ repo: 'owner/repo', worktreeOrCheckout: f.repo, base, head: commits[2] });
    assert.equal(result.covered, false);
    assert.equal(result.commit, commits[1]);
    assert.match(result.subject, /hand change/);
    assert.match(result.author, /Coverage Test/);
    assert.deepEqual(coverage.chain({ repo: 'owner/repo', worktreeOrCheckout: f.repo,
      base, head: commits[2], commitCap: 2 }), { covered: false, reason: 'chain too long' });
  } finally { f.close(); }
});

test('remedy coverage requires declared workflow, run id and dispatch head on write and read', () => {
  const f = fixture();
  try {
    const input = { commit: f.commit, parents: [], tree: f.tree, ticket: 'T-43-18',
      repo: 'owner/repo', kind: 'remedy', worktree: f.repo,
      remedy: { workflow: 'repair.yml', run_id: '72', dispatch_head: f.commit } };
    const writer = coverage.createCoverageWriter();
    for (const invalid of [{ run_id: '' }, { run_id: 'invalid' }, { workflow: '' },
      { workflow: '../undeclared.yml' }, { dispatch_head: 'short' }]) {
      assert.throws(() => writer.record({ ...input, remedy: { ...input.remedy, ...invalid } }), /remedy coverage/);
    }
    writer.record(input);
    assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: f.repo }).covered, true);
    const file = path.join(coverage.coverageRoot(), 'coverage', 'owner%2Frepo', `${f.commit}.json`);
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = fs.readFileSync(path.join(coverage.coverageRoot(), 'coverage.key'));
    for (const invalid of [{ run_id: '' }, { workflow: '../unsafe.yml' }, { dispatch_head: 'short' }]) {
      const raw = JSON.parse(JSON.stringify(original));
      Object.assign(raw.payload.remedy, invalid);
      raw.integrity.mac = crypto.createHmac('sha256', key)
        .update(stableStringify(raw.payload)).digest('hex');
      fs.writeFileSync(file, JSON.stringify(raw));
      assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: f.repo }).covered,
        false, JSON.stringify(invalid));
    }
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
      const role = kind === 'executor' ? 'executor' : 'ci-fix';
      const { digest, keyFile } = sealedReceipt(store, dispatch, 'T-43-17', 'verified', { role });
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
      const marker = coverage.rolloutMarker({ repo: 'owner/repo', worktree: f.repo });
      assert.equal(marker.repo, 'owner/repo');
      assert.equal(coverage.verify({ commit, repo: 'owner/repo', worktree: f.repo }).covered, true);
      if (kind === 'executor') {
        assert.equal(coverage.rolloutMarker({ repo: 'other/repo' }), null,
          'a project cannot inherit another project\'s rollout date');
        const otherStore = path.join(f.root, 'other-project', 'receipts');
        const otherDispatch = 'codex-other-project';
        const otherReceipt = sealedReceipt(otherStore, otherDispatch, 'T-43-17', 'verified', { role: 'executor' });
        writer.record({ ...entry, repo: 'other/repo', dispatch_id: otherDispatch,
          receipt_digest: otherReceipt.digest, receipt_store: otherStore });
        assert.equal(coverage.rolloutMarker({ repo: 'other/repo', worktree: f.repo }).repo, 'other/repo');
        assert.equal(coverage.rolloutMarker({ repo: 'owner/repo', worktree: f.repo }).recorded_at, marker.recorded_at);
      } else {
        assert.equal(coverage.rolloutMarker({ repo: 'owner/repo', worktree: f.repo }).recorded_at, firstMarker);
      }
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
        assert.throws(() => writer.record({ ...entry, verification_digest: 'b'.repeat(64) }), /signed verification/);
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

test('rejects dispatch role mismatches and binds coverage to the canonical Git repository', () => {
  const f = fixture();
  try {
    const store = path.join(f.root, 'role-mismatch', 'receipts');
    const dispatch = 'codex-wrong-role';
    const { digest } = sealedReceipt(store, dispatch, 'T-43-17', 'verified', { role: 'executor' });
    const parents = f.git('show', '-s', '--format=%P', f.commit).split(' ').filter(Boolean);
    const tree = f.git('show', '-s', '--format=%T', f.commit);
    const writer = coverage.createCoverageWriter();
    assert.throws(() => writer.record({ commit: f.commit, parents, tree, ticket: 'T-43-17', repo: 'owner/repo',
      kind: 'fixer', dispatch_id: dispatch, receipt_digest: digest, verification_digest: 'a'.repeat(64),
      receipt_store: store, worktree: f.repo }), /receipt does not match/);

    const mismatchedDispatchStore = path.join(f.root, 'dispatch-role-mismatch', 'receipts');
    const mismatchedDispatch = 'codex-mismatched-dispatch-role';
    const mismatchedReceipt = sealedReceipt(mismatchedDispatchStore, mismatchedDispatch, 'T-43-17', 'verified',
      { role: 'executor', dispatch_role: 'ci-fix' });
    assert.throws(() => writer.record({ commit: f.commit, parents, tree, ticket: 'T-43-17', repo: 'owner/repo',
      kind: 'executor', dispatch_id: mismatchedDispatch, receipt_digest: mismatchedReceipt.digest,
      verification_digest: 'a'.repeat(64), receipt_store: mismatchedDispatchStore, worktree: f.repo }), /receipt does not match/);

    const validStore = path.join(f.root, 'correct-role', 'receipts');
    const validDispatch = 'codex-valid-role';
    const validReceipt = sealedReceipt(validStore, validDispatch, 'T-43-17', 'verified', { role: 'executor' });
    writer.record({ commit: f.commit, parents, tree, ticket: 'T-43-17', repo: 'owner/repo', kind: 'executor',
      dispatch_id: validDispatch, receipt_digest: validReceipt.digest, verification_digest: 'a'.repeat(64),
      receipt_store: validStore, worktree: f.repo });
    const clone = path.join(f.root, 'clone');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', f.repo, clone]);
    assert.equal(f.git('rev-parse', 'HEAD'), execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: clone }).covered, false,
      'the same slug and commit in a separate Git repository has a different canonical identity');
    assert.equal(coverage.verify({ commit: f.commit, repo: 'owner/repo', worktree: f.repo }).covered, true);
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
    const marker = spawnSync(process.execPath, [cli, 'marker', '--repo', 'owner/repo', '--json'],
      { encoding: 'utf8', cwd: f.repo, env: process.env });
    assert.equal(marker.status, 1, 'a marker read is project scoped and missing markers stay absent');
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
