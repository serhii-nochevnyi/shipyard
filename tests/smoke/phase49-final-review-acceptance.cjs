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
const HISTORICAL_PLAN = '3328a4c25ae4f451a6f8dcbe01b0164260f31bf294ea33e70877795ae24380e1';
const PREVIOUS_PLAN = 'a6e2b6805cbe54f62c065a0d471a94f8517244170f177ed452987e2d1b6d3034';
const CURRENT_PLAN = '5801571880fe2236e9491eeb2a88e4ac952ea7620f4cdb155434004ff6eac2dc';
const FINITE_PLAN = '575c93581a5437799f12d25a8f97f6ad26ec71b06a7f5c3ba820629a453ea675';
const MAX_BYTES = 128 * 1024 * 1024;
const CHECKS = ['full-fallback', 'changed-base-expansion', 'shared-contract-expansion', 'forged', 'stale', 'truncated', 'replay'];
const nativeMatrices = new WeakSet();
const installedRuntimes = new WeakMap();
const checkedRuntimeModules = new WeakSet();
const canonical = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
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
  if (error.code === 'RECORD_FAILED') return /(?:ENOENT|EACCES|EPERM)/.test(error.message);
  if (error.code === 'ERR_ASSERTION' && error.message === 'original receipt authority is missing') return true;
  return ['ENOENT', 'EACCES', 'EPERM', 'MISSING_RECEIPT', 'ARCHIVE_AUTHORITY_MISSING', 'SOURCE_AUTHORITY_MISSING', 'CI_AUTHORITY_UNAVAILABLE', 'CI_PREREQUISITE_UNMET'].includes(error.code);
}
function verifiedRecord(ref) {
  assert(ref && typeof ref.store === 'string' && path.isAbsolute(ref.store) && typeof ref.dispatch === 'string', 'original recorder reference required');
  const record = require('./phase47-runtime-acceptance.cjs').originalReceipt({ store: ref.store, dispatch_id: ref.dispatch }, SCRIPTS);
  assert(record && record.dispatch_id === ref.dispatch && record.receipt?.dispatch_id === ref.dispatch, 'original authority missing');
  assert.equal(record.receipt.compliance, 'verified');
  const proof = record.receipt.compliance_proof;
  assert.equal(proof.dispatch_id, ref.dispatch); assert.equal(proof.policy_hash, record.receipt.policy_hash);
  assert.equal(proof.launch_id, record.receipt.launch_id); assert.equal(proof.status, 'verified');
  original(record.receipt.runtime_evidence.transcript);
  return record;
}
function verifyBenchmark(ref, native) {
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
  const physical = native ? verifyOriginalReads(record, native) : null;
  if (physical) assert.equal(physical.metrics.successful_reads.value, 830, 'original observed830 authority differs');
  return { dispatch: record.dispatch_id, successful_reads: 830, material_bytes: 6530992, metrics: physical?.metrics || null,
    manifest_sha256: runtime.input_bundle.manifest_sha256, native_session_sha256: runtime.native_session_evidence.sha256,
    historical_only: true, current_verdict: false };
}
function publicationInspector(repository = ROOT) {
  const file = path.join(repository, 'tests/unit/phase49-package-publication.test.cjs');
  assert.equal(sha(read(file)), sha(read(path.join(ROOT, 'tests/unit/phase49-package-publication.test.cjs'))), 'foreign publication inspector');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:test' ? () => {} : nativeRequire(name);
  loaded._compile(read(file).toString('utf8'), file);
  return loaded.exports;
}
function inspectPublication(ref) {
  const bytes = original(ref.selection);
  const inspector = publicationInspector();
  const selected = JSON.parse(bytes);
  assert.equal(selected.package.version, ref.package_version, 'candidate package version drift');
  assert.equal(selected.package.digest, ref.package_digest, 'candidate package digest drift');
  const result = ref.finite_predecessor
    ? inspector.inspectBatchSuccessor(bytes, ref.expected, ROOT, ref.stage,
      original(ref.finite_predecessor.selection), ref.finite_predecessor.expected, ref.finite_predecessor.repository)
    : ref.mode_predecessor
    ? inspector.inspectModeSuccessor(bytes, ref.expected, ROOT, ref.stage,
      original(ref.mode_predecessor.selection), ref.mode_predecessor.expected)
    : inspector.inspect(bytes, ref.expected, ROOT, ref.stage);
  return { ...result, package: JSON.parse(bytes).package, installed: false };
}
function gitBytes(root, ...args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return execFileSync('git', ['-C', root, ...args], { env, timeout: 10000, maxBuffer: MAX_BYTES });
}
function compareCanonicalInputs(expected, actual) {
  const normalize = rows => {
    assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 1000, 'bounded complete canonical inputs required');
    const names = new Set();
    for (const row of rows) {
      assert(typeof row.path === 'string' && !path.isAbsolute(row.path) && !row.path.includes('\\')
        && row.path.split('/').every(part => part && part !== '.' && part !== '..'), 'canonical input path escape');
      assert(!names.has(row.path), 'duplicate canonical input'); names.add(row.path);
      assert(/^[a-f0-9]{64}$/.test(row.sha256 || ''), 'canonical input digest required');
      assert([0o644, 0o755].includes(row.mode), 'canonical input mode required');
      if (row.bytes !== undefined)
        assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 32 * 1024 * 1024, 'bounded input bytes required');
    }
    return rows.map(({ path, sha256, mode }) => ({ path, sha256, mode }))
      .sort((a, b) => a.path.localeCompare(b.path));
  };
  assert.deepEqual(normalize(actual), normalize(expected), 'complete canonical input equivalence required');
  for (const row of expected) if (row.bytes !== undefined)
    assert.equal(actual.find(item => item.path === row.path).bytes, row.bytes, 'canonical input length differs');
  return true;
}
function sourceInputs(repository, commit) {
  assert(/^[a-f0-9]{40}$/.test(commit || ''), 'exact source commit required');
  const entries = gitBytes(repository, 'ls-tree', '-rz', '--full-tree', commit).toString('utf8').split('\0').filter(Boolean);
  assert(entries.length <= 20000, 'source tree inventory exceeds bound');
  const rows = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(entry); assert(match, 'malformed source tree member');
    const [, mode, type, object, relative] = match;
    if (!relative.startsWith('scripts/') && !relative.startsWith('plugins/delivery-pipeline/') && !relative.startsWith('capabilities/delivery-pipeline/')) continue;
    if (/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(relative)) continue;
    assert(type === 'blob' && ['100644', '100755'].includes(mode), 'canonical nonregular source');
    const size = Number(gitBytes(repository, 'cat-file', '-s', object).toString().trim());
    assert(Number.isSafeInteger(size) && size >= 0 && size <= 32 * 1024 * 1024, 'source blob exceeds bound');
    totalBytes += size; assert(totalBytes <= 64 * 1024 * 1024, 'complete canonical source bytes exceed bound');
    const bytes = gitBytes(repository, 'cat-file', 'blob', object);
    assert.equal(bytes.length, size, 'source blob length changed');
    rows.push({ path: relative, sha256: sha(bytes), bytes: bytes.length, mode: mode === '100755' ? 0o755 : 0o644 });
    assert(rows.length <= 1000, 'canonical inventory exceeds bound');
  }
  assert(rows.some(row => row.path === 'scripts/package-shipyard-codex.cjs'), 'builder input inventory incomplete');
  return rows;
}
function verifySourceHistory(ref) {
  assert(ref && typeof ref.worktree === 'string' && /^[a-f0-9]{40}$/.test(ref.commit || ''), 'original source history reference required');
  assert.equal(fs.realpathSync(ref.worktree), ref.worktree, 'source worktree must be physical');
  const coverage = require(path.join(SCRIPTS, 'conveyor-coverage.cjs'));
  const result = coverage.verify({ commit: ref.commit, repo: coverage.repoSlug(ref.worktree, ref.repo), worktree: ref.worktree });
  if (!result.covered) {
    const error = new Error('source history: ' + result.reason);
    error.code = /ENOENT|EACCES|EPERM/.test(result.reason) ? 'SOURCE_AUTHORITY_MISSING' : 'SOURCE_AUTHORITY_INVALID';
    throw error;
  }
  assert.equal(result.record.commit, ref.commit);
  assert.equal(result.record.tree, gitBytes(ref.worktree, 'rev-parse', ref.commit + '^{tree}').toString().trim());
  return result.record;
}
function validateSquashRecord(record, expected) {
  assert.equal(record.url, 'https://github.com/' + expected.repository + '/pull/' + expected.number, 'foreign original PR');
  assert.equal(record.state, 'MERGED', 'unmerged original PR');
  assert(Number.isFinite(Date.parse(record.mergedAt)), 'original merge time missing');
  assert.equal(record.headRefOid, expected.head, 'other original PR head');
  assert.equal(record.baseRefName, expected.base, 'foreign original PR base');
  assert(record.headRefName.startsWith('ticket/' + expected.ticket + '-'), 'foreign original PR ticket');
  assert.equal(record.mergeCommit?.oid, expected.merge, 'original merge identity differs');
  return true;
}
function validateSourceCarry(source, parent) {
  assert.equal(source.kind, 'base-merge', 'original protected base-merge required');
  assert(['executor', 'fixer'].includes(parent.kind), 'original native parent required');
  assert.equal(source.ticket, parent.ticket, 'foreign carry ticket');
  assert.equal(source.repository_id, parent.repository_id, 'foreign carry repository');
  assert.equal(source.repo, parent.repo, 'foreign carry repo');
  assert(Array.isArray(source.parents) && source.parents.length === 2, 'exact two merge parents required');
  assert.equal(source.parents[0], parent.commit, 'other native first parent');
  assert.notEqual(source.parents[1], parent.commit, 'duplicate merge parent');
  assert.equal(source.tree, parent.tree, 'base-merge changed whole source tree');
  assert(source.base_merge && typeof source.base_merge.base === 'string' && source.base_merge.base
    && typeof source.base_merge.requested_base === 'string' && source.base_merge.requested_base,
  'original protected merge scope required');
  assert.deepEqual(source.base_merge.taken_from_base, [], 'base-merge imported source changes');
  assert.equal(source.dispatch_id, undefined, 'base-merge cannot mint native dispatch');
  assert.equal(source.receipt_store, undefined, 'base-merge cannot mint native receipt');
  return true;
}
function nativeTransitionSource(candidate, source, ref) {
  if (['executor', 'fixer'].includes(source.kind)) return source;
  assert(candidate.finite_predecessor, 'normal native source authority required');
  assert.equal(ref.ticket, 'T-49-13', 'unsupported native source carry');
  assert.equal(source.commit, '8d95c9d4d9ae027d761336fbbbdeaec562268515', 'other original base-merge');
  const selector = requiredReference(ref.native_source, 'original covered native first parent');
  assert.equal(selector.worktree, source.worktree, 'native carry checkout differs');
  assert.equal(selector.commit, 'ecf450bf21bb7532e050989d74fde2ba9bc24c79', 'other original native parent');
  const parent = verifySourceHistory(selector);
  validateSourceCarry(source, parent);
  assert.equal(source.ticket, ref.ticket);
  assert.equal(source.parents[1], '26f9350731fae06635f57eafdf207097462edfa3', 'other original imported base');
  gitBytes(source.worktree, 'verify-commit', source.commit);
  const signer = commit => gitBytes(source.worktree, 'show', '-s', '--format=%GF', commit).toString().trim();
  const fingerprint = signer(parent.commit);
  assert(/^[A-Fa-f0-9]{40,64}$/.test(fingerprint), 'original native signer required');
  assert.equal(signer(source.commit), fingerprint, 'foreign base-merge signer');
  gitBytes(source.worktree, 'merge-base', '--is-ancestor', '22f0064d2123f7ab72362396bb9ea1800c5b3655', parent.commit);
  gitBytes(source.worktree, 'merge-base', '--is-ancestor', parent.commit, source.commit);
  compareCanonicalInputs(sourceInputs(source.worktree, parent.commit), sourceInputs(source.worktree, source.commit));
  assert.equal(sourceInputs(source.worktree, source.commit).length, 162, 'complete carry inputs required');
  return { ...parent, worktree: source.worktree };
}
function verifySourceTransition(candidate, source, target, ref) {
  try {
    gitBytes(target.worktree, 'merge-base', '--is-ancestor', source.commit, target.commit);
    return;
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert(candidate.finite_predecessor, 'normal source ancestry required');
  requiredReference(ref, 'original squash transition');
  const transitions = {
    'T-49-12': [465, '26f9350731fae06635f57eafdf207097462edfa3'],
    'T-49-13': [466, 'e914d19f066dc39720e6df6f9a03dcd7e68989e5'],
    'T-49-14': [467, '9a44d1fec668148ca349f923757a08fece4cccde'],
    'T-49-18': [470, 'a8261467c4be457b9d4b0640cb713b9dc60f50ef']
  };
  const pins = transitions[ref.ticket]; assert(pins, 'unsupported original squash transition');
  if (source.commit === candidate.producer.commit) assert.equal(ref.ticket, 'T-49-18', 'other producer transition');
  assert.equal(ref.repository, 'serhii-nochevnyi/shipyard');
  assert.equal(ref.number, pins[0]); assert.equal(ref.merge, pins[1]);
  const fields = 'url,state,mergedAt,headRefOid,headRefName,baseRefName,mergeCommit';
  let live;
  try {
    live = JSON.parse(execFileSync('gh', ['pr', 'view', String(ref.number), '--repo', ref.repository, '--json', fields],
      { timeout: 30000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    if (/network|connecting|authentication|timed? ?out|rate limit/i.test(String(error.stderr || error.message)))
      error.code = 'CI_AUTHORITY_UNAVAILABLE';
    throw error;
  }
  validateSquashRecord(live, { ...ref, head: ref.head, base: 'epic/49-accelerate-authenticated-architecture-review' });
  const archived = JSON.parse(privateOriginal(requiredReference(ref.original, 'original merged PR custody')));
  for (const key of Object.keys(archived)) assert.deepEqual(live[key], archived[key], 'live original PR differs');
  gitBytes(target.worktree, 'merge-base', '--is-ancestor', source.commit, live.headRefOid);
  gitBytes(target.worktree, 'merge-base', '--is-ancestor', live.mergeCommit.oid, target.commit);
  assert.equal(gitBytes(target.worktree, 'rev-parse', live.mergeCommit.oid + '^{tree}').toString().trim(), ref.tree,
    'expected original merge tree differs');
  assert.equal(gitBytes(target.worktree, 'rev-parse', live.headRefOid + '^{tree}').toString().trim(), ref.tree,
    'original squash head tree differs');
  compareCanonicalInputs(sourceInputs(source.worktree, source.commit), sourceInputs(target.worktree, live.mergeCommit.oid));
  const nativeSource = nativeTransitionSource(candidate, source, ref);
  const record = verifiedRecord({ store: nativeSource.receipt_store, dispatch: nativeSource.dispatch_id });
  assert(nativeSource.kind === 'executor' ? record.receipt.role === 'executor'
    : ['ci-fix', 'review-fix'].includes(record.receipt.role), 'original native source role differs');
  assert.equal(record.receipt.runtime, 'codex');
  const native = requiredReference(ref.native, 'original signed source native stream');
  const evidence = record.receipt.runtime_evidence.native_session_evidence;
  assert.equal(native.sha256, evidence.sha256); assert.equal(native.bytes, evidence.bytes);
  assert.equal(path.basename(native.path), evidence.file);
  const parsed = require(path.join(SCRIPTS, 'codex-runtime-host.cjs')).parseNativeCodexTranscript(
    privateOriginal(native).toString('utf8'), evidence.session_id);
  assert(parsed.selections.length > 0 && parsed.selections.every(row =>
    row.model === record.receipt.applied_model && row.effort === record.receipt.applied_effort), 'original source native selection differs');
}
function verifySourceEquivalence(candidate) {
  const selected = JSON.parse(original(candidate.selection));
  assert.equal(selected.inputs.length, 162, 'complete original 162 inputs required');
  assert.equal(selected.outputs.length, 161, 'complete original 161 outputs required');
  assert(candidate.producer, 'original producer authority reference required');
  assert.equal(candidate.producer.worktree, selected.source.worktree, 'historical producer worktree changed');
  assert.equal(candidate.producer.commit, selected.source.head, 'historical producer commit changed');
  const producer = verifySourceHistory(candidate.producer);
  assert(['executor', 'fixer'].includes(producer.kind), 'original producer needs signed native finalization');
  assert.equal(producer.dispatch_id, selected.source.original_dispatch, 'original producer dispatch differs');
  assert.equal(producer.receipt_store, selected.source.boundary_store, 'original producer receipt custody differs');
  assert.equal(producer.tree, selected.source.tree, 'historical source tree changed');
  compareCanonicalInputs(selected.inputs, sourceInputs(candidate.producer.worktree, candidate.producer.commit));
  const current = verifySourceHistory(candidate.current_source);
  assert.equal(current.repository_id, producer.repository_id, 'foreign current source repository');
  const inputs = sourceInputs(candidate.current_source.worktree, candidate.current_source.commit);
  compareCanonicalInputs(selected.inputs, inputs);
  assert.equal(selected.builder_sha256, inputs.find(row => row.path === 'scripts/package-shipyard-codex.cjs').sha256,
    'builder equality required');
  if (candidate.current_source.commit !== candidate.producer.commit)
    verifySourceTransition(candidate, { ...producer, worktree: candidate.producer.worktree }, { ...current, worktree: candidate.current_source.worktree }, candidate.source_transition);
  if (candidate.publication_source) {
    const publication = verifySourceHistory(candidate.publication_source);
    assert.equal(publication.repository_id, producer.repository_id, 'foreign publication source repository');
    compareCanonicalInputs(inputs, sourceInputs(candidate.publication_source.worktree, candidate.publication_source.commit));
    verifySourceTransition(candidate, { ...producer, worktree: candidate.producer.worktree }, { ...publication, worktree: candidate.publication_source.worktree }, candidate.source_transition);
    gitBytes(candidate.current_source.worktree, 'merge-base', '--is-ancestor', publication.commit, candidate.current_source.commit);
    assert(['executor', 'fixer'].includes(publication.kind), 'original15 signed native publication authority required');
    if (!candidate.finite_predecessor) assert.equal(publication.dispatch_id, 'dispatch-mv2znskv-36e55516-35d6-4859-8908-c17728324c3b', 'foreign publication actor');
  }
  return { producer, current, canonical_inputs: inputs.length, outputs: selected.outputs.length,
    source_equivalent: true, full_ci_authenticated: false };
}
function verifyInstalledCandidate(candidate) {
  inspectPublication(candidate);
  const selected = JSON.parse(original(candidate.selection));
  assert.equal(selected.outputs.length, 161, 'complete installed 161 outputs required');
  const installed = requiredReference(candidate.installed_identity, 'original installed identity');
  assert(typeof installed.package_root === 'string', 'physical installed identity required');
  const content = crypto.createHash('sha256');
  for (const row of selected.outputs) if (!['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)) {
    content.update(row.path + '\0'); content.update(read(path.join(candidate.stage, row.path), 32 * 1024 * 1024));
  }
  const policy = require(path.join(SCRIPTS, 'model-policy.cjs')).resolveDispatch({ runtime: 'codex', role: 'research' }).policy_hash;
  const source = candidate.current_source;
  assert(source, 'authenticated current source required for installation');
  verifySourceEquivalence(candidate);
  const binding = { outputs: selected.outputs, source_content_sha256: content.digest('hex'),
    package_sha256: selected.package.digest, version: selected.package.version,
    source: { head: candidate.finite_predecessor ? source.commit : selected.source.head, common: fs.realpathSync(gitBytes(source.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim()),
      identities: selected.inputs, policy_sha256: policy } };
  const authenticated = {
    selection: { candidate_sha256: candidate.selection.sha256 }, binding,
    identity: { head: gitBytes(source.worktree, 'rev-parse', 'HEAD').toString().trim(),
      tree: gitBytes(source.worktree, 'rev-parse', 'HEAD^{tree}').toString().trim(),
      dirty_sha256: sha(gitBytes(source.worktree, 'status', '--porcelain=v1', '--untracked-files=all').toString().trim()) } };
  const expected = { selection_sha256: candidate.selection.sha256, source_head: selected.source.head,
    source_tree: selected.source.tree, publication_head: source.commit,
    publication_tree: gitBytes(source.worktree, 'rev-parse', source.commit + '^{tree}').toString().trim(),
    runtime_root: installed.runtime_root };
  const ci = verifyCI(candidate.ci, source.commit);
  assert.equal(installed.worktree, source.worktree, 'original installation source checkout differs');
  const inspector = publicationInspector(source.worktree);
  if (candidate.finite_predecessor) expected.selection_root = candidate.selection_root;
  const sourceCI = candidate.finite_predecessor ? verifyCI(candidate.source_ci, selected.source.head) : null;
  const observation = inspector[candidate.finite_predecessor ? 'inspectBatchInstalled' : 'inspectModeInstalled'](installed, authenticated,
    original(candidate.selection), expected, () => ({ ...candidate.installed_proof, authenticated: true, expected,
      identity: installed, binding: authenticated, ci, ...(sourceCI ? { source_ci: sourceCI } : {}) }));
  assert.equal(installed.source_head, source.commit, 'installed current source differs');
  assert.equal(installed.policy_sha256, policy, 'installed runtime policy differs');
  verifyPrerequisites(candidate);
  const versions = verifyVersions(candidate.versions, installed.runtime_root);
  const build = verifyBuildOrigin(candidate, selected);
  const result = { ...observation, versions, build, policy, runtime_root: installed.runtime_root,
    full_ci_authenticated: true, ci: { run_id: candidate.ci.run_id, head: ci.headSha, original_full_log: ci.original_full_log },
    selection_sha256: candidate.selection.sha256, installed: true };
  const runtimeFile = path.join(installed.host_root, 'scripts/codex-runtime-host.cjs');
  assert.equal(sha(read(runtimeFile)), sha(read(path.join(SCRIPTS, 'codex-runtime-host.cjs'))));
  const runtime = require(runtimeFile);
  checkedRuntimeModules.add(runtime); installedRuntimes.set(result, runtime);
  return result;
}
function verifyEvidence(ledger) {
  if (ledger.plan_sha256 === FOCUSED_PLAN) return verifyFocusedEvidence(ledger);
  assert.equal(ledger.schema, SCHEMA);
  assert.equal(ledger.ticket, 'T-49-11');
  assert([HISTORICAL_PLAN, PREVIOUS_PLAN, CURRENT_PLAN, FINITE_PLAN].includes(ledger.plan_sha256), 'unsupported acceptance plan');
  const historical = ledger.plan_sha256 === HISTORICAL_PLAN;
  assert.equal(ledger.benchmark.material_bytes, 6530992);
  assert.equal(ledger.benchmark.observed_successful_reads, 830);
  const expected = ledger.candidate.expected;
  assert(/^[a-f0-9]{64}$/.test(expected.selection_sha256 || ''), 'selection digest required');
  assert.equal(ledger.candidate.selection.sha256, expected.selection_sha256);
  for (const key of ['head', 'tree']) assert(/^[a-f0-9]{40}$/.test(expected[key] || ''), 'source identity required');
  if (historical) {
    assert.equal(expected.selection_sha256, 'b09e4ab44ee00bd8600fb34774994a37e46dc2c98d1b311d163b881b939c65db');
    assert.equal(expected.head, 'bd18893c69484c47db9b6d1b0613b4bac962b237', 'historical source');
    assert.equal(expected.tree, '60dc53b466502e62a33d8e8d48233e8469e1c60c', 'historical tree');
  }
  assert(['hold', 'acceptance'].includes(ledger.status), 'unsupported acceptance label');
  if (historical) assert.equal(ledger.status, 'hold', 'historical HOLD is immutable');
  assert.equal(typeof ledger.empirical_acceptance, 'boolean', 'explicit empirical label required');
  if (historical) assert.equal(ledger.empirical_acceptance, false, 'historical acceptance is immutable');
  assert(Array.isArray(ledger.holds) && (!historical || ledger.holds.length > 0), 'explicit historical prerequisites required');
  assert.equal(ledger.fixture_evidence, false, 'fixture evidence cannot enter native admission');
  if (!historical && ledger.native_traces?.length) {
    for (const role of ['arch-review', 'integrator']) {
      metrics(ledger.metrics[role]); metrics(ledger.baseline_setup[role]);
    }
  } else { metrics(ledger.metrics); metrics(ledger.baseline_setup); }
  if (historical) assert.equal(ledger.candidate.installed_identity, null, 'historical installed identity is immutable');
  if (!ledger.native_traces.length) {
    for (const row of Object.values(ledger.metrics)) assert.equal(row.value, null, 'missing trace cannot supply observed treatment counters');
    for (const row of Object.values(ledger.baseline_setup)) assert.equal(row.value, null, 'missing baseline cannot supply setup counters');
  }
  const report = { schema: SCHEMA, status: 'hold', empirical_acceptance: false, historical_only: historical, verified: [], holds: historical ? [...ledger.holds] : [] };
  for (const [name, action] of [['original-benchmark', () => verifyBenchmark(ledger.benchmark.authority, historical ? null : requiredReference(ledger.benchmark.native, 'original830 native transcript'))],
    ['immutable-publication', () => {
      if (!historical) return inspectPublication(ledger.candidate);
      const selected = JSON.parse(original(ledger.candidate.selection));
      assert.equal(selected.source.head, expected.head, 'historical source');
      assert.equal(selected.source.tree, expected.tree, 'historical tree');
      assert.equal(selected.package.version, ledger.candidate.package_version, 'historical package version drift');
      assert.equal(selected.package.digest, ledger.candidate.package_digest, 'historical package digest drift');
      return { historical_only: true, selection_sha256: expected.selection_sha256,
        complete_publication: false, installed: false, empirical_acceptance: false };
    }]]) {
    try { report.verified.push({ name, evidence: action() }); }
    catch (error) {
      if (!unavailable(error)) throw error;
      report.holds.push(name + ': independent protected original unavailable (' + error.code + ')');
    }
  }
  assert(Array.isArray(ledger.native_traces) && ledger.native_traces.length <= 2, 'bounded independent native roles required');
  assert(ledger.native_traces.every(trace => ['arch-review', 'integrator'].includes(trace.role)), 'unsupported native role');
  assert.equal(new Set(ledger.native_traces.map(trace => trace.role)).size, ledger.native_traces.length, 'duplicate native role credit');
  if (!historical && (ledger.native_traces.length || ledger.runtime.capacity || ledger.observations?.length))
    return verifyActualMatrix(ledger, report);
  const roles = new Set();
  for (const trace of ledger.native_traces) {
    assert(!roles.has(trace.role), 'duplicate native role credit'); roles.add(trace.role);
    try {
      const evidence = verifyNativeTrace(trace);
      report.verified.push({ name: trace.role, evidence });
      report.holds.push(...evidence.holds.map(reason => trace.role + ': ' + reason));
    }
    catch (error) { if (!unavailable(error)) throw error; report.holds.push(trace.role + ': protected originals unavailable (' + error.code + ')'); }
  }
  if (!historical) {
    for (const [name, ref, action] of [
      ['source-equivalence', ledger.candidate.current_source, () => verifySourceEquivalence(ledger.candidate)],
      ['installed-candidate', ledger.candidate.installed_identity, () => verifyInstalledCandidate(ledger.candidate)],
    ]) {
      if (!ref) { report.holds.push(name + ': original authenticated reference absent'); continue; }
      try { report.verified.push({ name, evidence: action() }); }
      catch (error) {
        if (!unavailable(error)) throw error;
        report.holds.push(name + ': protected original unavailable (' + error.code + ')');
      }
    }
    for (const name of ['arch-review', 'integrator'])
      if (!report.verified.some(row => row.name === name)) report.holds.push(name + ': independently authenticated native trace absent');
    if (!ledger.runtime.capacity) report.holds.push('capacity: original complete 128 KiB probe reference absent');
    report.holds.push('focused-observations: original fallback/expansion/refusal selectors absent');
    report.status = report.holds.length ? 'hold' : 'acceptance';
    report.empirical_acceptance = report.status === 'acceptance';
    assert.equal(ledger.status, report.status, 'caller acceptance label differs from independent admission');
    assert.equal(ledger.empirical_acceptance, report.empirical_acceptance, 'caller empirical label differs from independent admission');
  }
  return report;
}
function verifyNativeTrace({ receipt, current, role, baseline_receipt }, benchmark, subject, installedRuntime) {
  assert(['arch-review', 'integrator'].includes(role));
  const record = verifiedRecord(receipt);
  assert.equal(record.receipt.role, role);
  const authority = require(path.join(SCRIPTS, 'role-artifact.cjs'));
  const verdict = role === 'arch-review' ? authority.currentArchitectureVerdict(current) : authority.currentIntegrationVerdict(current);
  assert(verdict?.authenticated && verdict.dispatch_id === record.dispatch_id, 'fresh exact-current admission required');
  const runtime = record.receipt.runtime_evidence;
  assert.equal(record.receipt.runtime, 'codex', 'unchanged native runtime required');
  const progress = authority.validateReviewContinuationEvidence(runtime);
  assert.equal(progress.identity.role, role, 'foreign continuation role');
  assert.equal(progress.identity.policy_hash, record.receipt.policy_hash, 'changed continuation policy');
  assert.equal(progress.identity.worktree, fs.realpathSync(current.worktreePath), 'foreign continuation repository');
  assert.equal(progress.identity.head, current.head, 'stale continuation head');
  assert.equal(progress.identity.base, current.baseCommit, 'stale continuation base');
  assert(progress.state.original_exit?.transcript, 'original interruption history missing');
  original(progress.state.original_exit.transcript);
  assert.equal(runtime.review_continuation.original_session_id, progress.session_id, 'foreign resumed session');
  assert.equal(runtime.review_continuation.inherited_ranges, progress.completed_ranges, 'duplicate inherited credit');
  assert(progress.completed_ranges > 0 && runtime.review_continuation.newly_completed_ranges > 0, 'real interrupted reading required');
  const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs'))
    .verifyFileInput(runtime.input_bundle, { sealed: true, historical: true });
  assert.equal(runtime.input_consumption.manifest_sha256, runtime.input_bundle.manifest_sha256, 'foreign consumption');
  assert.equal(runtime.input_consumption.chunk_reads, checked.chunk_reads, 'truncated native coverage');
  assert.equal(progress.completed_ranges + runtime.review_continuation.newly_completed_ranges, checked.chunk_reads,
    'incomplete or duplicated continuation ranges');
  original({ path: progress.native_file, sha256: runtime.native_session_evidence.sha256,
    bytes: runtime.native_session_evidence.bytes });
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
  const contributors = benchmark ? verifyContributors(current.worktreePath, lineage.endpoint) : null;
  if (!benchmark) {
    assert(typeof current.coordinator_author === 'string' && current.coordinator_author.trim(), 'actual coordinator author identity required');
    assert(authors.some(author => author !== current.coordinator_author), 'another contributor repair required');
  }
  const physical = observeCompletedConsumption({ worktree: current.worktreePath,
    progress: runtime.review_continuation.progress, receipt_store: receipt.store, dispatch_id: receipt.dispatch }, installedRuntime);
  assert.equal(physical.identity.role, role, 'physical accounting role differs');
  assert.equal(physical.identity.head, current.head, 'physical accounting subject differs');
  assert.equal(physical.identity.base, current.baseCommit, 'physical accounting base differs');
  assert.equal(physical.identity.merge_base, progress.identity.merge_base, 'physical accounting merge base differs');
  equalSet(physical.identity.ticket_set, progress.identity.ticket_set, 'physical accounting complete membership');
  assert.equal(physical.identity.policy_hash, record.receipt.policy_hash, 'physical accounting policy differs');
  assert.equal(physical.evidence_pins.dispatch_id, record.dispatch_id, 'physical accounting receipt differs');
  assert.equal(physical.evidence_pins.manifest_sha256, runtime.input_bundle.manifest_sha256, 'physical accounting packet differs');
  let equivalent = null, baseline_setup = null;
  if (benchmark) {
    equivalent = equivalentObligations(benchmark, checked);
    requiredReference(baseline_receipt, 'original independent baseline receipt selector');
    const baseline = verifiedRecord(baseline_receipt);
    assert.equal(baseline.dispatch_id, lineage.baseline.dispatch_id, 'borrowed baseline receipt');
    assert.equal(baseline.receipt.role, role, 'borrowed role baseline');
    assert.equal(sha(canonical(baseline.receipt)), lineage.baseline.receipt_digest, 'eligible baseline receipt changed');
    const setup = verifyOriginalReads(baseline, baseline_receipt.native);
    baseline_setup = { dispatch: setup.dispatch, session: setup.session, turn: setup.turn, native: setup.native, metrics: setup.metrics, usage: setup.usage };
    bindNativeSubject(record, checked, subject);
    assert.deepEqual(lineage.limitations, [], 'remaining semantic limitations');
    assert(physical.metrics.successful_reads.value <= 83, 'original benchmark 10x call target not met');
    assert.equal(role === 'arch-review' ? verdict.verdict : verdict.outcome, role === 'arch-review' ? 'conform' : 'passed', 'unsuccessful final native judgment');
  }
  return { verdict, lineage, observed_contributor_authors: [...new Set(authors)],
    continuation: runtime.review_continuation, physical, native_trace_verified: true,
    metrics: physical.metrics, equivalent, baseline_setup, contributors,
    holds: benchmark ? [] : ['Original benchmark and governing subject selectors absent.'] };
}

function observeCompletedConsumption(selectors, installedRuntime) {
  assert(selectors && Object.keys(selectors).length === 4
    && ['worktree', 'progress', 'receipt_store', 'dispatch_id'].every(key => Object.hasOwn(selectors, key)),
  'only original protected completed-reference selectors allowed');
  if (installedRuntime) assert(checkedRuntimeModules.has(installedRuntime), 'independently inspected installed API required');
  const runtime = installedRuntime || require(path.join(SCRIPTS, 'codex-runtime-host.cjs'));
  const physical = runtime.verifyCompletedReviewConsumption(selectors);
  assert.equal(physical.schema, 'shipyard.completed-review-consumption.v1');
  assert.equal(physical.semantic_credit, false);
  assert.equal(physical.current_verdict_authority, false);
  const total = physical.coverage.total;
  assert.equal(physical.attempts.length, 2, 'independent interrupted and completed attempts required');
  const [prefix, fresh] = physical.attempts;
  assert.equal(prefix.status, 'interrupted'); assert.equal(fresh.status, 'completed');
  assert.equal(fresh.dispatch_id, selectors.dispatch_id);
  assert.notEqual(prefix.dispatch_id, fresh.dispatch_id);
  assert.equal(prefix.session_id, fresh.session_id);
  assert.notEqual(prefix.turn_id, fresh.turn_id);
  assert.equal(physical.coverage.prefix.successful_reads + physical.coverage.new.successful_reads, total.successful_reads);
  assert(physical.coverage.prefix.successful_reads > 0 && physical.coverage.new.successful_reads > 0);
  const observed = (value, reason) => metric(value, value === null ? reason : null);
  const sum = key => physical.attempts.reduce((value, attempt) => value + attempt[key], 0);
  const elapsed = physical.attempts.every(attempt => attempt.elapsed_ms !== null) ? sum('elapsed_ms') : null;
  const costs = completedPhysicalCosts(selectors, physical);
  const counters = {
    successful_reads: metric(sum('successful_calls')), scheduled_reads: metric(physical.scheduled_reads),
    raw_bytes: metric(costs.raw_bytes), encoded_bytes: metric(costs.encoded_bytes),
    nested_output_bytes: metric(costs.nested_bytes), outer_output_bytes: metric(costs.outer_bytes),
    failed_calls: metric(sum('failed_calls')), retries: metric(sum('retries')),
    elapsed_ms: observed(elapsed, 'At least one original attempt lacks complete monotonic timestamps.'),
    tokens: metric(null, 'Attempt usage is retained separately; no comparable per-review token total is asserted.') };
  metrics(counters);
  return { ...physical, metrics: counters };
}

function completedPhysicalCosts(selectors, physical) {
  const authenticated = require(path.join(SCRIPTS, 'role-artifact.cjs')).authenticateCompletedReviewReferences(selectors);
  const bundle = authenticated.progress.input.input_bundle;
  const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).verifyFileInput(bundle, { sealed: true, historical: true });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const assets = [{ path: bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))];
  const ranges = new Map(assets.flatMap(asset => Array.from({ length: Math.ceil(asset.bytes.length / bundle.chunk_bytes) }, (_, index) => [
    'dd if=' + quote(asset.path) + ' bs=' + bundle.chunk_bytes + ' skip=' + index + ' count=1 2>/dev/null | base64',
    asset.bytes.subarray(index * bundle.chunk_bytes, (index + 1) * bundle.chunk_bytes) ])));
  const bytes = privateOriginal({ path: physical.evidence_pins.native_file, sha256: physical.evidence_pins.native_session_sha256 });
  const records = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(records.length <= 100000, 'bounded original attempt cost records required');
  const calls = new Map(), outputs = new Set();
  const cost = { successful_calls: 0, failed_calls: 0, raw_bytes: 0, encoded_bytes: 0, nested_bytes: 0, outer_bytes: 0 };
  for (const row of records) {
    const item = row.type === 'response_item' ? row.payload : null; if (!item) continue;
    if (item.type === 'custom_tool_call' && ['exec', 'functions.exec'].includes(item.name)) {
      const match = /^\s*text\s*\(\s*await\s+tools\.exec_command\s*\(([\s\S]+)\)\s*\)\s*;?\s*$/.exec(item.input || '');
      let args; try { args = match && JSON.parse(match[1]); } catch {}
      if (!args || !ranges.has(args.cmd)) continue;
      assert(!calls.has(item.call_id), 'duplicated original attempt call'); calls.set(item.call_id, ranges.get(args.cmd));
    }
    if (item.type !== 'custom_tool_call_output' || !calls.has(item.call_id)) continue;
    assert(!outputs.has(item.call_id), 'duplicated original attempt cost'); outputs.add(item.call_id);
    assert(Array.isArray(item.output) && item.output.length === 2, 'truncated original cost envelope');
    const envelope = JSON.parse(item.output[1].text);
    assert(envelope && !Array.isArray(envelope) && Number.isInteger(envelope.exit_code) && envelope.session_id === undefined);
    assert(item.output.every(block => ['text', 'input_text'].includes(block.type) && typeof block.text === 'string')
      && /^Script completed\nWall time [0-9.]+ seconds\nOutput:\s*$/.test(item.output[0].text), 'unfinished original cost envelope');
    cost.nested_bytes += Buffer.byteLength(item.output[1].text); cost.outer_bytes += Buffer.byteLength(JSON.stringify(item.output));
    if (envelope.exit_code !== 0) { cost.failed_calls++; continue; }
    const encoded = envelope.output ?? envelope.stdout, expected = calls.get(item.call_id);
    assert(typeof encoded === 'string' && /^[A-Za-z0-9+/=\r\n]*$/.test(encoded)
      && encoded.replace(/[\r\n]/g, '') === expected.toString('base64'), 'original attempt cost differs from actual read');
    cost.successful_calls++; cost.raw_bytes += expected.length; cost.encoded_bytes += Buffer.byteLength(encoded);
  }
  for (const key of ['successful_calls', 'failed_calls'])
    assert.equal(cost[key], physical.attempts.reduce((sum, attempt) => sum + attempt[key], 0), 'attempt costs differ from supported accounting');
  return cost;
}

async function verifyNativeCapacity(input, prepared) {
  const runtime = require(path.join(SCRIPTS, 'codex-runtime-host.cjs'));
  const verified = await runtime.verifyCompletedNativeLaunch(input);
  const capacity = runtime.measureReaderCapacity(verified, prepared);
  const collector = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs'));
  const checked = collector.verifyFileInput(prepared);
  const contract = runtime.readerCapacityContract(capacity, checked.manifest);
  if (contract.schema !== 'shipyard.native-reader-transport.v3') assert.equal(contract.chunk_bytes, 131072);
  else assert.equal(contract.physical_calls, checked.manifest.batches.length);
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


function requiredReference(value, label) {
  if (!value) {
    const error = new Error(label + ': original selector absent'); error.code = 'MISSING_RECEIPT'; throw error;
  }
  return value;
}
function privateOriginal(ref) {
  const bytes = original(ref);
  const stat = fs.lstatSync(ref.path);
  assert.equal(stat.mode & 0o077, 0, 'native original must be private');
  assert.equal(stat.uid, process.getuid(), 'foreign native evidence owner');
  return bytes;
}
function nativeRecords(record, ref) {
  requiredReference(ref, 'physical native transcript');
  const evidence = record.receipt.runtime_evidence.native_session_evidence;
  assert(evidence && ref.sha256 === evidence.sha256 && ref.bytes === evidence.bytes, 'foreign native original');
  assert.equal(path.basename(ref.path), evidence.file, 'foreign original native file');
  const raw = privateOriginal(ref).toString('utf8');
  assert(raw.endsWith('\n'), 'truncated native JSONL boundary');
  const lines = raw.split('\n').filter(Boolean);
  assert(lines.length > 0 && lines.length <= 100000, 'bounded original native records required');
  const runtime = require(path.join(SCRIPTS, 'codex-runtime-host.cjs'));
  const parsed = runtime.parseNativeCodexTranscript(raw, evidence.session_id);
  assert.equal(parsed.provider, 'openai', 'foreign native provider');
  assert(parsed.selections.length && parsed.selections.every(selection =>
    selection.model === record.receipt.applied_model && selection.effort === record.receipt.applied_effort), 'native policy changed');
  const records = lines.map(line => JSON.parse(line));
  const cli = runtime.parseCodexStream(privateOriginal(record.receipt.runtime_evidence.transcript).toString('utf8'));
  assert.equal(cli.session_id, evidence.session_id, 'foreign original native/CLI session');
  const finals = cli.records.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
  const starts = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
  const ends = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
  const messages = records.filter(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'assistant' && row.payload.phase === 'final_answer');
  assert(finals.length === 1 && starts.length === 1 && ends.length === 1 && messages.length === 1, 'complete original native final required');
  assert(records.indexOf(starts[0]) < records.indexOf(messages[0]) && records.indexOf(messages[0]) < records.indexOf(ends[0]), 'reordered original native final');
  assert.equal(starts[0].payload.turn_id, ends[0].payload.turn_id, 'foreign original completed turn');
  assert.equal(messages[0].payload.content.map(block => block.text).join(''), finals[0].item.text, 'foreign original CLI/native result');
  assert.equal(ends[0].payload.last_agent_message, finals[0].item.text, 'foreign original completion result');
  return { raw, records };
}
function originalProbeDescriptor(ref) {
  const bytes = privateOriginal(ref);
  assert(bytes.length <= 1024 * 1024, 'bounded original probe manifest required');
  const manifest = JSON.parse(bytes), stat = fs.lstatSync(ref.path);
  assert(Array.isArray(manifest.assets) && manifest.assets.length > 0 && manifest.assets.length <= 64, 'bounded original probe assets required');
  return { manifest_path: ref.path, manifest_sha256: ref.sha256,
    manifest_identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode'].map(key => [key, stat[key]])),
    total_bytes: manifest.accounting.material_bytes, asset_count: manifest.assets.length,
    chunk_bytes: manifest.chunk_bytes, max_chunk_reads: manifest.max_chunk_reads,
    ...(manifest.transport ? { transport: manifest.transport } : {}) };
}
function originalAttemptStart(physical) {
  const raw = privateOriginal({ path: physical.evidence_pins.native_file,
    sha256: physical.evidence_pins.native_session_sha256 }).toString('utf8');
  const records = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(records.length <= 100000, 'bounded actual treatment records required');
  const starts = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_started'
    && row.payload.turn_id === physical.attempts[0].turn_id);
  assert.equal(starts.length, 1, 'original treatment turn missing');
  const time = Date.parse(starts[0].timestamp); assert(Number.isFinite(time), 'original treatment start timestamp missing');
  return time;
}
function verifyOriginalReads(record, native, chunkBytes, probeManifest) {
  const receipt = record.receipt, evidence = receipt.runtime_evidence;
  const bundle = evidence.input_bundle || originalProbeDescriptor(requiredReference(probeManifest, 'original probe manifest'));
  const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).verifyFileInput(bundle,
    { sealed: true, historical: true, ...(evidence.input_bundle ? { association: { role: receipt.role, dispatch_id: record.dispatch_id } } : {}) });
  const { records } = nativeRecords(record, native);
  const cli = require(path.join(SCRIPTS, 'codex-runtime-host.cjs')).parseCodexStream(privateOriginal(evidence.transcript).toString('utf8'));
  assert.equal(cli.session_id, evidence.native_session_evidence.session_id, 'foreign original CLI session');
  const cliFinals = cli.records.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
  assert.equal(cliFinals.length, 1, 'one complete original CLI final required');
  const cliStarts = cli.records.filter(row => row.type === 'turn.started'), cliEnds = cli.records.filter(row => row.type === 'turn.completed');
  assert(cliStarts.length === 1 && cliEnds.length === 1 && cli.records.indexOf(cliStarts[0]) < cli.records.indexOf(cliFinals[0])
    && cli.records.indexOf(cliFinals[0]) < cli.records.indexOf(cliEnds[0]), 'CLI lacks one ordered original complete turn');
  const starts = records.flatMap((row, index) => row.type === 'event_msg' && row.payload?.type === 'task_started' ? [index] : []);
  const finals = records.flatMap((row, index) => row.type === 'response_item' && row.payload?.type === 'message'
    && row.payload.role === 'assistant' && row.payload.phase === 'final_answer' ? [index] : []);
  const ends = records.flatMap((row, index) => row.type === 'event_msg' && row.payload?.type === 'task_complete' ? [index] : []);
  assert(starts.length === 1 && finals.length === 1 && ends.length === 1
    && starts[0] < finals[0] && finals[0] < ends[0], 'one original ordered completed turn required');
  const turn = records[starts[0]].payload.turn_id;
  assert(turn && records[ends[0]].payload.turn_id === turn, 'foreign completed native turn');
  const result = cliFinals[0].item.text;
  assert.equal(records[finals[0]].payload.content.map(block => block.text).join(''), result, 'native/CLI final mismatch');
  assert.equal(records[ends[0]].payload.last_agent_message, result, 'native completion mismatch');
  const block = chunkBytes || bundle.chunk_bytes;
  const batch = checked.manifest.transport?.schema === 'shipyard.native-reader-transport.v3';
  assert([8192, 131072].includes(block), 'unsupported observed block size');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const assets = [{ path: bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))];
  const collector = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs'));
  const ranges = batch ? checked.manifest.batches.map(entry => ({
    command: collector.batchCommand(bundle, entry.index),
    output: collector.batchOutput(checked.manifest, checked.manifest_bytes, checked.material, entry.index),
    frames: collector.batchFrames(checked.manifest, checked.manifest_bytes, checked.material, entry.index),
  })) : assets.flatMap(asset => Array.from({ length: Math.ceil(asset.bytes.length / block) }, (_, index) => ({
    command: 'dd if=' + quote(asset.path) + ' bs=' + block + ' skip=' + index + ' count=1 2>/dev/null | base64',
    bytes: asset.bytes.subarray(index * block, (index + 1) * block) })));
  assert(ranges.length > 0 && ranges.length <= 2064, 'bounded complete range inventory required');
  const seen = new Set(), outputs = new Set(), failed = new Set();
  let pending = null, at = 0, rawBytes = 0, encoded = 0, nested = 0, outer = 0, largest = 0;
  for (const [index, row] of records.entries()) {
    const item = row.type === 'response_item' ? row.payload : null;
    if (!item) continue;
    if (['custom_tool_call', 'function_call'].includes(item.type)) {
      let args;
      if (item.type === 'custom_tool_call') {
        if (!['exec', 'functions.exec'].includes(item.name)) continue;
        const match = /^\s*text\s*\(\s*await\s+tools\.exec_command\s*\(([\s\S]+)\)\s*\)\s*;?\s*$/.exec(item.input || '');
        try { args = match && JSON.parse(match[1]); } catch {}
      } else if (/(?:^|[._])exec_command$/.test(item.name || '')) {
        try { args = JSON.parse(item.arguments); } catch {}
      }
      if (!args || typeof args.cmd !== 'string' || !(batch ? args.cmd.includes('--read-batch') : assets.some(asset => args.cmd.startsWith('dd if=' + quote(asset.path) + ' ')))) continue;
      assert(index > starts[0] && index < finals[0], 'read outside original completion');
      assert(item.internal_chat_message_metadata_passthrough?.turn_id === undefined
        || item.internal_chat_message_metadata_passthrough.turn_id === turn, 'foreign reader turn');
      assert(!pending && args.cmd === ranges[at]?.command, 'reordered or duplicate observed range');
      assert(typeof item.call_id === 'string' && !seen.has(item.call_id), 'replayed original reader call');
      assert(Object.keys(args).every(key => ['cmd', 'max_output_tokens'].includes(key)), 'unsupported reader arguments');
      if (batch || block === 131072) assert(item.type === 'custom_tool_call' && args.max_output_tokens === 10000, 'changed output policy');
      seen.add(item.call_id); pending = { id: item.call_id, custom: item.type === 'custom_tool_call' };
    }
    if (!['custom_tool_call_output', 'function_call_output'].includes(item.type) || !seen.has(item.call_id)) continue;
    assert(!outputs.has(item.call_id) && pending?.id === item.call_id, 'replayed or unmatched output');
    outputs.add(item.call_id);
    assert(index < finals[0], 'read completed after native final');
    let value = item.output, envelope;
    const outerBytes = Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
    assert(outerBytes <= 256 * 1024, 'outer output exceeds bound');
    if (batch && pending.custom) {
      const complete = Array.isArray(value) && value.length === 2 && value.every(part => part.type === 'text')
        && /^Script completed\nWall time [0-9.]+ seconds\nOutput:\s*$/.test(value[0].text);
      let result;
      if (complete) { try { result = JSON.parse(value[1].text); } catch {} }
      if (!complete || !result || Array.isArray(result) || result.truncated === true
          || result.original_token_count !== undefined || result.session_id !== undefined
          || result.exit_code !== 0 || result.output !== ranges[at].output) {
        outer += outerBytes;
        if (complete) nested += Buffer.byteLength(value[1].text);
        failed.add(item.call_id); pending = null; continue;
      }
    }
    if (pending.custom) {
      assert(Array.isArray(value) && value.length === 2 && value.every(part => part.type === 'text'), 'truncated outer envelope');
      assert(/^Script completed\nWall time [0-9.]+ seconds\nOutput:\s*$/.test(value[0].text), 'unfinished outer output');
      const result = JSON.parse(value[1].text);
      assert(result && !Array.isArray(result) && typeof result === 'object', 'unsupported nested output');
      const nestedBytes = Buffer.byteLength(value[1].text);
      assert(nestedBytes <= 256 * 1024, 'nested output exceeds bound'); nested += nestedBytes;
      envelope = result;
    } else { envelope = JSON.parse(value); nested += Buffer.byteLength(value); }
    assert(Number.isInteger(envelope.exit_code) && envelope.session_id === undefined, 'unfinished read');
    outer += outerBytes;
    if (envelope.exit_code !== 0) { failed.add(item.call_id); pending = null; continue; }
    value = envelope.output ?? envelope.stdout;
    if (batch) {
      assert(envelope.original_token_count === undefined && envelope.truncated !== true, 'truncated batch envelope');
      assert.equal(value, ranges[at].output, 'truncated or altered finite batch frames');
      encoded += ranges[at].frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.base64), 0);
      rawBytes += ranges[at].frames.reduce((sum, frame) => sum + frame.bytes, 0);
      largest = Math.max(largest, outerBytes); at++; pending = null; continue;
    }
    assert(typeof value === 'string' && /^[A-Za-z0-9+/=\r\n]*$/.test(value)
      && value.replace(/[\r\n]/g, '') === ranges[at].bytes.toString('base64'), 'truncated or altered encoded range');
    encoded += Buffer.byteLength(value); rawBytes += ranges[at].bytes.length;
    largest = Math.max(largest, outerBytes); at++; pending = null;
  }
  assert.equal(at, ranges.length, 'incomplete original observed coverage'); assert.equal(pending, null, 'pending original read');
  const times = records.slice(starts[0], ends[0] + 1).map(row => Date.parse(row.timestamp));
  const elapsed = times.every(Number.isFinite) && times.every((time, i) => !i || time >= times[i - 1])
    ? times.at(-1) - times[0] : null;
  const counters = { successful_reads: metric(at), scheduled_reads: metric(ranges.length), failed_calls: metric(failed.size),
    retries: metric(failed.size), raw_bytes: metric(rawBytes), encoded_bytes: metric(encoded),
    nested_output_bytes: metric(nested), outer_output_bytes: metric(outer),
    elapsed_ms: metric(elapsed, elapsed === null ? 'Original timestamps incomplete or nonmonotonic.' : null),
    tokens: metric(null, 'Comparable review token total unavailable; original CLI usage retained separately.') };
  metrics(counters);
  return { dispatch: record.dispatch_id, session: evidence.native_session_evidence.session_id, turn, metrics: counters,
    largest_envelope_bytes: largest, full_128k_ranges: batch ? 0 : ranges.filter(range => range.bytes.length === 131072).length,
    ...(batch ? { schema: 'shipyard.native-reader-capacity.v3', profile_sha256: checked.manifest.transport.profile_sha256,
      logical_ranges: checked.manifest.ranges.length, physical_calls: at } : {}),
    checked, completed_at: Date.parse(records[ends[0]].timestamp),
    usage: cli.records.filter(row => row.type === 'turn.completed').map(row => row.usage), native };
}
function logicalInventory(checked) {
  const packets = require(path.join(SCRIPTS, 'context-packet.cjs'));
  const obligations = checked.material.flatMap(bytes => {
    const value = JSON.parse(bytes), packet = value.schema === 'shipyard.semantic-content.v1' ? packets.decodeUniqueContent(value) : value;
    return packets.encodeUniqueContent(packet).obligations;
  });
  assert(obligations.length > 0 && obligations.length <= 20000, 'bounded complete logical obligations required');
  return obligations.map(row => canonical({ source_path: row.source_path, source_revision: row.source_revision,
    source_sha256: row.source_sha256, source_bytes: row.source_bytes, content_sha256: row.content_sha256,
    mandatory: row.mandatory, purpose: row.purpose, provenance: row.provenance })).sort();
}
function equivalentObligations(benchmark, checked) {
  const originalRecord = verifiedRecord(benchmark.authority);
  const context = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs'));
  const originalChecked = context.verifyFileInput(originalRecord.receipt.runtime_evidence.input_bundle, { sealed: true, historical: true });
  const required = logicalInventory(originalChecked), actual = logicalInventory(checked), available = new Map();
  for (const row of actual) available.set(row, (available.get(row) || 0) + 1);
  const packets = require(path.join(SCRIPTS, 'context-packet.cjs'));
  const completeOriginalAssets = originalChecked.material.every(bytes => checked.material.some(current => {
    const value = JSON.parse(current);
    const encoded = value.schema === 'shipyard.semantic-content.v1' ? value : packets.encodeUniqueContent(value);
    packets.decodeUniqueContent(encoded);
    return encoded.dictionary.some(entry => entry.sha256 === sha(bytes) && entry.bytes === bytes.length)
      && encoded.obligations.some(obligation => obligation.content_sha256 === sha(bytes) && obligation.mandatory);
  }));
  if (!completeOriginalAssets) for (const row of required) {
    assert(available.get(row) > 0, 'missing original equivalent logical obligation');
    available.set(row, available.get(row) - 1);
  }
  return { complete: true, original_obligations: required.length, original_digest: sha(canonical(required)),
    treatment_obligations: actual.length, complete_original_assets: completeOriginalAssets, semantic_authority: 'independent fresh current-role consumer' };
}
function verifyContributors(worktree, endpoint) {
  for (const key of ['from', 'to']) assert(/^[a-f0-9]{40}$/.test(endpoint[key]), 'complete endpoint revision required');
  const commits = gitBytes(worktree, 'rev-list', '--max-count=1001', endpoint.from + '..' + endpoint.to).toString().trim().split('\n').filter(Boolean);
  assert(commits.length > 0 && commits.length <= 1000, 'bounded actual repair history required');
  const contributors = commits.map(commit => {
    const source = verifySourceHistory({ worktree, commit });
    const parents = gitBytes(worktree, 'rev-list', '--parents', '-n', '1', commit).toString().trim().split(' ').slice(1);
    const changed = parents.length ? gitBytes(worktree, 'diff', '--name-only', '-z', parents[0], commit).toString().split('\0').filter(Boolean) : [];
    if (!['executor', 'fixer'].includes(source.kind) || !changed.length) return { commit, kind: source.kind, other_contributor: false };
    const record = verifiedRecord({ store: source.receipt_store, dispatch: source.dispatch_id });
    assert.equal(record.dispatch_id, source.dispatch_id);
    return { commit, dispatch: record.dispatch_id, ticket: record.ticket, changed,
      other_contributor: /^T-49-\d{2}$/.test(record.ticket || '')
        && (record.ticket !== 'T-49-11' || source.kind === 'fixer'), contributor_role: record.receipt.role };
  });
  assert(contributors.some(row => row.other_contributor), 'authenticated other-contributor repair required');
  return contributors;
}
function bindNativeSubject(record, checked, subject) {
  identity(subject);
  const runtime = record.receipt.runtime_evidence, manifest = checked.manifest;
  assert.equal(record.receipt.runtime, subject.runtime); assert.equal(runtime.provider, subject.provider);
  assert.equal(record.receipt.policy_hash, subject.policy); assert.equal(manifest.snapshot.policy_hash, subject.policy);
  for (const [key, observed] of [['head', manifest.snapshot.head], ['base', manifest.binding.base],
    ['merge_base', manifest.binding.merge_base]]) assert.equal(observed, subject[key], 'governing ' + key + ' differs');
  equalSet(manifest.binding.ticket_set, subject.ticket_set, 'governing full membership');
  assert.equal(manifest.snapshot.repository, subject.repository, 'governing repository differs');
  assert.equal(manifest.binding.ticket_set_digest, subject.ticket_set_digest, 'governing membership digest differs');
  for (const relative of ['codex-runtime-host.cjs', 'role-artifact.cjs', 'model-policy.cjs']) {
    const pin = manifest.snapshot.sources.find(row => path.basename(row.path) === relative);
    assert(pin && pin.sha256 === sha(read(path.join(SCRIPTS, relative))), 'unchanged native kernel/policy required');
  }
  assert(subject.installed_files?.[manifest.role] && manifest.binding.installed_files, 'actual installed consumer pins required');
  assert.deepEqual(manifest.binding.installed_files, subject.installed_files[manifest.role], 'installed consumers differ');
  assert(manifest.binding.installed_files.length > 0, 'installed instructions absent');
  for (const pin of manifest.binding.installed_files) original(pin);
}
function verifyCapacityReference(ref, subject, traces) {
  requiredReference(ref, 'original capacity probe');
  if (ref.schema === 'shipyard.native-reader-capacity.v3') return verifyFiniteCapacityReference(ref, subject, traces);
  const record = verifiedRecord(ref.receipt), observed = verifyOriginalReads(record, ref.native, 131072, ref.probe_manifest);
  bindNativeSubject(record, observed.checked, subject);
  assert(observed.full_128k_ranges > 0, 'complete first 128KiB encoded range absent');
  const runtime = record.receipt.runtime_evidence;
  assert.equal(runtime.native_session_evidence.session_id, observed.session);
  for (const trace of traces) {
    const contract = trace.transport;
    assert(contract && contract.chunk_bytes === 131072 && contract.output_tokens === 10000, 'unsupported treatment transport');
    assert.equal(contract.native_sha256, ref.native.sha256, 'foreign capacity probe');
    assert.equal(contract.native_session_id, observed.session, 'foreign capacity session');
    assert.equal(contract.policy_hash, subject.policy, 'capacity policy changed');
    assert.equal(contract.output_budget_bytes, observed.largest_envelope_bytes + 4096, 'invented capacity budget');
    assert(observed.completed_at < trace.started_at, 'first capacity probe did not precede actual treatment');
    assert.equal(contract.encoded_bytes, observed.metrics.encoded_bytes.value, 'invented encoded capacity');
    assert.deepEqual(contract.selection, runtime.native_session_evidence.selections[0], 'capacity selection drift');
    const probeManifest = observed.checked.manifest;
    assert.equal(contract.binding_sha256, sha(canonical([probeManifest.snapshot, probeManifest.run_id, probeManifest.ticket,
      probeManifest.phase, probeManifest.role, probeManifest.dispatch_id, probeManifest.binding,
      probeManifest.accounting.generated_instruction_bytes || 0,
      probeManifest.assets.map(asset => [asset.ordinal, asset.bytes, asset.sha256])])), 'capacity original subject differs');
    assert.deepEqual(probeManifest.assets.map(asset => [asset.ordinal, asset.bytes, asset.sha256]), trace.assets,
      'capacity asset substitution');
    assert.equal(probeManifest.role, trace.role, 'capacity borrowed across roles');
    require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).preflightReaderSchedule(trace.manifest, trace.manifest_bytes);
  }
  return { block_bytes: 131072, complete: true, probe: ref.receipt, native: ref.native,
    metrics: observed.metrics, observed_encoded_bytes: observed.largest_envelope_bytes + 4096,
    required_encoded_bytes: traces.length ? Math.max(...traces.map(trace => trace.schedule.largest_envelope_bytes)) : null };
}
function verifyFiniteCapacityReference(ref, subject, traces) {
  assert.equal(traces.length, 1, 'one independent finite role required');
  const record = verifiedRecord(ref.receipt);
  const observed = verifyOriginalReads(record, ref.native, undefined, ref.probe_manifest);
  assert.equal(observed.schema, 'shipyard.native-reader-capacity.v3', 'finite original schedule absent');
  bindNativeSubject(record, observed.checked, subject);
  const trace = traces[0], manifest = observed.checked.manifest;
  assert.equal(manifest.role, trace.role, 'borrowed finite capacity role');
  assert.deepEqual(manifest, trace.manifest, 'finite capacity subject/material/instruction/schedule differs');
  assert(observed.completed_at < trace.started_at, 'finite measurement must precede treatment');
  const contract = trace.reader_capacity;
  assert(contract && contract.schema === 'shipyard.native-reader-transport.v3', 'protected finite capacity absent');
  const authority = require(path.join(SCRIPTS, 'role-artifact.cjs'));
  const application = authority.authenticateReaderCapacityReferences({ worktree: manifest.snapshot.worktree,
    receipt_store: contract.application_receipt_store, dispatch_id: contract.application_dispatch_id });
  assert.equal(sha(canonical(application.receipt)), contract.application_receipt_sha256, 'finite capacity receipt changed');
  assert.equal(contract.native_sha256, ref.native.sha256, 'foreign finite native measurement');
  assert.equal(contract.native_session_id, observed.session, 'foreign finite session');
  assert.equal(contract.profile_sha256, observed.profile_sha256, 'finite profile differs');
  assert.equal(contract.manifest_sha256, record.receipt.runtime_evidence.input_bundle.manifest_sha256, 'finite manifest differs');
  assert.equal(contract.schedule_sha256, sha(JSON.stringify(manifest.batches)), 'finite schedule differs');
  assert.deepEqual(contract.selection, record.receipt.runtime_evidence.native_session_evidence.selections[0], 'finite selection differs');
  assert.equal(contract.native_bytes, ref.native.bytes, 'finite native length differs');
  assert.equal(contract.output_tokens, 10000, 'finite output policy changed');
  assert.equal(contract.physical_calls, observed.physical_calls, 'invented finite calls');
  assert.equal(contract.logical_ranges, observed.logical_ranges, 'invented finite ranges');
  assert.equal(contract.encoded_bytes, observed.metrics.encoded_bytes.value, 'invented finite bytes');
  assert.equal(contract.largest_envelope_bytes, observed.largest_envelope_bytes, 'invented finite envelope');
  return { schema: ref.schema, role: trace.role, candidate: subject.candidate, policy: subject.policy,
    complete: true, physical_calls: observed.physical_calls, logical_ranges: observed.logical_ranges,
    profile_sha256: observed.profile_sha256, observed_encoded_bytes: observed.largest_envelope_bytes,
    required_encoded_bytes: observed.largest_envelope_bytes, metrics: observed.metrics };
}
function verifyCI(ref, head) {
  requiredReference(ref, 'exact-source full CI');
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repository || '') && /^\d+$/.test(String(ref.run_id)), 'original CI selectors required');
  const args = ['run', 'view', String(ref.run_id), '--repo', ref.repository];
  const gh = suffix => {
    try { return execFileSync('gh', [...args, ...suffix], { timeout: 30000, maxBuffer: MAX_BYTES }); }
    catch (error) {
      if (/error connecting|network|timed? ?out|authentication|rate limit/i.test(String(error.stderr || error.message)))
        error.code = 'CI_AUTHORITY_UNAVAILABLE';
      throw error;
    }
  };
  const ci = JSON.parse(gh(['--json', 'headSha,status,conclusion,jobs']));
  assert.equal(ci.headSha, head, 'stale exact-source CI');
  if (ci.status !== 'completed' || ci.conclusion !== 'success') {
    const error = new Error('original exact-source full CI is ' + ci.status + '/' + ci.conclusion);
    error.code = 'CI_PREREQUISITE_UNMET'; throw error;
  }
  assert(Array.isArray(ci.jobs) && ci.jobs.length <= 1000, 'bounded complete CI jobs required');
  assert(ci.jobs.every(job => job.status === 'completed' && job.conclusion === 'success'), 'partial or skipped CI');
  const job = ci.jobs.find(row => row.name === 'test-fast'); assert(job, 'full test-fast job missing');
  for (const name of ['publish gate', 'runtime digest trailer', 'make test-fast']) {
    const step = job.steps.find(row => row.name === name);
    assert(step && step.status === 'completed' && step.conclusion === 'success', 'incomplete full CI step');
  }
  const log = original(requiredReference(ref.original_full_log, 'complete original CI log'));
  assert.deepEqual(gh(['--log']), log, 'full original CI log differs from live original run');
  return { ...ci, original_full_log: ref.original_full_log };
}
function validateBuildPins(candidate, selected, launch, build, copy, outputs) {
  assert.equal(launch.ticket, 'T-49-17'); assert.equal(launch.role, 'executor');
  assert.equal(launch.worktree, candidate.publication_source.worktree);
  assert.equal(launch.source_head, selected.source.head); assert.equal(launch.baseline_tree, selected.source.tree);
  assert.equal(launch.tracked_clean, true); assert.equal(launch.head_still_pinned, true);
  assert(Number.isSafeInteger(launch.native_process_id) && launch.native_process_id > 0);
  assert.equal(build.root, candidate.selection_root); assert.equal(build.selection_sha256, candidate.selection.sha256);
  assert.equal(build.source_head, selected.source.head); assert.equal(build.source_tree, selected.source.tree);
  assert.equal(build.outputs, 161); assert.equal(build.build_calls, 1); assert.equal(build.published, 0);
  assert.equal(selected.build_calls, 1);
  assert.equal(copy.selection_sha256, candidate.selection.sha256); assert.equal(copy.source_head, selected.source.head);
  assert.equal(copy.build_calls, 1); assert.equal(copy.canonical_inputs, 162); assert.equal(copy.complete_outputs, 161);
  assert.equal(copy.unchanged_outputs_verified, 153); equalSet(copy.published, outputs, 'original eight generated copies');
  return true;
}
function verifyPrelaunchCopy(launch, copy) {
  const ref = requiredReference(launch.prelaunch_observation, 'original prelaunch observation');
  let bytes;
  if (copy !== undefined) {
    requiredReference(copy, 'private original prelaunch copy');
    assert.equal(copy.sha256, ref.sha256, 'other prelaunch copy digest');
    assert(Number.isSafeInteger(copy.bytes) && copy.bytes > 0 && copy.bytes <= 1024 * 1024,
      'complete bounded prelaunch copy length required');
    bytes = privateOriginal(copy);
    assert.deepEqual(bytes, original(ref), 'prelaunch copy differs from original deep reference');
  } else bytes = privateOriginal(ref);
  assert(bytes.length <= 1024 * 1024, 'bounded original prelaunch metadata required');
  const prelaunch = JSON.parse(bytes);
  for (const key of ['ticket', 'role', 'worktree', 'baseline_head', 'baseline_tree', 'source_head', 'merge_proof']) {
    assert(typeof launch[key] === 'string' && launch[key], 'original launch scope missing');
    assert.equal(prelaunch[key], launch[key], 'prelaunch scope differs: ' + key);
  }
  assert.equal(prelaunch.tracked_clean, true, 'original prelaunch was dirty');
  assert.equal(launch.tracked_clean, true, 'original clean launch was dirty');
  for (const key of ['baseline_head', 'baseline_tree', 'source_head'])
    assert(/^[a-f0-9]{40}$/.test(prelaunch[key]), 'original prelaunch identity missing');
  return prelaunch;
}
function verifyInitialBuildAncestry(candidate, selected, launch, prelaunch) {
  assert.equal(launch.source_head, selected.source.head, 'other selected build source');
  assert.equal(candidate.producer.commit, selected.source.head, 'other original producer');
  assert.equal(candidate.producer.worktree, selected.source.worktree, 'other producer checkout');
  assert.equal(launch.worktree, candidate.publication_source.worktree, 'other initial actor checkout');
  const producer = verifySourceHistory(candidate.producer);
  const baseline = verifySourceHistory({ worktree: launch.worktree, commit: prelaunch.baseline_head });
  const publication = verifySourceHistory(candidate.publication_source);
  assert.equal(baseline.kind, 'base-merge', 'original protected initial base-merge required');
  assert.equal(baseline.ticket, 'T-49-17', 'foreign initial baseline ticket');
  assert.equal(baseline.repository_id, producer.repository_id, 'foreign initial baseline repository');
  assert.equal(publication.repository_id, producer.repository_id, 'foreign publication repository');
  assert.equal(baseline.tree, prelaunch.baseline_tree, 'other covered baseline tree');
  assert.equal(baseline.tree, selected.source.tree, 'initial baseline changed selected whole tree');
  gitBytes(launch.worktree, 'verify-commit', baseline.commit);
  verifySourceTransition(candidate, { ...producer, worktree: candidate.producer.worktree },
    { ...baseline, worktree: launch.worktree }, candidate.source_transition);
  gitBytes(candidate.publication_source.worktree, 'merge-base', '--is-ancestor', baseline.commit, publication.commit);
  assert.equal(selected.inputs.length, 162, 'complete selected build inputs required');
  compareCanonicalInputs(selected.inputs, sourceInputs(launch.worktree, baseline.commit));
  compareCanonicalInputs(selected.inputs, sourceInputs(candidate.publication_source.worktree, publication.commit));
}
function verifyInitialBuildActor(candidate, selected, publication) {
  const custody = JSON.parse(privateOriginal(requiredReference(candidate.build_origin, 'original initial build custody')));
  const pins = {
    original_native: '691d5cd1b171645cf745701a1a97ecbd5a1fb5d673fa658f3acda10e3d721700',
    original_cli: '8b5741a32b28c4a0006ae0af098a328050e0072777068ca998869259f6beccbc',
    clean_launch: 'b84faa5ac72c5beac9b96b91f17682cd1607bbed216ef01fc88160c13fc0b367',
    original_once_build: '32277e866710550faaeffd0334599299b6dd7eafdf02c370a3a2de99b6732cef',
    original_eight_output_copy: '6e186575670e53d73b28219c37863b2d61a20d9c2fc298ade853f057d69d33a5',
    original_failed_result: 'd56539439e46982bdb4fdbb73409bb76bb95e9200e25f8248ab2237717aed9f4'
  };
  const bytes = {};
  for (const [key, digest] of Object.entries(pins)) {
    assert.equal(custody[key]?.sha256, digest, 'other original build record');
    bytes[key] = privateOriginal(custody[key]);
  }
  assert.equal(custody.receipt.dispatch, 'dispatch-mv6xft2r-583b45a2-8996-4290-9914-5319654faaba');
  const record = verifiedRecord(custody.receipt), runtime = record.receipt.runtime_evidence;
  assert.equal(record.receipt.role, 'executor'); assert.equal(runtime.ticket, 'T-49-17');
  assert.equal(runtime.runtime, 'codex'); assert.equal(runtime.provider, 'openai');
  assert.equal(record.receipt.policy_hash, publication.receipt.policy_hash, 'initial build policy differs');
  assert.equal(runtime.native_session_evidence.session_id, '01a13635-4dc2-7cc3-8355-9b1976aba60e');
  assert.equal(runtime.native_session_evidence.sha256, custody.original_native.sha256);
  assert.equal(runtime.native_session_evidence.bytes, bytes.original_native.length);
  assert.equal(runtime.transcript.sha256, custody.original_cli.sha256);
  assert.equal(runtime.transcript.bytes, bytes.original_cli.length);
  const launch = JSON.parse(bytes.clean_launch);
  assert.equal(runtime.process_id, launch.native_process_id); assert.equal(runtime.process_id, 66450);
  assert.equal(runtime.worktree, launch.worktree);
  assert.equal(sha(JSON.stringify(runtime.command.args)), runtime.command_digest, 'original native command digest differs');
  assert.equal(runtime.command.executable, 'codex');
  assert(runtime.command.args.includes('exec') && runtime.command.args.includes(launch.worktree), 'original native command scope differs');
  assert.equal(launch.prelaunch_observation?.sha256, '04f772e4cb92a8e26334ec07a130b1719b08d468f87568aa6e45c03d5f7e73a1',
    'other original prelaunch observation');
  const prelaunch = verifyPrelaunchCopy(launch, candidate.build_origin.prelaunch_copy);
  assert.equal(gitBytes(launch.worktree, 'rev-parse', prelaunch.baseline_head + '^{tree}').toString().trim(), prelaunch.baseline_tree);
  verifyInitialBuildAncestry(candidate, selected, launch, prelaunch);
  validateBuildPins(candidate, selected, launch, JSON.parse(bytes.original_once_build),
    JSON.parse(bytes.original_eight_output_copy), publicationInspector().BATCH_OUTPUTS.map(name => 'plugins/shipyard/' + name));
  const failed = bytes.original_failed_result.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(failed.length > 0 && failed.length <= 1000);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'verification_failed', 'failed initial verification relabeled');
  assert.equal(failed[0].dispatch_id, 'dispatch-mv6yc1d6-9040c03a-51c6-423d-8645-ad7260a741ee');
  return { record, ref: custody.original_native, bytes: bytes.original_native, worktree: launch.worktree,
    failed_verification: custody.original_failed_result };
}
function verifyBuildOrigin(candidate, selected) {
  const source = verifySourceHistory(requiredReference(candidate.publication_source, 'original15 actor native source'));
  const record = verifiedRecord({ store: source.receipt_store, dispatch: source.dispatch_id });
  assert.equal(record.receipt.role, 'executor', 'build did not follow actual native15 executor');
  if (!candidate.finite_predecessor) assert.equal(source.dispatch_id, 'dispatch-mv2znskv-36e55516-35d6-4859-8908-c17728324c3b');
  const initial = candidate.finite_predecessor ? verifyInitialBuildActor(candidate, selected, record) : null;
  const actor = initial?.record || record;
  const finalNative = requiredReference(candidate.publication_native, 'original successful publication native stream');
  const finalEvidence = record.receipt.runtime_evidence.native_session_evidence;
  assert.equal(finalNative.sha256, finalEvidence.sha256); assert.equal(finalNative.bytes, finalEvidence.bytes);
  assert.equal(path.basename(finalNative.path), finalEvidence.file);
  privateOriginal(finalNative);
  const ref = initial?.ref || finalNative;
  const evidence = actor.receipt.runtime_evidence.native_session_evidence;
  assert.equal(ref.sha256, evidence.sha256); assert.equal(ref.bytes, evidence.bytes);
  assert.equal(path.basename(ref.path), evidence.file);
  const bytes = privateOriginal(ref);
  const parsed = require(path.join(SCRIPTS, 'codex-runtime-host.cjs')).parseNativeCodexTranscript(bytes.toString('utf8'), evidence.session_id);
  assert(parsed.selections.length > 0 && parsed.selections.every(row => row.model === actor.receipt.applied_model && row.effort === actor.receipt.applied_effort));
  const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(rows.length <= 100000, 'bounded original actor stream required');
  const meta = rows.filter(row => row.type === 'session_meta'); assert.equal(meta.length, 1);
  assert.equal(fs.realpathSync(meta[0].payload.cwd), initial?.worktree || candidate.publication_source.worktree);
  const started = Date.parse(meta[0].timestamp || meta[0].payload.timestamp);
  const stage = fs.lstatSync(candidate.stage), selection = fs.lstatSync(candidate.selection.path);
  assert(stage.isDirectory() && fs.realpathSync(candidate.stage) === candidate.stage, 'nonphysical immutable stage');
  assert(Number.isFinite(started) && stage.birthtimeMs > started && selection.birthtimeMs >= stage.birthtimeMs,
    'old stage or selection preceded actual native15 actor');
  assert.equal(selected.build_calls, 1, 'signed original once-built selection required');
  return { dispatch: actor.dispatch_id, publication_dispatch: source.dispatch_id,
    failed_initial_verification: initial?.failed_verification || null, semantic_credit: false, original_native: ref, source_commit: source.commit,
    selection_sha256: candidate.selection.sha256, signed_build_calls: selected.build_calls,
    original_actor_started_ms: started, original_stage_created_ms: stage.birthtimeMs };
}
function verifyVersions(refs, runtimeRoot) {
  requiredReference(refs, 'isolated and unchanged global GSD versions');
  const version = ref => {
    requiredReference(ref, 'actual GSD version file');
    const bytes = original(ref); assert(bytes.length <= 1024 * 1024, 'bounded original version file required');
    const value = ref.format === 'package-json' ? JSON.parse(bytes).version : bytes.toString('utf8').trim();
    assert(typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value), 'actual GSD version required');
    return value;
  };
  requiredReference(refs.isolated, 'actual isolated GSD version');
  requiredReference(refs.global, 'actual unchanged global GSD version');
  assert.equal(refs.isolated.path, path.join(runtimeRoot, 'gsd-core/VERSION'), 'actual isolated GSD VERSION file required');
  assert.equal(refs.global.path, path.join(require('node:os').homedir(), '.codex/gsd-core/VERSION'), 'actual global GSD VERSION file required');
  assert(refs.isolated.format !== 'package-json' && refs.global.format !== 'package-json', 'installed VERSION text required');
  const observed = { isolated: version(refs.isolated), global: version(refs.global) };
  assert.equal(observed.global, '1.14.0', 'global GSD changed');
  return observed;
}
function verifyPrerequisites(candidate) {
  const refs = requiredReference(candidate.prerequisites, '12/13/14 original source and CI');
  for (const ticket of ['T-49-12', 'T-49-13', 'T-49-14']) {
    const ref = requiredReference(refs[ticket], ticket);
    if (ref.source_transition) assert.equal(ref.source_transition.ticket, ticket, 'other prerequisite transition');
    const source = verifySourceHistory(requiredReference(ref.source, ticket + ' signed source')); verifyCI(ref.ci, ref.source.commit);
    assert.equal(source.repository_id, verifySourceHistory(candidate.current_source).repository_id, 'foreign prerequisite repository');
    verifySourceTransition(candidate, { ...source, worktree: ref.source.worktree },
      { ...verifySourceHistory(candidate.current_source), worktree: candidate.current_source.worktree }, ref.source_transition);
  }
  const historical = JSON.parse(original(candidate.mode_predecessor.selection));
  compareCanonicalInputs(historical.inputs, sourceInputs(historical.source.worktree, historical.source.head));
  const originalSource = verifySourceHistory({ worktree: historical.source.worktree, commit: historical.source.head });
  assert.equal(originalSource.dispatch_id, historical.source.original_dispatch, 'original13 producer native authority differs');
  assert.equal(candidate.mode_predecessor.selection.sha256, '998663f1d220924f4ca57ed8407200baebac7f0d8ebd1b4c7e14244f73c3f265', 'original13 selection changed');
  assert.equal(historical.source.head, '22f0064d2123f7ab72362396bb9ea1800c5b3655');
  const history = requiredReference(candidate.history, 'original09/retired10 history');
  const original09 = JSON.parse(original(requiredReference(history.original09_selection, 'original6325 selection')));
  assert.equal(history.original09_selection.sha256, '92270f73cc794f9e3d121767c186330e4d50f8fa44a91750da8f50a3a438be36');
  compareCanonicalInputs(original09.inputs, sourceInputs(original09.source.worktree, original09.source.head));
  assert.equal(original09.outputs.length, 161); assert.equal(historical.outputs.length, 161);
  const changed = historical.outputs.filter(output => {
    const old = original09.outputs.find(row => row.path === output.path); assert(old, 'original09 output omitted');
    return old.sha256 !== output.sha256 || old.bytes !== output.bytes || old.publication_mode !== output.publication_mode;
  }).map(row => row.path).sort();
  assert.deepEqual(changed, ['host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs', 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
    '.codex-plugin/plugin.json', 'package-build.json'].sort(), 'original13 fourchange/unchanged157 history differs');
  verifySourceHistory(requiredReference(history.original09_source, 'original09 native source'));
  verifyCI(history.original09_ci, history.original09_source.commit);
  const retired = verifySourceHistory(requiredReference(history.retired10_source, 'retired10 unmerged source'));
  assert.equal(retired.commit, '17e38e440d8626f00002f3a33e7136fe893bcbd5');
  assert.equal(history.retired10_failed_ci.sha256, '336c66b94af66ba5bad71cc1e362d8fdf359e5a442e6824411fe48a6ac6cf16f');
  original(history.retired10_failed_ci);
  const row = historical.outputs.find(row => row.path.endsWith('/ticket-worktree.sh'));
  assert.equal(row.publication_mode, 0o644, 'original13 failed installation relabelled');
  requiredReference(refs['T-49-13'].failed_installation, 'original failed13 installation');
  const failure = JSON.parse(original(refs['T-49-13'].failed_installation));
  assert(Array.isArray(failure) && failure.length === 1, 'original13 installed failure inventory differs');
  const mismatch = failure[0];
  assert.deepEqual(mismatch, { path: 'host/plugins/delivery-pipeline/scripts/ticket-worktree.sh', expected: '0o644', actual: '0o755' }, 'original13 mode failure changed');
  assert.equal(refs['T-49-13'].failed_installation.sha256, 'ebafda6a3be49705de96ec90cc3a82f01be583f08c0d9b8ce403315ebe7e67bd', 'original13 failure digest changed');
  return true;
}
function reviewObservation(ref) {
  const record = verifiedRecord(ref.receipt);
  assert(['arch-review', 'integrator'].includes(ref.role) && record.receipt.role === ref.role, 'observation role differs');
  const authority = require(path.join(SCRIPTS, 'role-artifact.cjs'));
  const verdict = ref.role === 'arch-review' ? authority.currentArchitectureVerdict(ref.current) : authority.currentIntegrationVerdict(ref.current);
  assert(verdict?.authenticated && verdict.dispatch_id === record.dispatch_id, 'original observation needs fresh admitted native verdict');
  const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).verifyFileInput(record.receipt.runtime_evidence.input_bundle,
    { sealed: true, historical: true });
  const packet = require(path.join(SCRIPTS, 'context-packet.cjs')).decodeUniqueContent(JSON.parse(checked.material[0]));
  const coverage = packet.review_coverage || packet.role_context?.review_coverage;
  assert(coverage?.schema === 'shipyard.review-coverage-lineage.v1', 'observation lacks independently authenticated coverage');
  return { record, checked, verdict, coverage };
}
function verifyFocusedObservations(observations, finals, subject, installedRuntime, installed) {
  requiredReference(observations, 'focused fallback/expansion/refusal observations');
  const required = [...CHECKS, 'hidden-delta'];
  assert(Array.isArray(observations) && observations.length <= required.length * 2, 'bounded focused observation matrix required');
  const names = observations.map(row => row.role + ':' + row.kind);
  assert(new Set(names).size === names.length && observations.every(row => ['arch-review', 'integrator'].includes(row.role) && required.includes(row.kind)), 'forged or repeated observation identity');
  if (observations.length !== required.length * 2) requiredReference(null, 'complete both-role focused observations');
  equalSet(names, ['arch-review', 'integrator'].flatMap(role => required.map(kind => role + ':' + kind)), 'focused observations');
  const checked = [];
  for (const ref of observations) {
    const final = finals.find(row => row.role === ref.role);
    assert(final, 'observation lacks eligible role baseline');
    if (['full-fallback', 'changed-base-expansion', 'shared-contract-expansion'].includes(ref.kind)) {
      const observed = reviewObservation(ref), coverage = observed.coverage;
      const manifest = observed.checked.manifest;
      bindNativeSubject(observed.record, observed.checked, { ...subject, head: manifest.snapshot.head,
        base: manifest.binding.base, merge_base: manifest.binding.merge_base, ticket_set: manifest.binding.ticket_set,
        ticket_set_digest: manifest.binding.ticket_set_digest });
      assert.equal(observed.record.receipt.policy_hash, subject.policy, 'observation policy changed');
      assert.equal(coverage.current.repository, subject.repository, 'foreign observation repository');
      assert(Array.isArray(coverage.limitations), 'explicit expansion reasons required');
      if (ref.kind === 'full-fallback') {
        assert.equal(coverage.mode, 'full'); assert.equal(coverage.inherited.length, 0);
        assert(!coverage.baseline || coverage.limitations.length > 0, 'fallback has no independently recorded invalidation');
        assert(coverage.current_logical_obligations.every(row => row.coverage !== 'inherited'), 'full fallback inherited credit');
      } else if (ref.kind === 'changed-base-expansion') {
        assert.notEqual(coverage.current.base, final.lineage.baseline.base, 'changed-base observation has unchanged base');
        assert.equal(coverage.mode, 'full'); assert.equal(coverage.inherited.length, 0);
      } else {
        assert(coverage.impact.governing_changes.length > 0, 'shared contract change absent');
        for (const change of coverage.impact.governing_changes) {
          const name = typeof change === 'string' ? change : change.path;
          assert(coverage.endpoint_delta.some(row => row.path === name), 'hidden shared-contract delta');
          assert(coverage.impact.paths.includes(name), 'shared contract not expanded');
        }
      }
      checked.push({ kind: ref.kind, role: ref.role, dispatch: observed.record.dispatch_id, lineage: coverage.digest });
      continue;
    }
    const origin = verifiedRecord(ref.origin);
    const parsed = require(path.join(SCRIPTS, 'codex-runtime-host.cjs')).parseCodexStream(privateOriginal(origin.receipt.runtime_evidence.transcript).toString('utf8'));
    nativeRecords(origin, ref.native);
    const messages = parsed.records.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
    assert.equal(messages.length, 1, 'original refusal selector output absent');
    const response = JSON.parse(messages[0].item.text);
    const request = typeof response.summary === 'string' ? JSON.parse(response.summary) : response;
    assert.equal(request.kind, ref.kind); assert.equal(request.role, ref.role);
    assert.deepEqual(request.selectors, ref.selectors, 'refusal selectors differ from original native observation');
    assert.equal(origin.receipt.policy_hash, subject.policy, 'refusal observation policy changed');
    assert.equal(origin.receipt.runtime, subject.runtime);
    assert(installed && origin.receipt.agent_file.startsWith(installed.runtime_root + path.sep), 'refusal observer did not use inspected installed runtime');
    assert.equal(sha(read(origin.receipt.agent_file)), origin.receipt.agent_file_digest, 'refusal installed agent changed');
    if (['forged', 'truncated'].includes(ref.kind)) {
      const selectors = request.selectors;
      assert.equal(selectors.worktree, final.physical.identity.worktree);
      assert.equal(selectors.receipt_store, final.physical.evidence_pins.receipt_store);
      assert.equal(selectors.dispatch_id, final.verdict.dispatch_id, 'refusal has no genuine completed control');
      const originalProgress = final.physical.evidence_pins.progress;
      if (ref.kind === 'forged') {
        assert.equal(selectors.progress?.reference, originalProgress.reference);
        assert.match(selectors.progress?.sha256 || '', /^[a-f0-9]{64}$/);
        assert.notEqual(selectors.progress.sha256, originalProgress.sha256, 'forged cursor did not alter authentic pin');
      } else {
        const control = require(path.join(SCRIPTS, 'role-artifact.cjs')).authenticateCompletedReviewReferences({
          worktree: selectors.worktree, progress: originalProgress, receipt_store: selectors.receipt_store, dispatch_id: selectors.dispatch_id });
        const prior = control.progress.chain.find(payload => sha(canonical(payload)) === selectors.progress?.sha256);
        assert(prior && prior.completed_ranges < control.progress.completed_ranges, 'truncation did not select an authenticated incomplete prefix');
        assert.equal(selectors.progress.reference, 'review-progress-' + selectors.progress.sha256 + '.json');
      }
    }
    let refused = false, code;
    try {
      if (['forged', 'truncated'].includes(ref.kind)) observeCompletedConsumption(request.selectors, installedRuntime);
      else {
        const { current, receipt } = request.selectors;
        assert(current?.worktreePath === final.lineage.current.worktree, 'foreign refusal checkout');
        assert(receipt, 'original refused receipt selector absent');
        const record = verifiedRecord(receipt);
        assert.equal(record.receipt.role, ref.role, 'refusal borrowed another role');
        const api = require(path.join(SCRIPTS, 'role-artifact.cjs'));
        const verdict = ref.role === 'arch-review' ? api.currentArchitectureVerdict(current) : api.currentIntegrationVerdict(current);
        refused = !(verdict?.authenticated && verdict.dispatch_id === record.dispatch_id);
        if (ref.kind === 'replay') assert.equal(record.dispatch_id, final.lineage.baseline.dispatch_id, 'replay did not test eligible old final');
        if (ref.kind === 'hidden-delta') {
          assert(current.head !== final.lineage.current.head, 'hidden-delta test has unchanged endpoint');
          gitBytes(current.worktreePath, 'merge-base', '--is-ancestor', final.lineage.current.head, current.head);
          assert(gitBytes(current.worktreePath, 'diff', '--name-only', final.lineage.current.head, current.head).length > 0, 'hidden delta has no actual changed content');
          verifyContributors(current.worktreePath, { from: final.lineage.current.head, to: current.head });
        }
        if (ref.kind === 'stale') assert(current.head !== subject.head || current.baseCommit !== subject.base, 'stale observation is current');
      }
    } catch (error) {
      if (unavailable(error)) throw error;
      const allowed = ['REVIEW_PROGRESS_INVALID', 'REVIEW_RESTART_REQUIRED', 'REVIEW_COVERAGE_INVALID',
        'REVIEW_NATIVE_INVALID', 'RUNTIME_EVIDENCE_MISMATCH', 'STALE_CONTEXT'];
      assert(allowed.includes(error.code), 'unrelated failure cannot prove refusal: ' + error.message);
      refused = true; code = error.code;
    }
    assert(refused, 'forged/stale/truncated/replay/hidden delta was admitted');
    checked.push({ kind: ref.kind, role: ref.role, dispatch: origin.dispatch_id, refusal: code || 'no-current-admission' });
  }
  return checked;
}
function aggregateMatrix(value, provenance) {
  if (provenance !== 'fixture-only') assert(nativeMatrices.has(value), 'private verified matrix required');
  if (!value.installed) return validateMatrix(value);
  identity(value.subject);
  assert(value.installed.installed, 'actual installed candidate admission required');
  assert.equal(value.installed.selection_sha256, value.subject.candidate, 'installed governing candidate differs');
  assert.equal(value.benchmark.successful_reads, 830);
  assert.equal(value.benchmark.material_bytes, 6530992);
  equalSet(value.traces.map(trace => trace.role), ['arch-review', 'integrator'], 'independent native roles');
  assert.equal(new Set(value.traces.map(trace => trace.lineage.baseline.dispatch_id)).size, 2, 'borrowed baseline');
  assert.equal(new Set(value.traces.map(trace => trace.verdict.dispatch_id)).size, 2, 'borrowed fresh final');
  assert.equal(new Set(value.traces.map(trace => trace.physical.attempts[0].session_id)).size, 2, 'borrowed semantic session');
  assert.equal(value.capacity.length, 2, 'both-role first128KiB probes required');
  for (const capacity of value.capacity) {
    if (capacity.schema === 'shipyard.native-reader-capacity.v3') {
      assert.equal(capacity.role, value.traces[value.capacity.indexOf(capacity)].role, 'borrowed capacity role');
      assert.equal(capacity.candidate, value.subject.candidate, 'foreign finite candidate');
      assert.equal(capacity.policy, value.subject.policy, 'finite policy changed');
      assert.match(capacity.profile_sha256, /^[a-f0-9]{64}$/, 'finite profile absent');
      assert(Number.isSafeInteger(capacity.physical_calls) && capacity.physical_calls > 0 && capacity.physical_calls <= 83, 'finite physical target');
      assert(Number.isSafeInteger(capacity.logical_ranges) && capacity.logical_ranges > 0, 'finite logical coverage absent');
      assert.equal(capacity.complete, true, 'incomplete finite capacity');
    } else assert(capacity.complete && capacity.block_bytes === 131072, 'complete original first128KiB probe required');
    assert(capacity.observed_encoded_bytes >= capacity.required_encoded_bytes, 'insufficient complete capacity');
  }
  equalSet(value.observations.map(row => row.role + ':' + row.kind), ['arch-review', 'integrator'].flatMap(role =>
    [...CHECKS, 'hidden-delta'].map(kind => role + ':' + kind)), 'independent focused observations');
  const holds = [];
  for (const trace of value.traces) {
    assert(trace.native_trace_verified && trace.verdict.authenticated, 'fresh native current admission required');
    assert(trace.equivalent?.complete, 'original equivalent logical obligations absent');
    assert.equal(trace.equivalent.original_digest, value.traces[0].equivalent.original_digest, 'original obligations differ between roles');
    assert.equal(trace.lineage.mode, 'incremental'); assert.equal(trace.lineage.baseline.role, trace.role);
    assert.notEqual(trace.verdict.dispatch_id, trace.lineage.baseline.dispatch_id, 'replayed final');
    assert.deepEqual(trace.lineage.limitations, [], 'incomplete incremental coverage');
    assert(trace.contributors?.some(row => row.other_contributor), 'other-contributor repair absent');
    const [prefix, fresh] = trace.physical.attempts;
    assert(prefix.status === 'interrupted' && fresh.status === 'completed', 'independent real interruption required');
    assert(prefix.session_id === fresh.session_id && prefix.turn_id !== fresh.turn_id, 'foreign resumed context');
    assert.equal(fresh.dispatch_id, trace.verdict.dispatch_id, 'fresh receipt differs from physical continuation');
    assert(trace.physical.coverage.prefix.successful_reads > 0 && trace.physical.coverage.new.successful_reads > 0, 'empty physical continuation');
    metrics(trace.metrics); metrics(trace.baseline_setup.metrics);
    const calls = trace.metrics.successful_reads.value;
    if (calls === null) holds.push(trace.role + ': observed successful required reads unavailable');
    else {
      assert(calls >= trace.physical.coverage.prefix.successful_reads + trace.physical.coverage.new.successful_reads, 'invented observed call total');
      assert(calls <= 83, 'original benchmark 10x call target not met');
    }
  }
  return { status: holds.length ? 'hold' : provenance === 'fixture-only' ? 'fixture-pass' : 'acceptance',
    empirical_acceptance: !holds.length && provenance !== 'fixture-only', holds };
}
function verifyHistoricalCustody(history) {
  const custody = requiredReference(history?.custody, 'unchanged historical HOLD custody');
  const ref = requiredReference(custody.original_ledger, 'original historical ledger archive');
  assert.equal(ref.sha256, 'f461880d2719d951df4e7381f450fa3fa24770a0494cadae0b055fdbd3640ef8', 'historical HOLD was rewritten');
  assert(!ref.path.startsWith(ROOT + path.sep), 'historical custody cannot reuse mutable current ledger');
  const old = JSON.parse(privateOriginal(ref));
  assert.equal(old.plan_sha256, HISTORICAL_PLAN); assert.equal(old.status, 'hold'); assert.equal(old.empirical_acceptance, false);
  const commits = ['65e4fd4e31c4dcca13c448e2b4c18de828803ef4', '033aa4d9fe91ec7ab3f413fb0a5f84efe1da77cb',
    '9d63b76e21f992f30b88a3e1b329983158580d05', 'e0adcfa68e5898e80558fedd22620ef9d74469d1'];
  assert(Array.isArray(custody.sources) && custody.sources.length === commits.length, 'original partial/carry source history required');
  equalSet(custody.sources.map(row => row.commit), commits, 'immutable partial source history');
  return { original_ledger: ref, sources: custody.sources.map(row => verifySourceHistory(row)), historical_only: true };
}
function verifyActualMatrix(ledger, report) {
  const attempt = (name, action) => {
    try {
      const evidence = action();
      const reported = evidence?.native_trace_verified ? { native_trace_verified: true, dispatch: evidence.verdict.dispatch_id,
        lineage_digest: evidence.lineage.digest, physical: evidence.physical, metrics: evidence.metrics, baseline_setup: evidence.baseline_setup,
        equivalent: evidence.equivalent, contributors: evidence.contributors } : evidence;
      report.verified.push({ name, evidence: reported }); return evidence;
    }
    catch (error) { if (!unavailable(error)) throw error; report.holds.push(name + ': original unavailable (' + error.code + ')'); return null; }
  };
  const subject = ledger.subject_observation.current_native_subject;
  if (!subject) {
    report.holds.push('exact current native subject: original selector absent');
    assert.equal(ledger.status, 'hold'); assert.equal(ledger.empirical_acceptance, false); return report;
  }
  identity(subject); assert.equal(subject.candidate, ledger.candidate.selection.sha256, 'governing candidate differs');
  if (!ledger.candidate.current_source) {
    report.holds.push('installed source: original authenticated source selector absent');
    assert.equal(ledger.status, 'hold'); assert.equal(ledger.empirical_acceptance, false); return report;
  }
  assert.equal(subject.repository, fs.realpathSync(gitBytes(ledger.candidate.current_source.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim()), 'native subject differs from installed repository');
  attempt('historical-custody', () => verifyHistoricalCustody(ledger.history));
  const installed = attempt('installed-candidate', () => verifyInstalledCandidate(ledger.candidate));
  attempt('source-equivalence', () => verifySourceEquivalence(ledger.candidate));
  const traces = [];
  for (const role of ['arch-review', 'integrator']) {
    const ref = ledger.native_traces.find(row => row.role === role);
    if (!ref) { report.holds.push(role + ': original native selectors absent'); continue; }
    const trace = attempt(role, () => verifyNativeTrace(ref, ledger.benchmark, subject, installed && installedRuntimes.get(installed)));
    if (trace) {
      assert.equal(verifiedRecord(ref.receipt).receipt.runtime_evidence.worktree, ref.current.worktreePath, 'trace source checkout differs');
      const runtime = verifiedRecord(ref.receipt).receipt.runtime_evidence;
      const checked = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).verifyFileInput(runtime.input_bundle, { sealed: true, historical: true });
      const schedule = require(path.join(SCRIPTS, 'codex-arch-review-context.cjs')).preflightReaderSchedule(checked.manifest, checked.manifest_bytes);
      traces.push({ ...trace, role, transport: runtime.input_bundle.transport, reader_capacity: runtime.input_bundle.reader_capacity, assets: checked.manifest.assets.map(asset => [asset.ordinal, asset.bytes, asset.sha256]),
        manifest: checked.manifest, manifest_bytes: checked.manifest_bytes, schedule,
        started_at: originalAttemptStart(trace.physical) });
    }
  }
  const capacity = [];
  for (const role of ['arch-review', 'integrator']) {
    const ref = ledger.runtime.capacity?.[role];
    if (!ref) { report.holds.push(role + ': original first128KiB capacity probe absent'); continue; }
    const observation = attempt(role + '-capacity', () => verifyCapacityReference(ref, subject, traces.filter(trace => trace.role === role)));
    if (observation) capacity.push(observation);
  }
  const observations = installed && traces.length === 2
    ? attempt('focused-observations', () => verifyFocusedObservations(ledger.observations, traces, subject, installed && installedRuntimes.get(installed), installed))
    : (report.holds.push('focused-observations: installed authority or independent role finals unavailable'), null);
  if (!report.holds.length && installed && traces.length === 2 && capacity.length === 2 && observations) {
    const benchmark = report.verified.find(row => row.name === 'original-benchmark').evidence;
    const matrix = { subject, benchmark, installed, traces, capacity, observations };
    nativeMatrices.add(matrix);
    Object.assign(report, aggregateMatrix(matrix, 'native'));
    report.metrics = Object.fromEntries(traces.map(trace => [trace.role, trace.metrics]));
    report.baseline_setup = Object.fromEntries(traces.map(trace => [trace.role, trace.baseline_setup.metrics]));
    assert.deepEqual(ledger.metrics, report.metrics, 'caller treatment metrics differ from original observations');
    assert.deepEqual(ledger.baseline_setup, report.baseline_setup, 'caller setup metrics differ from eligible baselines');
  }
  assert.equal(ledger.status, report.status, 'caller label differs from independent admission');
  assert.equal(ledger.empirical_acceptance, report.empirical_acceptance, 'caller empirical label differs from independent admission');
  return report;
}

const FOCUSED_PLAN = '8dfe51834b583ffcd56683fe6ec11bda88b914bcd18d967e6ee8bcc6d59a874b';
const FOCUSED_CONTRACT = 'shipyard.focused-architecture-review.v1';
function verifyFocusedCurrent(ref, hostRoot) {
  const record = verifiedRecord(ref.receipt);
  assert.equal(record.receipt.role, 'arch-review', 'foreign focused role');
  const binding = record.receipt.runtime_evidence.focused_review;
  assert.equal(binding?.review_contract, FOCUSED_CONTRACT, 'original focused contract required');
  nativeRecords(record, ref.native);
  const response = JSON.parse(original(ref.response));
  const runtime = require(path.join(hostRoot, 'scripts/codex-runtime-host.cjs'));
  const cli = runtime.parseCodexStream(original(record.receipt.runtime_evidence.transcript).toString('utf8'));
  const finals = cli.records.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
  assert.equal(finals.length, 1, 'unique original focused response required');
  assert.deepEqual(response, JSON.parse(finals[0].item.text), 'tampered original focused response');
  assert(record.receipt.agent_file.startsWith(path.dirname(hostRoot) + path.sep), 'foreign installed focused agent');
  const context = require(path.join(hostRoot, 'scripts/codex-arch-review-context.cjs'));
  context.validateFocusedResult(response, binding);
  const authority = require(path.join(hostRoot, 'scripts/role-artifact.cjs'));
  const verdict = authority.currentArchitectureVerdict(ref.current);
  const ready = !!(verdict?.authenticated && verdict.dispatch_id === record.dispatch_id);
  if (response.review_completeness === 'incomplete') assert.equal(ready, false, 'incomplete focused judgment admitted');
  return { ready, dispatch: record.dispatch_id, review_completeness: response.review_completeness,
    findings: response.findings, limitations: response.limitations, empirical_acceptance: false };
}
async function exerciseFocusedCandidate(hostRoot) {
  return publicationInspector().inspectFocusedConsumers(hostRoot);
}
function verifyReplaySources(ref) {
  const fixes = { recovery: '2ce85b86de1d7ec1c08e5d699b3e08b7dfea5bf9',
    stop: '9e7870d9c8c699f89979f3f035467a524677b24b' };
  assert.equal(ref.fixed, fixes[ref.case], 'authentic replay fix required');
  const parent = gitBytes(ROOT, 'rev-parse', ref.fixed + '^').toString().trim();
  assert.equal(ref.defective, parent, 'authentic pre-fix parent required');
  const diff = gitBytes(ROOT, 'diff', '--binary', parent, ref.fixed);
  assert.equal(sha(diff), ref.diff_sha256, 'authentic complete replay diff differs');
  assert(Array.isArray(ref.adrs) && ref.adrs.length > 0, 'affected governing ADRs required');
  for (const adr of ref.adrs) {
    assert(/^\.planning\/architecture\/ADR-[^\\]+\.md$/.test(adr.path)
      && !adr.path.split('/').includes('..'), 'replay ADR path escape');
    assert.equal(sha(gitBytes(ROOT, 'show', ref.fixed + ':' + adr.path)), adr.sha256, 'replay governing source differs');
  }
  return { case: ref.case, fixed: ref.fixed, defective: parent, diff_sha256: sha(diff), empirical_acceptance: false };
}
function verifyReplayPreparation(ref) {
  const source = verifyReplaySources(ref.source);
  assert(['defective', 'fixed'].includes(ref.variant), 'explicit replay variant required');
  const revision = ref.variant === 'defective' ? source.defective : source.fixed;
  assert.equal(ref.head, revision, 'historical replay head differs');
  assert.equal(ref.base, source.defective, 'historical replay base differs');
  assert.equal(ref.merge_base, gitBytes(ROOT, 'merge-base', ref.base, ref.head).toString().trim(), 'replay merge base differs');
  assert(Array.isArray(ref.paths) && ref.paths.length > 0 && ref.paths.length <= 64, 'bounded complete replay sources required');
  equalSet(ref.paths.map(item => item.path), ref.paths.map(item => item.path), 'replay source inventory');
  const changed = gitBytes(ROOT, 'diff', '--name-only', source.defective, source.fixed).toString().trim().split('\n')
    .filter(name => name.startsWith('plugins/') || name.startsWith('scripts/'));
  equalSet(ref.paths.map(item => item.path), changed, 'complete changed production source inventory');
  const parts = ['Review the following source and governing decisions independently. Report grounded findings and limitations.'];
  for (const item of ref.paths) {
    assert(typeof item.path === 'string' && !item.path.startsWith('-') && !path.isAbsolute(item.path)
      && !item.path.split('/').includes('..') && !item.path.includes('\\'), 'replay source path escape');
    const bytes = gitBytes(ROOT, 'show', revision + ':' + item.path);
    assert.equal(sha(bytes), item.sha256, 'historical replay source differs');
    parts.push(item.path + '\n' + bytes.toString('utf8'));
  }
  const diff = gitBytes(ROOT, 'diff', '--binary', ref.base, ref.head);
  assert.equal(sha(diff), ref.reviewed_diff_sha256, 'reviewed replay diff differs');
  parts.push('Diff\n' + diff.toString('utf8'));
  for (const adr of ref.source.adrs) parts.push(adr.path + '\n' + gitBytes(ROOT, 'show', source.fixed + ':' + adr.path).toString('utf8'));
  assert.equal(original(ref.prompt).toString('utf8'), parts.join('\n\n'), 'blinded replay prompt differs or contains oracle');
  assert.equal(ref.empirical_acceptance, false, 'preparation is not native evidence');
  metrics(ref.metrics);
  return { ...source, variant: ref.variant, status: 'prepared', empirical_acceptance: false };
}
function verifyReplayAssessment(ref) {
  original(ref.prompt);
  const response = JSON.parse(original(ref.response));
  const assessment = JSON.parse(original(ref.assessment));
  assert.equal(assessment.response_sha256, ref.response.sha256, 'unbound assessor response');
  assert.equal(assessment.prompt_sha256, ref.prompt.sha256, 'unbound assessor prompt');
  assert(['complete', 'incomplete'].includes(response.review_completeness), 'explicit reviewer completeness required');
  assert(Array.isArray(response.findings) && Array.isArray(assessment.findings), 'original findings required');
  equalSet(assessment.findings.map(item => item.index), response.findings.map((_, index) => index), 'complete independent finding assessment');
  for (const item of assessment.findings) {
    assert.deepEqual(item.finding, response.findings[item.index], 'assessor finding differs from original response');
    assert(['grounded', 'false-positive', 'unresolved'].includes(item.outcome), 'explicit finding outcome required');
    assert(typeof item.source_consequence === 'string' && item.source_consequence.trim().length > 0, 'source consequence required');
  }
  assert(['detected', 'missed', 'clean', 'false-positive', 'incomplete'].includes(assessment.outcome), 'explicit assessment outcome required');
  return { outcome: assessment.outcome, review_completeness: response.review_completeness,
    empirical_acceptance: false, status: 'assessment-bytes-bound-not-native-authenticated' };
}
function verifyFocusedDisposition(ledger) {
  assert.equal(ledger.status, 'hold');
  assert.equal(ledger.empirical_acceptance, false);
  assert.equal(ledger.fixture_evidence, false);
  assert.equal(ledger.final_epic.status, 'pending-coordinator-postmerge');
  assert.equal(ledger.final_epic.empirical_acceptance, false);
  assert.equal(ledger.source_handoff.status, 'pending-current-source-HOST-CI-review-merge');
  equalSet(Object.keys(ledger.deferred), ['historical_native_execution', 'independent_usefulness', 'additional_native_admission'], 'deferred experiment inventory');
  for (const item of Object.values(ledger.deferred)) {
    assert.equal(item.status, 'deferred-unverified');
    assert.equal(item.empirical_acceptance, false);
    assert.equal(item.response, null); assert.equal(item.assessment, null);
    assert(typeof item.reason === 'string' && item.reason.trim().length > 0);
  }
  for (const item of Object.values(ledger.focused_metrics)) assert.equal(item.value, null, 'unperformed experiment has observed counters');
  metrics(ledger.focused_metrics);
  assert.equal(ledger.replays, null, 'prepared inputs cannot supply replay results');
  return { status: 'hold', bounded_closeout: 'pending', installed_acceptance: false,
    empirical_acceptance: false, final_epic: 'pending-coordinator-postmerge', verified: [], holds: [] };
}
function verifyFocusedEvidence(ledger) {
  assert.equal(ledger.schema, SCHEMA); assert.equal(ledger.ticket, 'T-49-11');
  assert.equal(ledger.review_contract, FOCUSED_CONTRACT);
  const report = verifyFocusedDisposition(ledger);
  for (const ref of [ledger.historical_ledger, ledger.pre_amendment_ledger]) {
    const history = JSON.parse(original(ref));
    assert.equal(history.status, 'hold'); assert.equal(history.empirical_acceptance, false);
    if (ref === ledger.historical_ledger) assert.equal(history.plan_sha256, HISTORICAL_PLAN);
  }
  assert.equal(ledger.historical_ledger.sha256, 'f461880d2719d951df4e7381f450fa3fa24770a0494cadae0b055fdbd3640ef8');
  assert.equal(ledger.pre_amendment_ledger.sha256, 'eb17bb1ae9025e23b84105ff70705a0b4334dec07cd34734ae2ec13e40ce2846');
  const c = ledger.candidate;
  assert.equal(ledger.installed_identity.proof.sha256, '9a33c22009446ee637057afb5af20729e5fffdc4ccdb1c5659e33ba9bbbd68fd');
  const proof = JSON.parse(original(ledger.installed_identity.proof));
  assert.equal(proof.expected.publication_head, '259acd68c29fc4b9f6e5d044aaa607f66cffc5eb');
  const inspector = publicationInspector(proof.identity.worktree);
  assert.equal(c.selection.sha256, inspector.FOCUSED_SHA, 'foreign focused generation');
  const installed = inspector.inspectFocusedInstalled(proof.identity, proof.binding, original(c.selection), proof.expected, () => proof);
  assert.equal(installed.installed_acceptance, true);
  original(proof.ci.original_full_log); original(proof.source_ci.original_full_log);
  const squash = JSON.parse(original(c.squash));
  assert.equal(squash.state, 'MERGED');
  assert.equal(squash.headRefOid, proof.expected.publication_head);
  assert.equal(squash.mergeCommit.oid, '2d6d1323ac52568a08ab0a60d0bf1e727c750a86');
  equalSet(ledger.prepared_source_custody.map(ref => ref.sha256),
    ['9fa10ee7c8002277e89e202a52701be74dc5a2f593eefeff589cdf6307e06669', '01f466656fa35915188d9f5260d6f115c9b9738d35f028edfe33428ff9d914b3'], 'original prepared source custody');
  for (const ref of ledger.prepared_source_custody) {
    const custody = JSON.parse(original(ref));
    assert(custody.dispatch_id && custody.covered_finalization, 'original preparation source custody missing');
    const source = verifySourceHistory({ worktree: ROOT, commit: custody.artifact.commit });
    assert.equal(source.dispatch_id, custody.dispatch_id);
    assert.equal(source.tree, custody.artifact.tree);
    assert.equal(source.verification_digest, custody.covered_finalization.record.verification_digest);
    const record = verifiedRecord({ store: source.receipt_store, dispatch: source.dispatch_id });
    assert.equal(record.receipt.role, 'executor');
    assert.equal(record.receipt.runtime, 'codex');
    const evidence = record.receipt.runtime_evidence.native_session_evidence;
    const native = custody.refs[2];
    assert.equal(native.sha256, evidence.sha256); assert.equal(native.bytes, evidence.bytes);
    assert.equal(path.basename(native.path), evidence.file);
    const runtime = require(path.join(SCRIPTS, 'codex-runtime-host.cjs'));
    const parsed = runtime.parseNativeCodexTranscript(original(native).toString('utf8'), evidence.session_id);
    assert.equal(parsed.provider, 'openai');
    assert(parsed.selections.length > 0 && parsed.selections.every(row =>
      row.model === record.receipt.applied_model && row.effort === record.receipt.applied_effort),
    'original preparation source selection differs');
    const transcript = record.receipt.runtime_evidence.transcript;
    assert.equal(custody.refs[1].sha256, transcript.sha256);
    assert.equal(custody.refs[1].bytes, transcript.bytes);
    const cli = runtime.parseCodexStream(original(transcript).toString('utf8'));
    assert.equal(cli.session_id, evidence.session_id, 'foreign preparation native/CLI session');
    for (const value of Object.values(custody.refs)) {
      if (value && typeof value.path === 'string' && value.sha256) original(value);
    }
  }
  assert.equal(ledger.prepared_source_custody.length, 2);
  assert.equal(ledger.replay_preparations.length, 4);
  const preparations = ledger.replay_preparations.map(ref => verifyReplayPreparation(JSON.parse(original(ref))));
  equalSet(preparations.map(item => item.case + ':' + item.variant),
    ['recovery:defective', 'recovery:fixed', 'stop:defective', 'stop:fixed'], 'authentic replay preparation coverage');
  if (ledger.current_admission != null)
    report.verified.push(verifyFocusedCurrent(ledger.current_admission, proof.identity.host_root));
  report.verified.push({ installed, preparations });
  assert(Array.isArray(ledger.holds) && ledger.holds.length > 0, 'historical and current pending holds required');
  report.bounded_closeout = 'passed'; report.installed_acceptance = true;
  report.holds = ledger.holds;
  return report;
}

function main(argv) {
  assert(argv.length === 2 && argv[0] === '--verify-evidence' && argv[1] && !argv[1].startsWith('--'),
    'usage: phase49-final-review-acceptance.cjs --verify-evidence <explicit-json-path>');
  const ledger = JSON.parse(read(path.resolve(argv[1]), 4 * 1024 * 1024));
  const report = verifyEvidence(ledger);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
module.exports = { verifyFocusedDisposition, verifyReplayPreparation, verifyReplayAssessment, verifyFocusedEvidence, verifyFocusedCurrent, verifyReplaySources, exerciseFocusedCandidate, FOCUSED_PLAN, validateSourceCarry, verifyPrelaunchCopy, validateSquashRecord, validateBuildPins, SCHEMA, metric, validateTrace, verifyFixture, verifyEvidence, verifyNativeTrace, verifyNativeCapacity, observeNativeConsumption, observeCompletedConsumption, verifiedRecord, original, compareCanonicalInputs, sourceInputs, verifySourceHistory, verifySourceEquivalence, verifyInstalledCandidate, aggregateMatrix, verifyCapacityReference, verifyFocusedObservations, verifyOriginalReads, equivalentObligations, logicalInventory, main };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify({ status: 'refused', code: error.code || 'EVIDENCE_INVALID', reason: error.message }) + '\n'); process.exitCode = 1; }
}
