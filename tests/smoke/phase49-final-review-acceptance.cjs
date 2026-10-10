#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = path.join(ROOT, 'plugins/delivery-pipeline/scripts');
const SCHEMA = 'shipyard.phase49.final-review-acceptance.v1';
const MAX_BYTES = 128 * 1024 * 1024;
const CHECKS = ['full-fallback', 'changed-base-expansion', 'shared-contract-expansion', 'forged', 'stale', 'truncated', 'replay'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const metric = (value, reason = null) => ({ value, reason });
const equalSet = (actual, expected, label) => {
  assert(Array.isArray(actual) && Array.isArray(expected) && actual.length <= 2064 && expected.length <= 2064, label);
  assert.equal(new Set(actual).size, actual.length, label + ': duplicate credit');
  assert.equal(new Set(expected).size, expected.length, label + ': duplicate obligation');
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
};
function metrics(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'metrics required');
  for (const row of Object.values(value)) {
    assert(row && Object.hasOwn(row, 'value') && Object.hasOwn(row, 'reason'), 'explicit counter required');
    if (row.value === null) assert(typeof row.reason === 'string' && row.reason.trim(), 'unknown counter needs reason');
    else {
      assert(Number.isSafeInteger(row.value) && row.value >= 0, 'counter must be observed nonnegative integer');
      assert.equal(row.reason, null, 'observed counter cannot have unknown reason');
    }
  }
}
function identity(subject) {
  assert(subject && subject.runtime === 'codex' && subject.provider === 'openai', 'supported unchanged runtime required');
  for (const key of ['head', 'base', 'merge_base']) assert(/^[a-f0-9]{40}$/.test(subject[key] || ''), key + ' required');
  for (const key of ['policy', 'candidate']) assert(/^[a-f0-9]{64}$/.test(subject[key] || ''), key + ' required');
  assert(Array.isArray(subject.ticket_set) && subject.ticket_set.length > 0 && subject.ticket_set.length <= 1000);
  assert(subject.ticket_set.every(id => /^T-49-\d{2}$/.test(id)), 'complete canonical ticket IDs required');
  equalSet(subject.ticket_set, subject.ticket_set, 'membership');
}
function validateTrace(trace, subject) {
  identity(subject); assert.deepEqual(trace.subject, subject, 'stale current subject');
  assert(['arch-review', 'integrator'].includes(trace.role));
  assert.equal(trace.baseline.role, trace.role, 'independent role baseline required');
  assert.equal(trace.baseline.success, true, 'eligible successful baseline required');
  assert.equal(trace.final.success, true); assert.equal(trace.final.fresh, true);
  assert(trace.final.dispatch && trace.final.dispatch !== trace.baseline.dispatch, 'replayed final');
  equalSet(trace.contributor_delta, trace.required_delta, 'all-contributor endpoint delta');
  equalSet([...trace.inherited, ...trace.reviewed], trace.required, 'complete logical coverage');
  assert(Array.isArray(trace.limitations) && trace.limitations.length === 0, 'remaining semantic limitations');
  assert(trace.affected.every(item => trace.reviewed.includes(item)), 'affected boundary was inherited');
  assert(['full', 'incremental'].includes(trace.mode));
  if (trace.mode === 'full') assert.equal(trace.inherited.length, 0, 'full fallback cannot inherit');
  else assert.equal(trace.assumptions_valid, true, 'invalid assumptions require full fallback');
  const c = trace.continuation;
  assert(c && c.interrupted && c.fresh_final, 'genuine interruption and fresh continuation required');
  assert.equal(c.original_session, c.resumed_session, 'foreign semantic session');
  assert(c.original_session && c.original_dispatch !== c.final_dispatch, 'replayed continuation');
  assert.equal(c.final_dispatch, trace.final.dispatch);
  assert(Number.isSafeInteger(c.required_ranges) && c.required_ranges > 1 && c.required_ranges <= 2064);
  assert(c.credited.length && c.resumed.length, 'interruption must split actual reading');
  assert.deepEqual([...c.credited, ...c.resumed], Array.from({ length: c.required_ranges }, (_, i) => i),
    'reordered, truncated or reread authenticated ranges');
  metrics(trace.metrics); metrics(trace.baseline_setup);
  for (const key of ['successful_reads', 'scheduled_reads', 'failed_calls', 'raw_bytes', 'encoded_bytes', 'retries', 'elapsed_ms', 'tokens'])
    assert(Object.hasOwn(trace.metrics, key), 'missing independent metric: ' + key);
}
function validateMatrix(value) {
  assert.equal(value.schema, SCHEMA); identity(value.subject);
  assert.equal(value.benchmark.material_bytes, 6530992, 'original representative bytes required');
  assert.equal(value.benchmark.successful_reads, 830, '864 schedule is not original observed benchmark');
  assert.equal(value.benchmark.complete, true);
  const capacity = value.capacity;
  assert.equal(capacity.block_bytes, 131072, 'first actual capacity probe must be 128 KiB');
  assert.equal(capacity.complete, true, 'truncated capacity probe');
  assert(Number.isSafeInteger(capacity.observed_encoded_bytes) && Number.isSafeInteger(capacity.required_encoded_bytes)
    && capacity.required_encoded_bytes > 0 && capacity.observed_encoded_bytes >= capacity.required_encoded_bytes, 'insufficient capacity');
  equalSet(value.traces.map(t => t.role), ['arch-review', 'integrator'], 'independent roles');
  assert.equal(new Set(value.traces.map(t => t.baseline.dispatch)).size, 2, 'independent role baseline dispatches');
  assert.equal(new Set(value.traces.map(t => t.final.dispatch)).size, 2, 'independent fresh role dispatches');
  assert.equal(new Set(value.traces.map(t => t.continuation.original_session)).size, 2, 'independent semantic role sessions');
  equalSet(value.checks, CHECKS, 'focused refusal and fallback matrix');
  assert(Array.isArray(value.history) && value.history.some(row => row.status === 'interrupted'), 'interruption history required');
  assert(value.history.every(row => row.dispatch && ['failed', 'interrupted', 'rejected', 'successful'].includes(row.status)), 'immutable original history');
  const holds = [];
  for (const trace of value.traces) {
    validateTrace(trace, value.subject);
    equalSet(trace.required, value.benchmark.obligations, 'equivalent original obligations');
    const calls = trace.metrics.successful_reads.value;
    if (calls === null) holds.push(trace.role + ': observed successful reads unavailable');
    else assert(calls <= 83, 'original benchmark 10x call target not met');
  }
  return { status: holds.length ? 'hold' : 'fixture-pass', empirical_acceptance: false, holds };
}
function verifyFixture({ bytes, publicKey, signature }) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= 4 * 1024 * 1024, 'bounded fixture required');
  assert(crypto.verify(null, bytes, publicKey, signature), 'fixture authority mismatch');
  return validateMatrix(JSON.parse(bytes));
}
function read(file, limit = MAX_BYTES) {
  assert(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'physical absolute path required');
  assert.equal(fs.realpathSync(file), file, 'symlinked evidence');
  const before = fs.lstatSync(file);
  assert(before.isFile() && before.size <= limit, 'bounded regular original required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd);
    for (const stat of [fs.fstatSync(fd), fs.lstatSync(file)])
      for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) assert.equal(stat[key], before[key], 'evidence changed during read');
    assert.equal(bytes.length, before.size, 'truncated original');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function original(ref) {
  assert(ref && /^[a-f0-9]{64}$/.test(ref.sha256 || ''), 'original digest required');
  const bytes = read(ref.path); assert.equal(sha(bytes), ref.sha256, 'altered original');
  if (ref.bytes !== undefined) assert.equal(bytes.length, ref.bytes, 'original length mismatch');
  return bytes;
}
function unavailable(error) {
  return ['ENOENT', 'EACCES', 'EPERM', 'RECORD_FAILED', 'MISSING_RECEIPT', 'ARCHIVE_AUTHORITY_MISSING'].includes(error.code);
}
function verifiedRecord(ref) {
  assert(ref && path.isAbsolute(ref.store) && typeof ref.dispatch === 'string', 'original recorder reference required');
  const record = require('./phase47-runtime-acceptance.cjs').originalReceipt({ store: ref.store, dispatch_id: ref.dispatch }, SCRIPTS);
  assert(record && record.dispatch_id === ref.dispatch && record.receipt?.dispatch_id === ref.dispatch, 'original authority missing');
  assert.equal(record.receipt.compliance, 'verified');
  const proof = record.receipt.compliance_proof;
  assert.equal(proof.dispatch_id, ref.dispatch); assert.equal(proof.policy_hash, record.receipt.policy_hash);
  assert.equal(proof.launch_id, record.receipt.launch_id); assert.equal(proof.status, 'verified');
  original(record.receipt.runtime_evidence.transcript);
  return record;
}
function verifyBenchmark(ref) {
  const record = verifiedRecord(ref), runtime = record.receipt.runtime_evidence;
  assert.equal(record.receipt.role, 'arch-review'); assert.equal(record.receipt.runtime, 'codex');
  assert.equal(runtime.input_consumption.chunk_reads, 830);
  assert.equal(runtime.input_accounting.material_bytes, 6530992);
  assert.equal(runtime.input_consumption.manifest_sha256, runtime.input_bundle.manifest_sha256);
  assert.equal(runtime.input_consumption.native_session_sha256, runtime.native_session_evidence.sha256);
  const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).verifyFileInput(runtime.input_bundle, { sealed: true, historical: true });
  assert.equal(checked.chunk_reads, 830);
  assert.equal(runtime.input_bundle.manifest_sha256, 'a7a8f430bf055bb3336b18a561c9b00a30448b83b4e1453a51ee0b039dc5a20e');
  assert.equal(sha(checked.material[0]), 'f0f59f70ccef33f48dad09608443cc9cd9df5f07e6568e2aa4cd56c7ac57bf3b');
  assert.equal(checked.manifest.accounting.material_bytes, 6530992);
  return { dispatch: record.dispatch_id, successful_reads: 830, material_bytes: 6530992,
    manifest_sha256: runtime.input_bundle.manifest_sha256, native_session_sha256: runtime.native_session_evidence.sha256,
    historical_only: true, current_verdict: false };
}
function inspectPublication(ref) {
  const bytes = original(ref.selection);
  const file = path.join(ROOT, 'tests/unit/phase49-package-publication.test.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:test' ? () => {} : nativeRequire(name);
  loaded._compile(read(file).toString('utf8'), file);
  const inspector = loaded.exports;
  const selected = JSON.parse(bytes);
  assert.equal(selected.package.version, ref.package_version, 'candidate package version drift');
  assert.equal(selected.package.digest, ref.package_digest, 'candidate package digest drift');
  const result = inspector.inspect(bytes, ref.expected, ROOT, ref.stage);
  return { ...result, package: JSON.parse(bytes).package, installed: false };
}
function verifyEvidence(ledger) {
  assert.equal(ledger.schema, SCHEMA);
  assert.equal(ledger.ticket, 'T-49-11');
  assert.equal(ledger.plan_sha256, '3328a4c25ae4f451a6f8dcbe01b0164260f31bf294ea33e70877795ae24380e1');
  assert.equal(ledger.benchmark.material_bytes, 6530992);
  assert.equal(ledger.benchmark.observed_successful_reads, 830);
  assert.equal(ledger.candidate.expected.selection_sha256, 'b09e4ab44ee00bd8600fb34774994a37e46dc2c98d1b311d163b881b939c65db');
  assert.equal(ledger.candidate.selection.sha256, ledger.candidate.expected.selection_sha256);
  assert.equal(ledger.candidate.expected.head, 'bd18893c69484c47db9b6d1b0613b4bac962b237');
  assert.equal(ledger.candidate.expected.tree, '60dc53b466502e62a33d8e8d48233e8469e1c60c');
  assert.equal(ledger.status, 'hold', 'pending native matrix must remain explicit HOLD');
  assert.equal(ledger.empirical_acceptance, false, 'caller success label supplies no authority');
  assert(Array.isArray(ledger.holds) && ledger.holds.length > 0, 'explicit acceptance prerequisites required');
  assert.equal(ledger.fixture_evidence, false, 'fixture evidence cannot enter native admission');
  metrics(ledger.metrics); metrics(ledger.baseline_setup);
  assert.equal(ledger.candidate.installed_identity, null, 'installation assertion requires separate installed authentication');
  if (!ledger.native_traces.length) {
    for (const row of Object.values(ledger.metrics)) assert.equal(row.value, null, 'missing trace cannot supply observed treatment counters');
    for (const row of Object.values(ledger.baseline_setup)) assert.equal(row.value, null, 'missing baseline cannot supply setup counters');
  }
  const report = { schema: SCHEMA, status: 'hold', empirical_acceptance: false, verified: [], holds: [...ledger.holds] };
  for (const [name, action] of [['original-benchmark', () => verifyBenchmark(ledger.benchmark.authority)],
    ['immutable-publication', () => inspectPublication(ledger.candidate)]]) {
    try { report.verified.push({ name, evidence: action() }); }
    catch (error) {
      if (!unavailable(error)) throw error;
      report.holds.push(name + ': independent protected original unavailable (' + error.code + ')');
    }
  }
  assert(Array.isArray(ledger.native_traces) && ledger.native_traces.length <= 2, 'bounded independent native roles required');
  const roles = new Set();
  for (const trace of ledger.native_traces) {
    assert(!roles.has(trace.role), 'duplicate native role credit'); roles.add(trace.role);
    try { report.verified.push({ name: trace.role, evidence: verifyNativeTrace(trace) }); }
    catch (error) { if (!unavailable(error)) throw error; report.holds.push(trace.role + ': protected originals unavailable (' + error.code + ')'); }
  }
  return report;
}
function verifyNativeTrace({ receipt, current, role }) {
  assert(['arch-review', 'integrator'].includes(role));
  const record = verifiedRecord(receipt);
  assert.equal(record.receipt.role, role);
  const authority = require(path.join(SCRIPTS, 'role-artifact.cjs'));
  const verdict = role === 'arch-review' ? authority.currentArchitectureVerdict(current) : authority.currentIntegrationVerdict(current);
  assert(verdict?.authenticated && verdict.dispatch_id === record.dispatch_id, 'fresh exact-current admission required');
  const runtime = record.receipt.runtime_evidence;
  const progress = authority.validateReviewContinuationEvidence(runtime);
  assert(progress.completed_ranges > 0 && runtime.review_continuation.newly_completed_ranges > 0, 'real interrupted reading required');
  const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs'))
    .verifyFileInput(runtime.input_bundle, { sealed: true, historical: true });
  const packet = require(path.join(SCRIPTS, 'context-packet.cjs')).decodeUniqueContent(JSON.parse(checked.material[0]));
  const lineage = packet.role_context?.review_coverage || packet.review_coverage;
  assert(lineage && lineage.role === role && lineage.mode === 'incremental' && lineage.baseline, 'independent eligible baseline lineage required');
  assert.equal(lineage.current.head, current.head);
  assert.equal(lineage.baseline.role, role);
  assert.notEqual(lineage.baseline.dispatch_id, record.dispatch_id, 'replayed baseline final');
  const authors = execFileSync('git', ['-C', current.worktreePath, 'log', '--format=%aN <%aE>',
    lineage.endpoint.from + '..' + lineage.endpoint.to], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
    .trim().split('\n').filter(Boolean);
  assert(authors.length > 0, 'genuine baseline-to-repair commits required');
  assert(typeof current.coordinator_author === 'string' && current.coordinator_author.trim(), 'actual coordinator author identity required');
  assert(authors.some(author => author !== current.coordinator_author), 'another contributor repair required');
  return { verdict, lineage, observed_contributor_authors: [...new Set(authors)], continuation: runtime.review_continuation, consumption: runtime.input_consumption,
    accounting: runtime.input_accounting, empirical_acceptance: false,
    holds: ['Installed candidate/policy, comparable original obligations, coordinator contributor attribution, capacity and independent observed matrix counters must also be admitted.'] };
}

async function verifyNativeCapacity(input, prepared) {
  const runtime = require(path.join(SCRIPTS, 'codex-runtime-host.cjs'));
  const verified = await runtime.verifyCompletedNativeLaunch(input);
  const capacity = runtime.measureReaderCapacity(verified, prepared);
  const collector = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs'));
  const checked = collector.verifyFileInput(prepared);
  const contract = runtime.readerCapacityContract(capacity, checked.manifest);
  assert.equal(contract.chunk_bytes, 131072);
  return { capacity, contract, semantic_credit: false };
}
function observeNativeConsumption({ prepared, native, dispatch, result }) {
  const bytes = original(native);
  const checked = require(path.join(SCRIPTS, 'codex-runtime-host.cjs'))
    .verifyFileConsumption(prepared, bytes.toString('utf8'), dispatch, result);
  const lines = bytes.toString('utf8').split('\n').filter(Boolean);
  assert(lines.length <= 100000, 'native observation record count exceeds bound');
  const records = lines.map(line => JSON.parse(line));
  const started = records.find(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
  const ended = records.find(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
  const start = Date.parse(started?.timestamp), end = Date.parse(ended?.timestamp);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  return { successful_reads: metric(checked.chunk_reads), scheduled_reads: metric(Math.ceil(checked.manifest_bytes.length / checked.manifest.chunk_bytes)
      + checked.manifest.assets.reduce((sum, asset) => sum + Math.ceil(asset.bytes / checked.manifest.chunk_bytes), 0)),
    raw_bytes: metric(checked.transport_accounting.raw_bytes), encoded_bytes: metric(checked.transport_accounting.encoded_bytes),
    nested_output_bytes: metric(checked.transport_accounting.nested_output_bytes),
    outer_output_bytes: metric(checked.transport_accounting.outer_output_bytes),
    failed_calls: metric(null, 'Complete consumption verifier does not count failed calls across retained attempts.'),
    retries: metric(null, 'Independent original attempt records required.'),
    elapsed_ms: metric(elapsed, elapsed === null ? 'Original native start/completion timestamps unavailable.' : null),
    tokens: metric(null, 'No comparable per-review native token counter admitted; cumulative session usage is not substituted.') };
}

function main(argv) {
  assert(argv.length === 2 && argv[0] === '--verify-evidence' && argv[1] && !argv[1].startsWith('--'),
    'usage: phase49-final-review-acceptance.cjs --verify-evidence <explicit-json-path>');
  const ledger = JSON.parse(read(path.resolve(argv[1]), 4 * 1024 * 1024));
  const report = verifyEvidence(ledger);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
module.exports = { SCHEMA, metric, validateTrace, verifyFixture, verifyEvidence, verifyNativeTrace, verifyNativeCapacity, observeNativeConsumption, verifiedRecord, original, main };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify({ status: 'refused', code: error.code || 'EVIDENCE_INVALID', reason: error.message }) + '\n'); process.exitCode = 1; }
}
