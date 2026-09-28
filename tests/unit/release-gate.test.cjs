'use strict';

const { suite, test, done, assert } = require('./assert-harness.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-live-'));
process.env.SHIPYARD_LIVE_STATE_DIR = stateDir;
process.on('exit', () => fs.rmSync(stateDir, { recursive: true, force: true }));

const liveReceipt = require('../../plugins/delivery-pipeline/scripts/live-receipt.cjs');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const RUNG = { model: 'opus', effort: 'high' };

function stages(overrides = {}) {
  return liveReceipt.REQUIRED_STAGES.map((stage) => ({
    stage, ok: true, detail: '', dispatch_id: `dd-${stage}`, role: stage,
    requested: RUNG, applied: RUNG, ...(overrides[stage] || {}),
  }));
}

function writeReceipt(tree, runtime, list, now = NOW, version = '1.2.3') {
  return liveReceipt.write({ version, tree_sha: tree, head_sha: 'h', runtime, stages: list, cli_version: 'x' }, { now });
}

function checkTree(tree, version = '1.2.3') {
  return liveReceipt.check({ version, tree_sha: tree, runtimes: ['claude', 'codex'], maxAgeDays: 7, now: NOW });
}

suite('live-receipt check');

test('both runtimes passing and fresh → ok', () => {
  writeReceipt('t-ok', 'claude', stages());
  writeReceipt('t-ok', 'codex', stages());
  const result = checkTree('t-ok');
  assert.deepStrictEqual(result, { ok: true, missing: [], stale: [], failed: [] });
});

test('non-model stages such as push pass without a rung', () => {
  const extra = [{ stage: 'push', ok: true, detail: '', requested: null, applied: null },
    { stage: 'bootstrap', ok: true, detail: '', requested: null, applied: null }];
  writeReceipt('t-push', 'claude', [...extra, ...stages()]);
  writeReceipt('t-push', 'codex', [...extra, ...stages()]);
  assert.deepStrictEqual(checkTree('t-push'), { ok: true, missing: [], stale: [], failed: [] });
});

test('one runtime missing → refused naming it', () => {
  writeReceipt('t-miss', 'claude', stages());
  const result = checkTree('t-miss');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.missing, ['codex']);
});

test('an 8-day-old receipt → stale', () => {
  writeReceipt('t-stale', 'claude', stages());
  writeReceipt('t-stale', 'codex', stages(), NOW - 8 * DAY);
  const result = checkTree('t-stale');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.stale, ['codex']);
});

test('a failed stage → failed', () => {
  writeReceipt('t-fail', 'claude', stages({ publish: { ok: false, detail: 'hygiene' } }));
  writeReceipt('t-fail', 'codex', stages());
  const result = checkTree('t-fail');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.failed.map((f) => f.runtime), ['claude']);
});

test('applied rung differing from requested → failed', () => {
  writeReceipt('t-rung', 'claude', stages());
  writeReceipt('t-rung', 'codex', stages({ executor: { applied: { model: 'haiku', effort: 'low' } } }));
  const result = checkTree('t-rung');
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.failed.map((f) => f.runtime), ['codex']);
});

test('receipt missing the sentinel stage → failed', () => {
  writeReceipt('t-nosent', 'claude', stages().filter((s) => s.stage !== 'sentinel'));
  writeReceipt('t-nosent', 'codex', stages());
  const result = checkTree('t-nosent');
  assert.strictEqual(result.ok, false);
  assert.ok(result.failed[0].reasons.includes('missing stage sentinel'));
});

test('a receipt for another tree sha is ignored', () => {
  writeReceipt('t-other', 'claude', stages());
  writeReceipt('t-other', 'codex', stages());
  const result = checkTree('t-mine');
  assert.deepStrictEqual(result.missing, ['claude', 'codex']);
});

suite('release.sh');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function copyInto(root, rel) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(REPO, rel), dest);
}

test('refuses without receipts and tags with them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-release-'));
  try {
    for (const rel of ['scripts/release.sh', 'plugins/delivery-pipeline/scripts/live-receipt.cjs', 'plugins/delivery-pipeline/scripts/lock.cjs']) {
      copyInto(root, rel);
    }
    fs.mkdirSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'), '{"version":"9.9.9"}\n');
    fs.mkdirSync(path.join(root, 'tests/smoke'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/smoke/release-notes-smoke.sh'), '#!/usr/bin/env bash\nexit 0\n');
    git(root, ['init', '-q']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'tag.gpgsign', 'false']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    const env = { ...process.env, SHIPYARD_LIVE_STATE_DIR: stateDir };
    const run = (version) => spawnSync('bash', ['scripts/release.sh', version], { cwd: root, env, encoding: 'utf8' });

    const wrongVersion = run('1.0.0');
    assert.notStrictEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /differs from plugin\.json/);

    const refused = run('9.9.9');
    assert.notStrictEqual(refused.status, 0, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /live-round\.sh --runtime claude/);
    assert.match(refused.stderr, /live-round\.sh --runtime codex/);
    assert.throws(() => git(root, ['rev-parse', '-q', '--verify', 'refs/tags/v9.9.9']));

    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    writeReceipt(tree, 'claude', stages(), Date.now(), '9.9.9');
    writeReceipt(tree, 'codex', stages(), Date.now(), '9.9.9');
    const tagged = run('9.9.9');
    assert.strictEqual(tagged.status, 0, tagged.stdout + tagged.stderr);
    assert.match(tagged.stdout, /git push origin v9\.9\.9/);
    assert.strictEqual(git(root, ['cat-file', '-t', 'v9.9.9']), 'tag');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the live round checks the Codex home it was pointed at', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'live', 'live-round.sh'), 'utf8');
  assert.match(script, /doctor_args=\(--codex-home "\$CODEX_HOME"\)/);
  assert.match(script, /shipyard-doctor\.cjs" \$\{doctor_args\[@\]\+"\$\{doctor_args\[@\]\}"\}/);
});

done();
