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
test('historical HOLD selection supplies no current publication or installed credit', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/audits/phase49-final-review-acceptance.json')));
  if (!fs.existsSync(ledger.candidate.selection.path)) return t.skip('original historical selection unavailable');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-historical-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ledger.benchmark.authority.store = path.join(root, 'unavailable-receipts');
  const report = verifyEvidence(ledger);
  const publication = report.verified.find(row => row.name === 'immutable-publication').evidence;
  assert.equal(publication.historical_only, true);
  assert.equal(publication.complete_publication, false);
  assert.equal(publication.installed, false);
  assert.equal(publication.empirical_acceptance, false);
  assert.equal(report.status, 'hold');
  assert.equal(report.empirical_acceptance, false);
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


test('complete canonical inventory includes scripts beyond the former fixed nine', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { sourceInputs } = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-full-scripts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('config', 'commit.gpgsign', 'false');
  git('config', 'user.name', 'Isolated fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/package-shipyard-codex.cjs'), 'builder');
  fs.writeFileSync(path.join(root, 'scripts/additional-canonical.cjs'), 'required');
  git('add', '.'); git('commit', '-m', 'isolated complete script inventory');
  assert.deepEqual(sourceInputs(root, git('rev-parse', 'HEAD')).map(row => row.path),
    ['scripts/additional-canonical.cjs', 'scripts/package-shipyard-codex.cjs']);
});

test('completed physical accounting refuses caller authority and extra selector fields', () => {
  const { observeCompletedConsumption } = require('../smoke/phase49-final-review-acceptance.cjs');
  for (const selectors of [{}, { worktree: '/', progress: {}, receipt_store: '/', dispatch_id: 'x', successful_reads: 1 },
    { prepared: {}, native: {}, offsets: [0] }]) assert.throws(() => observeCompletedConsumption(selectors));
});


test('complete independently verified matrix has a functional decision path with fixture provenance retained', () => {
  const runner = require('../smoke/phase49-final-review-acceptance.cjs');
  assert.equal(typeof runner.aggregateMatrix, 'function');
  assert.equal(typeof runner.verifyCapacityReference, 'function');
  assert.equal(typeof runner.verifyFocusedObservations, 'function');
  assert.equal(typeof runner.verifyOriginalReads, 'function');
  const value = fixture();
  const decision = runner.aggregateMatrix(value, 'fixture-only');
  assert.equal(decision.status, 'fixture-pass');
  assert.equal(decision.empirical_acceptance, false);
  assert.throws(() => runner.aggregateMatrix(value, 'native'), /private verified matrix/);
});


function aggregationFixture() {
  const source = fixture();
  return { subject: source.subject, benchmark: { successful_reads: 830, material_bytes: 6530992 },
    installed: { installed: true, selection_sha256: source.subject.candidate },
    capacity: [clone(source.capacity), clone(source.capacity)],
    observations: ['arch-review', 'integrator'].flatMap(role => [...source.checks, 'hidden-delta'].map(kind => ({ role, kind }))),
    traces: source.traces.map(trace => ({ role: trace.role, native_trace_verified: true,
      verdict: { authenticated: true, dispatch_id: trace.final.dispatch },
      lineage: { mode: 'incremental', baseline: { role: trace.role, dispatch_id: trace.baseline.dispatch }, limitations: [] },
      equivalent: { complete: true, original_digest: 'd'.repeat(64) }, contributors: [{ other_contributor: true }],
      physical: { attempts: [
        { status: 'interrupted', dispatch_id: trace.continuation.original_dispatch, session_id: trace.continuation.original_session, turn_id: 'old' },
        { status: 'completed', dispatch_id: trace.final.dispatch, session_id: trace.continuation.resumed_session, turn_id: 'new' }],
        coverage: { prefix: { successful_reads: 2 }, new: { successful_reads: 50 } } },
      metrics: trace.metrics, baseline_setup: { metrics: trace.baseline_setup } })) };
}
test('complete aggregation uses the native decision checks under explicit fixture-only provenance', () => {
  const { aggregateMatrix } = require('../smoke/phase49-final-review-acceptance.cjs');
  assert.deepEqual(aggregateMatrix(aggregationFixture(), 'fixture-only'),
    { status: 'fixture-pass', empirical_acceptance: false, holds: [] });
  assert.throws(() => aggregateMatrix(aggregationFixture(), 'native'), /private verified matrix/);
  const missing = aggregationFixture(); missing.traces[0].metrics.successful_reads = metric(null, 'original unavailable');
  const result = aggregateMatrix(missing, 'fixture-only');
  assert.equal(result.status, 'hold'); assert.equal(result.empirical_acceptance, false);
});
for (const [name, mutate] of Object.entries({
  'installed selection substitution': v => v.installed.selection_sha256 = 'f'.repeat(64),
  'missing physical original capacity': v => v.capacity.pop(),
  'truncated first probe': v => v.capacity[0].complete = false,
  'borrowed semantic session': v => v.traces[1].physical.attempts[0].session_id = v.traces[0].physical.attempts[0].session_id,
  'missing hidden contributor observation': v => v.observations.pop(),
  'missing independent baseline': v => v.traces[1].lineage.baseline.dispatch_id = v.traces[0].lineage.baseline.dispatch_id,
  'missing eligible setup cost': v => v.traces[0].baseline_setup.metrics = null,
  'non-equivalent original content': v => v.traces[1].equivalent.original_digest = 'f'.repeat(64),
  'unverified original obligations': v => v.traces[0].equivalent.complete = false,
  'copied verdict success label': v => v.traces[0].verdict.authenticated = false,
  'missing authenticated contributor repair': v => v.traces[0].contributors = [],
  'uncredited successful call hidden': v => v.traces[0].metrics.successful_reads.value = 2,
  'target exceeded': v => v.traces[0].metrics.successful_reads.value = 84,
  'replayed completed dispatch': v => v.traces[0].physical.attempts[1].dispatch_id = 'baseline',
  'missing interruption': v => v.traces[0].physical.attempts[0].status = 'completed',
})) test('aggregation refuses ' + name, () => {
  const { aggregateMatrix } = require('../smoke/phase49-final-review-acceptance.cjs');
  const value = aggregationFixture(); mutate(value);
  assert.throws(() => aggregateMatrix(value, 'fixture-only'));
});

test('read-only original envelope observer derives complete costs and rejects tampering', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-original-observer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
  const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'commit.gpgsign', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(worktree, 'source.txt'), 'fixture'); git('add', '.'); git('commit', '-m', 'isolated fixture');
  const prepared = context.prepareFileInput({ worktree, ticket: 'T-49-11', phase: 49, run_id: 'isolated' },
    JSON.stringify({ fixture_only: true, content: 'x'.repeat(131072) }), { role: 'research', dispatchId: 'fixture-original', storageRoot: path.join(root, 'inputs') });
  const checked = context.verifyFileInput(prepared);
  const nativeTemplate = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-parent.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const cliTemplate = fs.readFileSync(path.join(__dirname, '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).filter(row => row.type);
  const pick = predicate => clone(nativeTemplate.find(predicate));
  const session = 'isolated-fixture-session-00000001', result = '{"fixture_only":true}', turn = 'fixture-turn';
  const meta = pick(row => row.type === 'session_meta'); meta.payload.id = session; meta.payload.session_id = session;
  const selection = pick(row => row.type === 'turn_context'); selection.payload.model = 'fixture-model'; selection.payload.effort = 'low';
  const start = pick(row => row.payload?.type === 'task_started'); start.payload.turn_id = turn;
  const final = pick(row => row.payload?.role === 'assistant' && row.payload.phase === 'final_answer');
  final.payload.content = [{ type: 'output_text', text: result }];
  const end = pick(row => row.payload?.type === 'task_complete'); end.payload.turn_id = turn; end.payload.last_agent_message = result;
  const call = pick(row => row.payload?.type === 'function_call'), output = pick(row => row.payload?.type === 'function_call_output');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const rows = [meta, selection, start]; let ordinal = 0;
  for (const asset of [{ path: prepared.input_bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, i) => ({ path: asset.path, bytes: checked.material[i] }))]) {
    for (let offset = 0; offset < asset.bytes.length; offset += 8192) {
      const input = clone(call), response = clone(output), id = 'fixture-call-' + ordinal++;
      input.payload.name = 'exec_command'; input.payload.call_id = id;
      input.payload.internal_chat_message_metadata_passthrough = { turn_id: turn };
      input.payload.arguments = JSON.stringify({ cmd: 'dd if=' + quote(asset.path) + ' bs=8192 skip=' + (offset / 8192) + ' count=1 2>/dev/null | base64' });
      response.payload.call_id = id;
      response.payload.output = JSON.stringify({ exit_code: 0, output: asset.bytes.subarray(offset, offset + 8192).toString('base64') });
      rows.push(input, response);
    }
  }
  rows.push(final, end);
  rows.forEach((row, i) => row.timestamp = new Date(1700000000000 + i).toISOString());
  for (const row of cliTemplate) {
    if (row.type === 'thread.started') row.thread_id = session;
    if (row.item?.type === 'agent_message') row.item.text = result;
  }
  const write = (name, rows) => {
    const file = path.join(root, name); const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  const native = write('native.jsonl', rows), transcript = write('cli.jsonl', cliTemplate);
  const record = { dispatch_id: 'fixture-original', receipt: { role: 'research', applied_model: 'fixture-model', applied_effort: 'low',
    runtime_evidence: { input_bundle: prepared.input_bundle, transcript,
      native_session_evidence: { session_id: session, sha256: native.sha256, bytes: native.bytes, file: path.basename(native.path) } } } };
  const observed = acceptance.verifyOriginalReads(record, native);
  assert.equal(observed.metrics.successful_reads.value, checked.chunk_reads);
  assert.equal(observed.metrics.raw_bytes.value, checked.manifest_bytes.length + checked.material[0].length);
  assert.equal(observed.metrics.failed_calls.value, 0); assert.equal(observed.metrics.retries.value, 0);
  assert.equal(observed.metrics.tokens.value, null); assert.equal(observed.metrics.elapsed_ms.value, rows.length - 3);
  assert.equal(observed.full_128k_ranges, 0);
  assert.equal(acceptance.verifyFixture(authority(fixture())).empirical_acceptance, false);
  // Preserve the registered native shapes; the observer sees the real nested object contract.
  const wrapped = [clone(meta), clone(selection), clone(start)]; let wrappedOrdinal = 0;
  for (const asset of [{ path: prepared.input_bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, i) => ({ path: asset.path, bytes: checked.material[i] }))]) {
    for (let offset = 0; offset < asset.bytes.length; offset += 131072) {
      const input = clone(call), response = clone(output), id = 'wrapped-fixture-' + wrappedOrdinal++;
      input.payload.type = 'custom_tool_call'; input.payload.name = 'exec'; input.payload.call_id = id;
      delete input.payload.arguments;
      input.payload.input = 'text(await tools.exec_command(' + JSON.stringify({
        cmd: 'dd if=' + quote(asset.path) + ' bs=131072 skip=' + (offset / 131072) + ' count=1 2>/dev/null | base64',
        max_output_tokens: 10000 }) + '))';
      input.payload.internal_chat_message_metadata_passthrough = { turn_id: turn };
      response.payload.type = 'custom_tool_call_output'; response.payload.call_id = id;
      const encoded = asset.bytes.subarray(offset, offset + 131072).toString('base64').match(/.{1,76}/g).join('\n') + '\n';
      response.payload.output = [{ type: 'text', text: 'Script completed\nWall time 0.01 seconds\nOutput:\n' },
        { type: 'text', text: JSON.stringify({ exit_code: 0, output: encoded }) }];
      wrapped.push(input, response);
    }
  }
  wrapped.push(clone(final), clone(end));
  wrapped.forEach((row, i) => row.timestamp = new Date(1700000000000 + i).toISOString());
  const wrappedNative = write('wrapped.jsonl', wrapped);
  const wrappedRecord = clone(record); wrappedRecord.receipt.runtime_evidence.native_session_evidence = {
    session_id: session, sha256: wrappedNative.sha256, bytes: wrappedNative.bytes, file: path.basename(wrappedNative.path) };
  const capacity = acceptance.verifyOriginalReads(wrappedRecord, wrappedNative, 131072);
  assert.equal(capacity.full_128k_ranges, 1);
  assert.equal(capacity.metrics.successful_reads.value, wrappedOrdinal);
  assert(capacity.largest_envelope_bytes > 131072 * 4 / 3);
  assert.equal(capacity.metrics.encoded_bytes.value, wrapped.filter(row => row.payload?.type === 'custom_tool_call_output')
    .reduce((sum, row) => sum + Buffer.byteLength(JSON.parse(row.payload.output[1].text).output), 0));
  const retried = clone(wrapped), failedInput = clone(wrapped[3]), failedOutput = clone(wrapped[4]);
  failedInput.payload.call_id = 'failed-fixture-call'; failedOutput.payload.call_id = 'failed-fixture-call';
  failedOutput.payload.output[1].text = JSON.stringify({ exit_code: 1, output: 'original failure' });
  retried.splice(3, 0, failedInput, failedOutput);
  retried.forEach((row, i) => row.timestamp = new Date(1700000000000 + i).toISOString());
  const retriedNative = write('retried.jsonl', retried);
  wrappedRecord.receipt.runtime_evidence.native_session_evidence = { session_id: session,
    sha256: retriedNative.sha256, bytes: retriedNative.bytes, file: path.basename(retriedNative.path) };
  const retriedCosts = acceptance.verifyOriginalReads(wrappedRecord, retriedNative, 131072);
  assert.equal(retriedCosts.metrics.successful_reads.value, wrappedOrdinal);
  assert.equal(retriedCosts.metrics.failed_calls.value, 1); assert.equal(retriedCosts.metrics.retries.value, 1);
  assert.equal(retriedCosts.metrics.raw_bytes.value, capacity.metrics.raw_bytes.value);
  assert(retriedCosts.metrics.nested_output_bytes.value > capacity.metrics.nested_output_bytes.value);
  assert(retriedCosts.metrics.outer_output_bytes.value > capacity.metrics.outer_output_bytes.value);
  const unsupported = clone(wrapped); unsupported[4].payload.output[1].text = '[' + unsupported[4].payload.output[1].text + ']';
  const unsupportedNative = write('unsupported.jsonl', unsupported);
  wrappedRecord.receipt.runtime_evidence.native_session_evidence = { session_id: session,
    sha256: unsupportedNative.sha256, bytes: unsupportedNative.bytes, file: path.basename(unsupportedNative.path) };
  assert.throws(() => acceptance.verifyOriginalReads(wrappedRecord, unsupportedNative, 131072), /unsupported nested output/);
  const changed = clone(rows); changed[4].payload.output = JSON.stringify({ exit_code: 0, output: 'truncated' });
  const changedNative = write('native.jsonl', changed);
  record.receipt.runtime_evidence.native_session_evidence.sha256 = changedNative.sha256;
  record.receipt.runtime_evidence.native_session_evidence.bytes = changedNative.bytes;
  assert.throws(() => acceptance.verifyOriginalReads(record, changedNative), /truncated or altered/);
  assert.throws(() => runtime.verifyFileConsumption({ input_bundle: prepared.input_bundle }, '', 'fixture-original', result), /private producer authority/);
});


test('original logical inventory retains duplicate purposes and complete source provenance', () => {
  const { logicalInventory } = require('../smoke/phase49-final-review-acceptance.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const content = 'complete original source';
  const row = { path: 'source/a.cjs', sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), content };
  const packet = { source_revision: 'a'.repeat(40), refs: [row], required_refs: [row], retained_evidence: { content } };
  const inventory = value => logicalInventory({ material: [Buffer.from(JSON.stringify(value))] });
  const original = inventory(packet);
  assert.equal(original.length, 3);
  assert.deepEqual(inventory(packets.encodeUniqueContent(packet)), original);
  assert.equal(new Set(original).size, original.length, 'one physical dictionary member retains all logical purposes');
  const changed = clone(packet); changed.source_revision = 'b'.repeat(40);
  assert.notDeepEqual(inventory(changed), original, 'source revision cannot be silently replaced');
  const omitted = clone(packet); delete omitted.retained_evidence;
  assert.equal(inventory(omitted).length, 2, 'retained original evidence is a separate required obligation');
});


test('finite batch aggregation retains fixture provenance and requires measured role-bound capacity', () => {
  const { aggregateMatrix } = require('../smoke/phase49-final-review-acceptance.cjs');
  const value = aggregationFixture();
  value.capacity = value.traces.map(trace => ({ schema: 'shipyard.native-reader-capacity.v3',
    role: trace.role, candidate: value.subject.candidate, policy: value.subject.policy,
    complete: true, physical_calls: 52, logical_ranges: 830, profile_sha256: 'a'.repeat(64),
    observed_encoded_bytes: 9999, required_encoded_bytes: 9999 }));
  assert.equal(aggregateMatrix(value, 'fixture-only').status, 'fixture-pass');
  assert.equal(aggregateMatrix(value, 'fixture-only').empirical_acceptance, false);
  for (const mutate of [v => v.capacity[0].complete = false,
    v => v.capacity[1].role = 'arch-review', v => v.capacity[0].candidate = 'f'.repeat(64),
    v => v.capacity[0].physical_calls = 84, v => v.capacity[0].logical_ranges = null,
    v => v.capacity[0].observed_encoded_bytes--]) {
    const altered = clone(value); mutate(altered);
    assert.throws(() => aggregateMatrix(altered, 'fixture-only'));
  }
});
