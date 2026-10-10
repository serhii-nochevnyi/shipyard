'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyFixture, validateTrace, metric, SCHEMA } = require('../smoke/phase49-final-review-acceptance.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const subject = { head: 'a'.repeat(40), base: 'b'.repeat(40), merge_base: 'c'.repeat(40),
    ticket_set: ['T-49-01', 'T-49-11'], policy: 'd'.repeat(64), candidate: 'e'.repeat(64), runtime: 'codex', provider: 'openai' };
  const trace = { role: 'arch-review', subject, baseline: { dispatch: 'baseline', role: 'arch-review', success: true },
    final: { dispatch: 'final', fresh: true, success: true }, contributor_delta: ['other:src/a', 'coordinator:src/b'],
    required_delta: ['other:src/a', 'coordinator:src/b'], required: ['a', 'b', 'c'], inherited: ['a'], reviewed: ['b', 'c'],
    affected: ['b', 'c'], limitations: [], mode: 'incremental', assumptions_valid: true,
    continuation: { original_session: 'session', resumed_session: 'session', original_dispatch: 'interrupted',
      final_dispatch: 'final', interrupted: true, fresh_final: true, credited: [0, 1], resumed: [2, 3], required_ranges: 4 },
    metrics: { successful_reads: metric(52), scheduled_reads: metric(52), failed_calls: metric(1), retries: metric(1),
      raw_bytes: metric(6530992), encoded_bytes: metric(8707992), elapsed_ms: metric(10), tokens: metric(null, 'not exposed') },
    baseline_setup: { successful_reads: metric(830), tokens: metric(null, 'not exposed') } };
  return { schema: SCHEMA, subject, benchmark: { material_bytes: 6530992, successful_reads: 830,
    complete: true, obligations: ['a', 'b', 'c'] }, capacity: { block_bytes: 131072, complete: true,
    observed_encoded_bytes: 183460, required_encoded_bytes: 183460 }, traces: [trace,
      { ...clone(trace), role: 'integrator', baseline: { dispatch: 'integration-baseline', role: 'integrator', success: true },
        final: { dispatch: 'integration-final', fresh: true, success: true },
        continuation: { ...trace.continuation, original_dispatch: 'integration-interrupted', final_dispatch: 'integration-final',
          original_session: 'integration-session', resumed_session: 'integration-session' } }],
    checks: ['full-fallback', 'changed-base-expansion', 'shared-contract-expansion', 'forged', 'stale', 'truncated', 'replay'],
    history: [{ dispatch: 'interrupted', status: 'interrupted' }, { dispatch: 'failed', status: 'failed' }] };
}
function authority(value) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, publicKey, signature: crypto.sign(null, bytes, privateKey) };
}
test('authenticated isolated complete trace admits both independent roles', () => {
  const value = fixture();
  assert.equal(verifyFixture(authority(value)).status, 'fixture-pass');
});
for (const [name, mutate] of Object.entries({
  'hidden contributor': v => v.traces[0].contributor_delta.pop(),
  'truncated coverage': v => v.traces[0].reviewed.pop(),
  'duplicate credit': v => v.traces[0].continuation.resumed.unshift(1),
  'foreign session': v => v.traces[0].continuation.resumed_session = 'foreign',
  'stale subject': v => v.traces[0].subject.head = 'f'.repeat(40),
  'role borrowing': v => v.traces[0].baseline.role = 'integrator',
  'replayed final': v => v.traces[0].final.dispatch = 'baseline',
  'fabricated counter': v => v.traces[0].metrics.successful_reads.value = 1.5,
  'missing null reason': v => v.traces[0].metrics.tokens.reason = null,
  'substitute 864': v => v.benchmark.successful_reads = 864,
  'insufficient capacity': v => v.capacity.observed_encoded_bytes--,
  'missing refusal': v => v.checks.pop(),
  'rewritten failed history': v => v.history[1].status = 'passed',
  'unsupported inherited assumptions': v => v.traces[0].assumptions_valid = false,
})) test('refuses ' + name, () => {
  const value = fixture(); mutate(value); assert.throws(() => verifyFixture(authority(value)));
});
test('signature tamper and foreign authority refuse', () => {
  const sealed = authority(fixture()); sealed.bytes = Buffer.concat([sealed.bytes, Buffer.from(' ')]);
  assert.throws(() => verifyFixture(sealed));
  const foreign = authority(fixture()); foreign.publicKey = authority(fixture()).publicKey;
  assert.throws(() => verifyFixture(foreign));
});
test('full fallback requires all material newly reviewed and no inherited credit', () => {
  const value = fixture(), trace = value.traces[0]; trace.mode = 'full'; trace.assumptions_valid = false;
  trace.inherited = []; trace.reviewed = trace.required.slice();
  validateTrace(trace, value.subject);
  trace.inherited = ['a']; assert.throws(() => validateTrace(trace, value.subject));
});
test('unknown observed calls hold instead of substituting schedule', () => {
  const value = fixture(); value.traces[0].metrics.successful_reads = metric(null, 'not observed');
  assert.equal(verifyFixture(authority(value)).status, 'hold');
});

test('original protected boundary fixture is admitted read-only and altered receipt or transcript refuses', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-acceptance-authority-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const store = path.join(root, 'receipts'), transcript = path.join(root, 'original.jsonl');
  fs.writeFileSync(transcript, '{"fixture":true}\n');
  const bytes = fs.readFileSync(transcript);
  const recorder = boundaryModule.createDurableRecorder(store);
  const content = 'isolated fixture agent';
  const adapter = {
    validateGeneratedAgent: resolution => ({ valid: true, exists: true, content_verified: true,
      policy_hash: resolution.policy_hash, agent_file: resolution.agent_file,
      agent_file_digest: hash(content), agent_file_content: content }),
    launchStatic: resolution => ({ receipt_type: 'adr-014.application', runtime: 'codex', role: resolution.role,
      dispatch_id: resolution.dispatch_id, launch_id: 'fixture-' + resolution.dispatch_id,
      requested_model: resolution.model, requested_effort: resolution.effort,
      applied_model: resolution.model, applied_effort: resolution.effort,
      observed_model: resolution.model, observed_effort: resolution.effort,
      agent_file: resolution.agent_file, agent_file_digest: resolution.agent_file_digest,
      policy_hash: resolution.policy_hash, runtime_evidence: { transcript: { path: transcript, bytes: bytes.length, sha256: hash(bytes) } } }),
  };
  const boundary = boundaryModule.createDispatchBoundary({ recorder, adapters: { codex: adapter }, cwd: root });
  boundary.dispatch({ runtime: 'codex', role: 'research', dispatch_id: 'isolated-original' }, { ticket: 'fixture' });
  const ref = { store, dispatch: 'isolated-original' };
  const names = fs.readdirSync(root).sort();
  assert.equal(acceptance.verifiedRecord(ref).receipt.compliance, 'verified');
  assert.deepEqual(fs.readdirSync(root).sort(), names);
  fs.appendFileSync(transcript, 'truncated/changed');
  assert.throws(() => acceptance.verifiedRecord(ref), /altered original/);
  fs.writeFileSync(transcript, bytes);
  const file = path.join(store, 'record-' + hash(ref.dispatch) + '.json');
  const record = JSON.parse(fs.readFileSync(file)); record.payload.receipt.launch_id = 'forged';
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => acceptance.verifiedRecord(ref), /tampered/);
});
test('production pending ledger refuses invented counters, fixture admission and completion labels', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/audits/phase49-final-review-acceptance.json')));
  for (const mutate of [v => v.status = 'passed', v => v.empirical_acceptance = true,
    v => v.fixture_evidence = true, v => v.metrics.successful_reads = metric(52),
    v => v.candidate.installed_identity = { installed: true }, v => v.benchmark.observed_successful_reads = 864]) {
    const value = clone(ledger); mutate(value); assert.throws(() => verifyEvidence(value));
  }
});
test('isolated unavailable originals validate an honest HOLD without writes or native launches', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-hold-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/audits/phase49-final-review-acceptance.json')));
  ledger.benchmark.authority.store = path.join(root, 'unavailable-receipts');
  ledger.candidate.selection.path = path.join(root, 'unavailable-selection.json');
  const report = verifyEvidence(ledger);
  assert.equal(report.status, 'hold'); assert.equal(report.empirical_acceptance, false);
  assert.equal(report.verified.length, 0);
  assert(report.holds.some(reason => reason.includes('original-benchmark')));
  assert.deepEqual(fs.readdirSync(root), []);
});
test('explicit-path read-only mode refuses unsupported launch switches and changed or symlinked originals', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { original, main } = require('../smoke/phase49-final-review-acceptance.cjs');
  for (const argv of [[], ['--verify-evidence'], ['--native', 'anything'], ['--verify-evidence', 'x', '--native']])
    assert.throws(() => main(argv), /usage/);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-original-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'original.json'); fs.writeFileSync(file, '{}');
  const ref = { path: file, sha256: crypto.createHash('sha256').update('{}').digest('hex'), bytes: 2 };
  assert.equal(original(ref).toString(), '{}');
  fs.writeFileSync(file, '{"changed":true}'); assert.throws(() => original(ref), /altered original/);
  fs.writeFileSync(file, '{}');
  const alias = path.join(root, 'alias.json'); fs.symlinkSync(file, alias);
  assert.throws(() => original({ ...ref, path: alias }), /symlinked/);
  fs.truncateSync(file, 128 * 1024 * 1024 + 1); assert.throws(() => original(ref), /bounded regular/);
});

test('current preparation admits a new plan identity without relabeling the historical HOLD', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-current-hold-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/audits/phase49-final-review-acceptance.json')));
  ledger.plan_sha256 = 'a6e2b6805cbe54f62c065a0d471a94f8517244170f177ed452987e2d1b6d3034';
  ledger.candidate.expected = { selection_sha256: '9'.repeat(64), head: '8'.repeat(40), tree: '7'.repeat(40) };
  ledger.candidate.selection = { path: path.join(root, 'selection.json'), sha256: '9'.repeat(64) };
  ledger.benchmark.authority.store = path.join(root, 'receipts');
  const report = verifyEvidence(ledger);
  assert.equal(report.status, 'hold');
  assert.equal(report.historical_only, false);
  assert.equal(report.empirical_acceptance, false);
  assert(report.holds.some(reason => reason.includes('immutable-publication')));
  assert.deepEqual(fs.readdirSync(root), []);
});
test('historical plan cannot authenticate a substituted historical selection', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/audits/phase49-final-review-acceptance.json')));
  ledger.candidate.expected.head = 'f'.repeat(40);
  assert.throws(() => verifyEvidence(ledger), /historical source/);
});


test('current installed evidence is independently inspected instead of requiring installed-null', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-installed-hold-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/audits/phase49-final-review-acceptance.json')));
  ledger.plan_sha256 = 'a6e2b6805cbe54f62c065a0d471a94f8517244170f177ed452987e2d1b6d3034';
  ledger.candidate.selection.path = path.join(root, 'selection.json');
  ledger.benchmark.authority.store = path.join(root, 'receipts');
  ledger.candidate.installed_identity = { package_root: path.join(root, 'package') };
  const report = verifyEvidence(ledger);
  assert.equal(report.status, 'hold');
  assert(report.holds.some(reason => reason.includes('installed-candidate')));
  assert.equal(report.empirical_acceptance, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('source equivalence compares complete canonical inventories including modes and additions', () => {
  const { compareCanonicalInputs } = require('../smoke/phase49-final-review-acceptance.cjs');
  const rows = [{ path: 'scripts/package-shipyard-codex.cjs', sha256: 'a'.repeat(64), mode: 0o755, bytes: 12 }];
  assert.equal(compareCanonicalInputs(rows, clone(rows)), true);
  for (const mutate of [v => v[0].mode = 0o644, v => v[0].sha256 = 'b'.repeat(64), v => v[0].bytes++,
    v => v.push({ ...v[0], path: 'scripts/added.cjs' }), v => v.push(v[0]), v => v[0].path = '../escape']) {
    const changed = clone(rows); mutate(changed);
    assert.throws(() => compareCanonicalInputs(rows, changed));
  }
});

test('serialized input and caller progress cannot mint retrospective private reader authority', () => {
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  assert.throws(() => context.verifyFileInput({ input_bundle: {} }), /private producer authority/);
  assert.throws(() => context.restoreReviewInput({ state: { resume: { status: 'completed' } } }), /protected authority/);
});


test('immutable source inventory includes added canonical inputs and excludes test-only repairs', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { sourceInputs, compareCanonicalInputs } = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-source-inputs-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('config', 'commit.gpgsign', 'false'); git('config', 'user.name', 'Isolated fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const directory of ['scripts', 'tests', 'plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const name of ['package-shipyard-codex.cjs', 'bootstrap-shipyard-plugin.cjs', 'ensure-gsd-plugin.cjs',
    'ensure-gsd-core.sh', 'install-shipyard-codex.sh', 'install-shipyard-capability.sh', 'gen-codex-shipyard.cjs',
    'merge-codex-config.cjs', 'configure-codex-notify.cjs']) fs.writeFileSync(path.join(root, 'scripts', name), name);
  fs.writeFileSync(path.join(root, 'plugins/delivery-pipeline/consumer.cjs'), 'original');
  git('add', '.'); git('commit', '-m', 'original isolated source');
  const baseline = sourceInputs(root, git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(root, 'tests/repair.cjs'), 'isolated repair');
  git('add', '.'); git('commit', '-m', 'excluded test repair');
  assert.equal(compareCanonicalInputs(baseline, sourceInputs(root, git('rev-parse', 'HEAD'))), true);
  fs.writeFileSync(path.join(root, 'capabilities/delivery-pipeline/added.cjs'), 'new required input');
  git('add', '.'); git('commit', '-m', 'added canonical input');
  assert.throws(() => compareCanonicalInputs(baseline, sourceInputs(root, git('rev-parse', 'HEAD'))), /equivalence/);
  fs.unlinkSync(path.join(root, 'capabilities/delivery-pipeline/added.cjs'));
  git('add', '-u'); git('update-index', '--chmod=+x', 'plugins/delivery-pipeline/consumer.cjs');
  git('commit', '-m', 'canonical mode change');
  assert.throws(() => compareCanonicalInputs(baseline, sourceInputs(root, git('rev-parse', 'HEAD'))), /equivalence/);
  fs.unlinkSync(path.join(root, 'plugins/delivery-pipeline/consumer.cjs'));
  git('add', '-u'); git('commit', '-m', 'removed canonical input');
  assert.throws(() => compareCanonicalInputs(baseline, sourceInputs(root, git('rev-parse', 'HEAD'))), /equivalence/);
});
