'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyFixture, validateTrace, metric, SCHEMA } = require('../smoke/phase49-final-review-acceptance.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const historicalLedger = () => ({
  "schema": "shipyard.phase49.final-review-acceptance.v1",
  "ticket": "T-49-11",
  "plan_sha256": "3328a4c25ae4f451a6f8dcbe01b0164260f31bf294ea33e70877795ae24380e1",
  "status": "hold",
  "empirical_acceptance": false,
  "fixture_evidence": false,
  "subject_observation": {
    "parent_head": "17e38e440d8626f00002f3a33e7136fe893bcbd5",
    "parent_tree": "dc5464682abdab8834a1090568a4c53a21b1288d",
    "current_native_subject": null,
    "reason": "Trusted coordinator must pin actual treatment HEAD/base/merge-base/full membership before launch and admission."
  },
  "benchmark": {
    "coordinator_status": "authenticated-original-historical-benchmark",
    "material_bytes": 6530992,
    "observed_successful_reads": 830,
    "manifest_bytes": 254494,
    "authority": {
      "store": "/Users/serhii/.local/state/shipyard/codex/8c79ca16f40abbef3fbfd987a60d54ca44d1258966d76cdc04a1eab04e4fb2b9/receipts",
      "dispatch": "dispatch-muzom0nn-78fe1c5c-db9d-417f-a1b6-fb221743d9c5"
    },
    "assessment": {
      "path": "/Users/serhii/.local/state/shipyard/phase49-original-830-verified-authority.json",
      "sha256": "7ea5c4c54f04a3b6c976c6a3050f79f9b8884b03635a6f1e74bfe954fb203790"
    },
    "manifest": {
      "path": "/Users/serhii/.local/state/shipyard/codex/8c79ca16f40abbef3fbfd987a60d54ca44d1258966d76cdc04a1eab04e4fb2b9/input-B3jIH0/manifest.json",
      "sha256": "a7a8f430bf055bb3336b18a561c9b00a30448b83b4e1453a51ee0b039dc5a20e"
    },
    "material_sha256": "f0f59f70ccef33f48dad09608443cc9cd9df5f07e6568e2aa4cd56c7ac57bf3b",
    "transcript": {
      "path": "/Users/serhii/.local/state/shipyard/codex/8c79ca16f40abbef3fbfd987a60d54ca44d1258966d76cdc04a1eab04e4fb2b9/transcripts/deliver-R2-final27-arch-retry-f4cb450b-6fff-46b2-9e96-e5b02c1ff677-01a11c18-aa81-7842-a5de-6b7f6cf48271.jsonl",
      "bytes": 11376658,
      "sha256": "16547079674515090828a9b3ae61c6e3d9a30b12d9c781b17412c057a4efe025"
    },
    "native_session_sha256": "2723ae13d2257b9a317e33a461b6b66346620065572f91159d3f3823ee46aa97",
    "historical_subject": {
      "pr": 421,
      "head": "265110621c8097a83867a9e9dd7958c0e7830cb2",
      "base": "7eebae4812b3c67ccdbbb63c8c1603f7767b1466",
      "ticket_set_digest": "852213d91329315d8156df00997666a917c5fee50ed7162f28357b81621da5fb"
    },
    "current_verdict": false
  },
  "distinct_later_packet": {
    "material_bytes": 6813351,
    "scheduled_reads": 864,
    "observed_successful_reads": null,
    "reason": "Distinct historical packet; never substitutes for selected original authority."
  },
  "candidate": {
    "selection": {
      "path": "/Users/serhii/.local/state/shipyard/phase49-selected-package-bd18893c6948/selection.json",
      "sha256": "b09e4ab44ee00bd8600fb34774994a37e46dc2c98d1b311d163b881b939c65db"
    },
    "expected": {
      "selection_sha256": "b09e4ab44ee00bd8600fb34774994a37e46dc2c98d1b311d163b881b939c65db",
      "head": "bd18893c69484c47db9b6d1b0613b4bac962b237",
      "tree": "60dc53b466502e62a33d8e8d48233e8469e1c60c"
    },
    "stage": "/Users/serhii/.local/state/shipyard/phase49-selected-package-bd18893c6948/candidate",
    "package_version": "0.71.0+codex.ef7442fb18b62c15",
    "package_digest": "b73f80329f02f2dd004a5a65a4d72b9c10e32fa06c1b0cbecb1e7a1c97555ab0",
    "coordinator_publication_status": "exact original 161 outputs published; original build_calls=1",
    "installed_identity": null,
    "installed_reason": "Global installation unchanged; no installed candidate authentication claimed."
  },
  "runtime": {
    "runtime": "codex",
    "provider": "openai",
    "policy": "unchanged supported policy; actual treatment policy pin pending",
    "capacity": null,
    "capacity_reason": "Complete actual encoded 128 KiB native output not collected by this executor."
  },
  "metrics": {
    "successful_reads": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "scheduled_reads": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "failed_calls": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "raw_bytes": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "encoded_bytes": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "retries": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "elapsed_ms": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    },
    "tokens": {
      "value": null,
      "reason": "No genuine phase49 treatment observation collected."
    }
  },
  "baseline_setup": {
    "successful_reads": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    },
    "failed_calls": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    },
    "raw_bytes": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    },
    "encoded_bytes": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    },
    "retries": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    },
    "elapsed_ms": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    },
    "tokens": {
      "value": null,
      "reason": "Independent genuine role baseline setup not collected."
    }
  },
  "native_traces": [],
  "history": {
    "preservation": "Original failed/interrupted receipts, logs and transcripts unchanged; no historical status promoted.",
    "drift": {
      "dispatch": "dispatch-mv2bp1aj-ee1aae26-fa89-45f9-97d5-66224af7d0a1",
      "original_result": "/Users/serhii/.local/state/shipyard/phase49-T49-11-drift-result.jsonl",
      "coordinator_status": "verified/sealed/live fresh",
      "historical_unknown_benchmark": "Superseded by coordinator original-830 authentication, not rewritten."
    }
  },
  "holds": [
    "Installed immutable candidate and unchanged runtime policy must be authenticated by trusted coordinator.",
    "Actual complete encoded 128 KiB capacity and schedule admission are pending.",
    "Equivalent original logical obligations and at most 83 observed successful treatment reads are pending.",
    "Genuine original-session interruption/continuation is pending independently for both roles.",
    "Independent successful baseline, another contributor repair, complete endpoint impact and fresh exact-current native final are pending for both roles.",
    "Native full fallback, changed-base/shared-contract expansion and forged/stale/truncated/replay refusal matrix is pending.",
    "Comparable latency/token observations are unavailable; no savings claimed."
  ],
  "host_verification": {
    "status": "pending",
    "commands_executed_in_sandbox": false,
    "reason": "Both exact commands assigned host profile; executor must not run or retry in sandbox."
  }
});
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
  const ledger = historicalLedger();
  for (const mutate of [v => v.status = 'passed', v => v.empirical_acceptance = true,
    v => v.fixture_evidence = true, v => v.metrics.successful_reads = metric(52),
    v => v.candidate.installed_identity = { installed: true }, v => v.benchmark.observed_successful_reads = 864]) {
    const value = clone(ledger); mutate(value); assert.throws(() => verifyEvidence(value));
  }
});
test('historical HOLD selection supplies no current publication or installed credit', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const ledger = historicalLedger();
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
  const ledger = historicalLedger();
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
  const ledger = historicalLedger();
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
  const ledger = historicalLedger();
  ledger.candidate.expected.head = 'f'.repeat(40);
  assert.throws(() => verifyEvidence(ledger), /historical source/);
});


test('current installed evidence is independently inspected instead of requiring installed-null', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { verifyEvidence } = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-installed-hold-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = historicalLedger();
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


test('finite squash admission requires the original merged PR identity, not equal trees or labels', () => {
  const { validateSquashRecord } = require('../smoke/phase49-final-review-acceptance.cjs');
  const expected = { repository: 'serhii-nochevnyi/shipyard', number: 470,
    ticket: 'T-49-18', head: 'a'.repeat(40), merge: 'b'.repeat(40),
    base: 'epic/49-accelerate-authenticated-architecture-review' };
  const record = { url: 'https://github.com/serhii-nochevnyi/shipyard/pull/470', state: 'MERGED',
    mergedAt: '2026-10-13T16:53:45Z', headRefOid: expected.head,
    headRefName: 'ticket/T-49-18-original-source', baseRefName: expected.base, mergeCommit: { oid: expected.merge } };
  assert.equal(validateSquashRecord(record, expected), true);
  for (const change of [v => v.state = 'CLOSED', v => v.mergedAt = null,
    v => v.headRefOid = 'c'.repeat(40), v => v.mergeCommit.oid = 'c'.repeat(40),
    v => v.url = v.url.replace('shipyard', 'foreign'), v => v.baseRefName = 'main',
    v => v.headRefName = 'ticket/T-49-11-other']) {
    const changed = clone(record); change(changed); assert.throws(() => validateSquashRecord(changed, expected));
  }
});

test('finite original build actor preserves failed verification and exact one-build/eight-copy pins', () => {
  const { validateBuildPins } = require('../smoke/phase49-final-review-acceptance.cjs');
  const selected = { source: { head: 'a'.repeat(40), tree: 'b'.repeat(40), worktree: '/original' }, build_calls: 1 };
  const candidate = { selection: { sha256: 'c'.repeat(64) }, selection_root: '/stage', publication_source: { worktree: '/original' } };
  const launch = { ticket: 'T-49-17', role: 'executor', worktree: '/original', source_head: selected.source.head,
    baseline_tree: selected.source.tree, tracked_clean: true, head_still_pinned: true, native_process_id: 66450 };
  const build = { root: '/stage', selection_sha256: candidate.selection.sha256, source_head: selected.source.head,
    source_tree: selected.source.tree, outputs: 161, build_calls: 1, published: 0 };
  const outputs = Array.from({ length: 8 }, (_, i) => 'plugins/shipyard/output' + i);
  const copy = { selection_sha256: candidate.selection.sha256, source_head: selected.source.head,
    build_calls: 1, canonical_inputs: 162, complete_outputs: 161, unchanged_outputs_verified: 153, published: outputs };
  assert.equal(validateBuildPins(candidate, selected, launch, build, copy, outputs), true);
  for (const change of [v => v[0].tracked_clean = false, v => v[0].native_process_id = 0,
    v => v[1].build_calls = 2, v => v[1].source_tree = 'd'.repeat(40),
    v => v[2].published.pop(), v => v[2].unchanged_outputs_verified = 154]) {
    const rows = clone([launch, build, copy]); change(rows);
    assert.throws(() => validateBuildPins(candidate, selected, ...rows, outputs));
  }
});

test('covered base-merge carries the genuine native first parent without inventing an executor receipt', () => {
  const { validateSourceCarry } = require('../smoke/phase49-final-review-acceptance.cjs');
  const parent = { kind: 'executor', ticket: 'T-49-13', repo: 'serhii-nochevnyi/shipyard',
    repository_id: 'original-repository', commit: 'ecf450bf21bb7532e050989d74fde2ba9bc24c79',
    tree: '0c11564f6dbed0c68096e7f139c61390ee5ce3d2' };
  const source = { ...parent, kind: 'base-merge', commit: '8d95c9d4d9ae027d761336fbbbdeaec562268515',
    parents: [parent.commit, '26f9350731fae06635f57eafdf207097462edfa3'],
    base_merge: { base: 'origin/ticket/T-49-12-original', requested_base: 'ticket/T-49-12-original', taken_from_base: [] } };
  assert.equal(validateSourceCarry(source, parent), true);
  for (const change of [v => v[0].kind = 'executor', v => v[1].kind = 'base-merge',
    v => v[0].ticket = 'T-49-12', v => v[0].repository_id = 'foreign', v => v[0].repo = 'foreign/repo',
    v => v[0].parents.reverse(), v => v[0].parents.pop(), v => v[0].parents.push('a'.repeat(40)),
    v => v[0].parents[1] = parent.commit, v => v[0].tree = 'b'.repeat(40),
    v => delete v[0].base_merge, v => v[0].base_merge.taken_from_base.push('source'),
    v => v[0].base_merge.requested_base = '', v => v[0].dispatch_id = 'invented',
    v => v[0].receipt_store = '/invented']) {
    const records = clone([source, parent]); change(records);
    assert.throws(() => validateSourceCarry(...records));
  }
  assert.throws(() => require('../smoke/phase49-final-review-acceptance.cjs').verifiedRecord({ dispatch: 'invented' }),
    /original recorder reference required/);
});

test('private prelaunch copy preserves the public deep reference bytes and complete original launch scope', t => {
  const { verifyPrelaunchCopy } = require('../smoke/phase49-final-review-acceptance.cjs');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase49-prelaunch-copy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prelaunch = { ticket: 'T-49-17', role: 'executor', worktree: '/original', baseline_head: 'a'.repeat(40),
    baseline_tree: 'b'.repeat(40), source_head: 'c'.repeat(40), merge_proof: '/original/merge.json', tracked_clean: true };
  const bytes = Buffer.from(JSON.stringify(prelaunch)), hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const publicPath = path.join(root, 'original.json'), privatePath = path.join(root, 'private.json');
  fs.writeFileSync(publicPath, bytes, { mode: 0o644 }); fs.writeFileSync(privatePath, bytes, { mode: 0o600 });
  fs.chmodSync(publicPath, 0o644);
  const launch = { ...prelaunch, native_process_id: 66450,
    prelaunch_observation: { path: publicPath, sha256: hash(bytes) } };
  const copy = { path: privatePath, sha256: hash(bytes), bytes: bytes.length };
  assert.throws(() => verifyPrelaunchCopy(launch), /must be private/);
  assert.deepEqual(verifyPrelaunchCopy(launch, copy), prelaunch);
  assert.equal(fs.statSync(publicPath).mode & 0o777, 0o644);
  assert.deepEqual(fs.readFileSync(publicPath), bytes);
  fs.chmodSync(publicPath, 0o600);
  assert.deepEqual(verifyPrelaunchCopy(launch), prelaunch);
  fs.chmodSync(publicPath, 0o644);
  for (const change of [v => v[1].sha256 = 'd'.repeat(64), v => v[1].bytes--,
    v => delete v[1].bytes, v => v[1].path = publicPath,
    v => v[0].ticket = 'T-49-11', v => v[0].role = 'review-fix', v => v[0].worktree = '/foreign',
    v => v[0].source_head = 'd'.repeat(40), v => v[0].baseline_tree = 'd'.repeat(40),
    v => v[0].baseline_head = 'd'.repeat(40), v => v[0].merge_proof = '/foreign',
    v => v[0].tracked_clean = false]) {
    const refs = clone([launch, copy]); change(refs);
    assert.throws(() => verifyPrelaunchCopy(...refs));
  }
  fs.chmodSync(privatePath, 0o644); assert.throws(() => verifyPrelaunchCopy(launch, copy), /must be private/);
  fs.chmodSync(privatePath, 0o600);
  fs.writeFileSync(privatePath, Buffer.concat([bytes, Buffer.from(' ')]));
  assert.throws(() => verifyPrelaunchCopy(launch, copy), /altered original/);
  fs.writeFileSync(privatePath, bytes); fs.unlinkSync(privatePath); fs.symlinkSync(publicPath, privatePath);
  assert.throws(() => verifyPrelaunchCopy(launch, copy), /symlinked evidence/);
});


test('initial build ancestry follows selected squash source to covered baseline to final publication', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const filename = path.resolve(__dirname, '../smoke/phase49-final-review-acceptance.cjs');
  const selected = { source: { head: 'a'.repeat(40), tree: 'b'.repeat(40), worktree: '/original' },
    inputs: Array.from({ length: 162 }, (_, i) => ({ path: 'scripts/input' + i, sha256: 'c'.repeat(64), bytes: 1, mode: 0o644 })) };
  const candidate = { finite_predecessor: {}, producer: { commit: selected.source.head, worktree: '/original' },
    publication_source: { commit: 'd'.repeat(40), worktree: '/original' }, source_transition: { ticket: 'T-49-18' } };
  const launch = { ticket: 'T-49-17', worktree: '/original', source_head: selected.source.head };
  const prelaunch = { baseline_head: 'e'.repeat(40), baseline_tree: selected.source.tree };
  const producer = { commit: selected.source.head, kind: 'executor', ticket: 'T-49-18', repository_id: 'repo', tree: selected.source.tree };
  const baseline = { commit: prelaunch.baseline_head, kind: 'base-merge', ticket: 'T-49-17', repository_id: 'repo', tree: selected.source.tree };
  const publication = { commit: candidate.publication_source.commit, kind: 'executor', ticket: 'T-49-17', repository_id: 'repo' };
  const run = (change = () => {}) => {
    const value = clone({ candidate, selected, launch, prelaunch, producer, baseline, publication }); change(value);
    const calls = [];
    const sandbox = { require, module: { exports: {} }, __dirname: path.dirname(filename), Buffer, process,
      value, calls, assert };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
      verifySourceHistory = ref => {
        calls.push(['coverage', ref.commit]);
        const record = [value.producer, value.baseline, value.publication].find(row => row.commit === ref.commit);
        assert(record, 'missing protected coverage'); return record;
      };
      verifySourceTransition = (candidate, source, target, ref) => {
        calls.push(['transition', source.commit, target.commit]);
        assert.equal(ref.ticket, 'T-49-18');
        assert.equal(source.commit, value.producer.commit);
        assert.equal(target.commit, value.baseline.commit);
        assert.equal(value.transitionValid, undefined, 'forged or missing original squash');
      };
      gitBytes = (worktree, ...args) => {
        calls.push(args);
        if (args[0] === 'merge-base') {
          assert.equal(args[2], value.baseline.commit);
          assert.equal(args[3], value.publication.commit);
          assert.equal(value.descendantInvalid, undefined, 'publication not descended from initial baseline');
        }
        return Buffer.from('');
      };
      sourceInputs = (worktree, commit) => {
        assert.equal(worktree, '/original');
        return value.changedInputs && commit === value.baseline.commit ? [] : value.selected.inputs;
      };
      verifyInitialBuildAncestry(value.candidate, value.selected, value.launch, value.prelaunch);
    `, sandbox, { filename });
    return calls;
  };
  const calls = run();
  assert(calls.some(row => row[0] === 'transition' && row[1] === selected.source.head && row[2] === prelaunch.baseline_head));
  assert(calls.some(row => row[0] === 'merge-base' && row[2] === prelaunch.baseline_head && row[3] === publication.commit));
  assert(calls.some(row => row[0] === 'verify-commit' && row[1] === prelaunch.baseline_head));
  for (const change of [v => v.baseline.kind = 'executor', v => v.baseline.ticket = 'T-49-18',
    v => v.baseline.repository_id = 'foreign', v => v.baseline.tree = 'f'.repeat(40),
    v => v.launch.source_head = 'f'.repeat(40), v => v.candidate.producer.commit = 'f'.repeat(40),
    v => v.candidate.source_transition.ticket = 'T-49-13', v => v.transitionValid = false,
    v => v.descendantInvalid = true, v => v.changedInputs = true,
    v => v.publication.repository_id = 'foreign']) assert.throws(() => run(change));
});

test('focused candidate exercises original installed consumers and independent integration safeguards', async () => {
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const path = require('node:path');
  const observed = await acceptance.exerciseFocusedCandidate(path.resolve(__dirname,
    '../../plugins/shipyard/host/plugins/delivery-pipeline'));
  assert(observed.fixture_cases >= 13);
  assert.equal(observed.empirical_acceptance, false);
});

test('bounded focused closeout validates original delivery while empirical and final epic stay pending', t => {
  const fs = require('node:fs'), path = require('node:path');
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const ledger = JSON.parse(fs.readFileSync(path.resolve(__dirname,
    '../../docs/audits/phase49-final-review-acceptance.json'), 'utf8'));
  if (!fs.existsSync(ledger.installed_identity.proof.path)) {
    t.skip('HOLD: original external coordinator custody unavailable; no installed or bounded acceptance observed');
    return;
  }
  let report;
  try { report = acceptance.verifyEvidence(ledger); }
  catch (error) {
    const repository = path.resolve(__dirname, '../..');
    const missing = typeof error.path === 'string' ? path.resolve(error.path) : null;
    if (error.code !== 'ENOENT' || !missing || missing === repository || missing.startsWith(repository + path.sep)) throw error;
    t.skip('HOLD: original external coordinator custody unavailable; no installed or bounded acceptance observed');
    return;
  }
  assert.equal(report.status, 'hold'); assert.equal(report.empirical_acceptance, false);
  assert.equal(report.bounded_closeout, 'passed');
  assert.equal(report.installed_acceptance, true);
  assert.equal(report.final_epic, 'pending-coordinator-postmerge');
  for (const mutate of [v => v.empirical_acceptance = true, v => v.status = 'acceptance',
    v => v.fixture_evidence = true, v => v.focused_metrics.tokens.reason = null,
    v => v.focused_metrics.calls.value = 0.5,
    v => v.candidate.selection.sha256 = 'f'.repeat(64),
    v => v.final_epic.status = 'accepted',
    v => v.current_admission = { authenticated: true },
    v => v.replays = [{ authenticated: true, verdict: 'detected' }]]) {
    const altered = clone(ledger); mutate(altered);
    assert.throws(() => acceptance.verifyEvidence(altered));
  }
});

test('portable existing verifier composition requires installation and source custody without native experiments', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const filename = path.resolve(__dirname, '../smoke/phase49-final-review-acceptance.cjs');
  const ledger = JSON.parse(fs.readFileSync(path.resolve(__dirname,
    '../../docs/audits/phase49-final-review-acceptance.json'), 'utf8'));
  const context = { require: require('node:module').createRequire(filename), module: { exports: {} },
    __dirname: path.dirname(filename), __filename: filename, process, Buffer, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  context.ledgerFixture = ledger;
  const cliCapture = fs.readFileSync(path.resolve(__dirname,
    '../fixtures/captured/codex-agent-stream-exec.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  context.cliFixture = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
    .map(type => structuredClone(cliCapture.find(row => row.type === type)));
  context.cliFixture[0].thread_id = 'session';
  const { focusedNativeSession } = require('./helpers/codex-arch-review-fixtures.cjs');
  const nativeCapture = focusedNativeSession({ session: 'session', worktree: '/original-producer-fixture',
    model: 'model', effort: 'effort', text: 'Portable source fixture only' }).trim().split('\n').map(JSON.parse);
  context.nativeMetaFixture = nativeCapture.find(row => row.type === 'session_meta');
  context.nativeContextFixture = nativeCapture.find(row => row.type === 'turn_context');
  context.nativeStartFixture = nativeCapture.find(row => row.payload?.type === 'task_started');
  vm.runInContext(`
    const supplied = new Map();
    const fixtureProof = { expected: { publication_head: '259acd68c29fc4b9f6e5d044aaa607f66cffc5eb' },
      identity: { worktree: '/original-producer-fixture' }, binding: {}, ci: { original_full_log: {} }, source_ci: { original_full_log: {} } };
    for (const ref of [ledgerFixture.historical_ledger, ledgerFixture.pre_amendment_ledger])
      supplied.set(ref.path, { status: 'hold', empirical_acceptance: false, plan_sha256: HISTORICAL_PLAN });
    supplied.set(ledgerFixture.installed_identity.proof.path, fixtureProof);
    supplied.set(ledgerFixture.candidate.selection.path, {});
    supplied.set(ledgerFixture.candidate.squash.path, { state: 'MERGED',
      headRefOid: fixtureProof.expected.publication_head,
      mergeCommit: { oid: '2d6d1323ac52568a08ab0a60d0bf1e727c750a86' } });
    ledgerFixture.prepared_source_custody.forEach((ref, index) => supplied.set(ref.path,
      { artifact: { commit: 'fixture', tree: 'fixture' }, dispatch_id: 'fixture', refs: [{}, { sha256: 'fixture-cli', bytes: 1 }, { path: '/fixture-native', sha256: 'fixture-native', bytes: 1 }],
        covered_finalization: { record: { verification_digest: 'fixture' } } }));
    ledgerFixture.replay_preparations.forEach((ref, index) => supplied.set(ref.path,
      { case: index < 2 ? 'recovery' : 'stop', variant: index % 2 ? 'fixed' : 'defective' }));
    original = ref => {
      if (ref && Object.keys(ref).length === 0) return Buffer.from('fixture log');
      assert(ref && supplied.has(ref.path), 'missing fixture original');
      return Buffer.from(JSON.stringify(supplied.get(ref.path)));
    };
    publicationInspector = repository => {
      assert.equal(repository, fixtureProof.identity.worktree, 'original producer inspector binding');
      return { FOCUSED_SHA: ledgerFixture.candidate.selection.sha256,
      inspectFocusedInstalled: (identity, binding, bytes, expected, authenticate) => {
        assert.deepEqual(authenticate(expected), fixtureProof);
        return { installed_acceptance: true, empirical_acceptance: false };
      } };
    };
    verifySourceHistory = () => ({ dispatch_id: 'fixture', tree: 'fixture', verification_digest: 'fixture', receipt_store: 'fixture' });
    supplied.set('/fixture-native', nativeMetaFixture);
    const readFixture = original;
    original = ref => ref.path === '/fixture-native' ? Buffer.from([
      supplied.get(ref.path), nativeContextFixture,
      { ...nativeStartFixture, payload: { ...nativeStartFixture.payload, turn_id: 'one' } },
      { ...nativeStartFixture, payload: { ...nativeStartFixture.payload, turn_id: 'two' } }
    ].map(row => JSON.stringify(row)).join('\\n') + '\\n') : ref.path === '/fixture-cli'
      ? Buffer.from(cliFixture.map(row => JSON.stringify(row)).join('\\n') + '\\n') : readFixture(ref);
    verifiedRecord = () => ({ receipt: { role: 'executor', runtime: 'codex',
      applied_model: 'model', applied_effort: 'effort', runtime_evidence: {
        transcript: { path: '/fixture-cli', sha256: 'fixture-cli', bytes: 1 }, native_session_evidence: {
          file: 'fixture-native', sha256: 'fixture-native', bytes: 1, session_id: 'session'
        }
      } } });
    verifyReplayPreparation = ref => ref;
  `, context);
  const report = context.module.exports.verifyEvidence(ledger);
  assert.equal(report.bounded_closeout, 'passed');
  assert.equal(report.empirical_acceptance, false);
  assert.equal(report.final_epic, 'pending-coordinator-postmerge');
  for (const mutate of [v => v.empirical_acceptance = true, v => v.status = 'acceptance',
    v => v.fixture_evidence = true, v => v.candidate.selection.sha256 = '0'.repeat(64),
    v => v.installed_identity.proof.sha256 = '0'.repeat(64),
    v => v.pre_amendment_ledger.sha256 = '0'.repeat(64),
    v => v.final_epic.status = 'accepted', v => v.prepared_source_custody = [],
    v => v.replay_preparations = [], v => v.replays = [{ verdict: 'detected' }]]) {
    const altered = clone(ledger); mutate(altered);
    assert.throws(() => context.module.exports.verifyEvidence(altered));
  }
  for (const expression of [
    "supplied.get('/fixture-native').payload.model_provider = 'foreign'",
    "supplied.get('/fixture-native').payload.id = 'foreign'"
  ]) {
    vm.runInContext(expression, context);
    assert.throws(() => context.module.exports.verifyEvidence(ledger));
    vm.runInContext("supplied.get('/fixture-native').payload = { id: 'session', model_provider: 'openai' };", context);
  }
  vm.runInContext('globalThis.originalRecordFixture = verifiedRecord;', context);
  for (const field of ['applied_model', 'applied_effort']) {
    context.selectionField = field;
    vm.runInContext("verifiedRecord = () => { const value = originalRecordFixture(); value.receipt[selectionField] = 'foreign'; return value; };", context);
    assert.throws(() => context.module.exports.verifyEvidence(ledger), /selection differs/);
  }
  vm.runInContext('verifiedRecord = originalRecordFixture;', context);
  const missing = clone(ledger); missing.installed_identity.proof.path = '/missing-fixture';
  assert.throws(() => context.module.exports.verifyEvidence(missing), /missing fixture original/);
  for (const ref of [ledger.historical_ledger, ledger.pre_amendment_ledger, ledger.candidate.selection,
    ledger.candidate.squash, ...ledger.prepared_source_custody, ...ledger.replay_preparations]) {
    context.missingPath = ref.path;
    vm.runInContext('globalThis.retainedFixture = supplied.get(missingPath); supplied.delete(missingPath);', context);
    assert.throws(() => context.module.exports.verifyEvidence(ledger), /missing fixture original/);
    vm.runInContext('supplied.set(missingPath, retainedFixture);', context);
  }
  vm.runInContext('publicationInspector = () => ({ FOCUSED_SHA: ledgerFixture.candidate.selection.sha256, inspectFocusedInstalled: () => ({ installed_acceptance: false }) });', context);
  assert.throws(() => context.module.exports.verifyEvidence(ledger));
});

test('portable deferred disposition refuses empirical, counter and final authority fabrication', () => {
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const ledger = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(__dirname,
    '../../docs/audits/phase49-final-review-acceptance.json'), 'utf8'));
  const report = acceptance.verifyFocusedDisposition(ledger);
  assert.equal(report.empirical_acceptance, false);
  assert.equal(report.bounded_closeout, 'pending'); assert.equal(report.installed_acceptance, false);
  for (const mutate of [v => delete v.deferred.historical_native_execution,
    v => v.deferred.independent_usefulness.status = 'passed',
    v => v.deferred.additional_native_admission.response = { verdict: 'conform' },
    v => v.deferred.independent_usefulness.assessment = { outcome: 'detected' },
    v => v.focused_metrics.calls.value = 1,
    v => v.source_handoff.status = 'passed', v => v.final_epic.empirical_acceptance = true]) {
    const altered = clone(ledger); mutate(altered);
    assert.throws(() => acceptance.verifyFocusedDisposition(altered));
  }
});

test('bounded closeout rejects missing or corrupt required delivery references', t => {
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-originals-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['installed-proof', 'selection', 'squash', 'historical-ledger',
    'pre-amendment-ledger', 'source-custody', 'replay-preparation', 'CI-log']) {
    const file = path.join(root, name), bytes = Buffer.from(JSON.stringify({ fixture: name }));
    fs.writeFileSync(file, bytes);
    const ref = { path: file, bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    assert.deepEqual(acceptance.original(ref), bytes);
    assert.throws(() => acceptance.original({ ...ref, sha256: '0'.repeat(64) }), /altered original/);
    fs.writeFileSync(file, Buffer.from('corrupt required evidence'));
    assert.throws(() => acceptance.original(ref), /altered original/);
    fs.unlinkSync(file);
    assert.throws(() => acceptance.original(ref));
  }
});

test('replay source verification rejects synthetic historical fixes before any reviewer verdict', () => {
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  assert.throws(() => acceptance.verifyReplaySources({ case: 'recovery', fixed: 'a'.repeat(40) }),
    /authentic replay fix required/);
});

test('replay assessment binds every original finding and never grants native acceptance', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
  const acceptance = require('../smoke/phase49-final-review-acceptance.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-assessment-')));
  const save = (name, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const file = path.join(root, name); fs.writeFileSync(file, bytes);
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  try {
    const prompt = save('prompt', 'Neutral source input');
    const response = save('response', { review_completeness: 'complete', findings: [{ text: 'Observed consequence' }] });
    const value = { response_sha256: response.sha256, prompt_sha256: prompt.sha256, outcome: 'detected',
      findings: [{ index: 0, finding: { text: 'Observed consequence' }, outcome: 'grounded', source_consequence: 'Ordering changes' }] };
    const run = change => { const altered = clone(value); change?.(altered);
      return acceptance.verifyReplayAssessment({ prompt, response, assessment: save('assessment', altered) }); };
    assert.equal(run().empirical_acceptance, false);
    for (const change of [v => v.response_sha256 = 'f'.repeat(64), v => v.prompt_sha256 = 'f'.repeat(64),
      v => v.findings = [], v => v.findings[0].finding.text = 'Expected oracle',
      v => v.findings[0].source_consequence = '', v => v.outcome = 'pass']) assert.throws(() => run(change));
    for (const outcome of ['missed', 'false-positive', 'incomplete'])
      assert.equal(run(v => v.outcome = outcome).outcome, outcome);
    fs.appendFileSync(response.path, ' ');
    assert.throws(() => run(), /altered original/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
