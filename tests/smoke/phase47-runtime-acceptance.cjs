#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = path.join(ROOT, 'plugins/delivery-pipeline/scripts');
const BASELINE = '7eebae4812b3c67ccdbbb63c8c1603f7767b1466';
const PLAN_SHA256 = '99710c9577d76ead5514b1ba00e5277571ef6ff9827f8d06cb692ef6284fe42c';
const OPERATOR = '2F485C0A455BA33463F66332900FCE87BD1BFF0D';
const HANDOFF = '/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-current-generation-20261006/generation.json';
const HANDOFF_SHA256 = '64e111070452b70065e4f1a71041c7b0a3091105f3e40a7253a3e9b25132fb81';
const OWNED = ['tests/smoke/phase47-runtime-acceptance.cjs', 'tests/unit/phase47-runtime-acceptance.test.cjs',
  'docs/phase47-runtime-acceptance.md', 'docs/audits/phase47-runtime-acceptance.json',
  'docs/audits/phase47-runtime-handoff.md'];
const OBLIGATIONS = Object.freeze(['publication-12', 'installed-identity', 'phase48-absence',
  'installer-runtime-capability', 'detached-parent-child', 'semantic-boundary', 'notification-lifecycle',
  'host-assertions-cleanup', 'research-applicability', 'planner-first-call', 'checker-first-call',
  'validate-graph', 'architecture-context-consumption', 'architecture-capacity',
  'implementation-approval', 'current-head-review', 'sentinel-discrepancy',
  'recovery-writer-release', 'correct-duty-handoff', 'rollback-owned-cleanup']);
const MAX_BYTES = 4 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const git = (root, ...argv) => execFileSync('git', ['-C', root, ...argv], {
  timeout: 30000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const gitText = (root, ...argv) => git(root, ...argv).toString().trim();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function physical(file, directory = false) {
  assert(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file,
    'original path must be absolute and physical');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assert(!fs.lstatSync(current).isSymbolicLink(), 'symlinked original evidence');
  }
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile(), 'original evidence has wrong type');
  return stat;
}

function stableRead(file, limit = MAX_BYTES) {
  const before = physical(file);
  assert(before.size <= limit, 'original evidence is not bounded');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = physical(file);
    for (const field of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[field], before[field], 'original evidence replaced before open');
      assert.equal(fs.fstatSync(fd)[field], before[field], 'original descriptor changed');
      assert.equal(after[field], before[field], 'original evidence replaced during read');
    }
    assert.equal(bytes.length, before.size, 'original evidence truncated');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function readOriginal(reference, limit) {
  assert(object(reference) && /^[a-f0-9]{64}$/.test(reference.sha256 || ''), 'original digest required');
  const bytes = stableRead(reference.path, limit);
  assert.equal(sha(bytes), reference.sha256, 'original evidence digest mismatch');
  return bytes;
}
const jsonOriginal = reference => JSON.parse(readOriginal(reference));

function inventory(root, excludeEditor = false, prefix = '') {
  physical(root, true);
  const entries = [];
  for (const name of fs.readdirSync(root).sort((a, b) => a.localeCompare(b))) {
    if (excludeEditor && /\.(bak|orig|rej|swp)$|^\.DS_Store$|~$/.test(name)) continue;
    const file = path.join(root, name), relative = prefix + name;
    assert(!fs.lstatSync(file).isSymbolicLink(), 'symlinked inventory member');
    if (fs.lstatSync(file).isDirectory()) entries.push(...inventory(file, excludeEditor, relative + '/'));
    else entries.push({ path: relative, sha256: sha(stableRead(file)), bytes: fs.statSync(file).size,
      mode: fs.statSync(file).mode & 0o777 });
  }
  return entries;
}

function canonicalInputs(root) {
  const files = ['scripts/package-shipyard-codex.cjs', ...['bootstrap-shipyard-plugin.cjs',
    'ensure-gsd-plugin.cjs', 'ensure-gsd-core.sh', 'install-shipyard-codex.sh', 'install-shipyard-capability.sh',
    'gen-codex-shipyard.cjs', 'merge-codex-config.cjs', 'configure-codex-notify.cjs'].map(p => 'scripts/' + p)];
  for (const directory of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
    for (const entry of inventory(path.join(root, directory), true)) files.push(directory + '/' + entry.path);
  return [...new Set(files)].sort().map(relative => ({ path: relative,
    sha256: sha(stableRead(path.join(root, relative))) }));
}

function comparePackage(directory, binding, sealed = false) {
  const actual = inventory(directory).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(actual.length, binding.outputs.length, 'package inventory membership mismatch');
  const content = crypto.createHash('sha256');
  for (let i = 0; i < actual.length; i++) {
    const entry = actual[i], expected = binding.outputs[i];
    for (const field of ['path', 'sha256', 'bytes']) assert.equal(entry[field], expected[field],
      'installed/package bytes mismatch: ' + field);
    assert.equal(entry.mode, sealed ? expected.sealed_mode : expected.publication_mode, 'package mode mismatch');
    if (sealed) assert.equal(entry.mode & 0o222, 0, 'candidate must stay sealed');
    if (!['package-build.json', '.codex-plugin/plugin.json'].includes(entry.path)) {
      content.update(entry.path + '\0'); content.update(stableRead(path.join(directory, entry.path)));
    }
  }
  const contentDigest = content.digest('hex');
  assert.equal(contentDigest, binding.source_content_sha256, 'content digest mismatch');
  const manifestBytes = stableRead(path.join(directory, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(stableRead(path.join(directory, 'package-build.json')));
  assert.equal(sha(Buffer.concat([Buffer.from(contentDigest + '\0'), manifestBytes])), binding.package_sha256);
  assert.equal(build.digest, binding.package_sha256);
  assert.equal(build.version, binding.version);
  assert.equal(manifest.version, binding.version);
  assert.equal(binding.version, JSON.parse(stableRead(path.join(directory,
    'host/plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version + '+codex.' + contentDigest.slice(0, 16));
  return { package_sha256: build.digest, manifest_sha256: sha(manifestBytes), output_count: actual.length };
}

function inspectCandidate(candidate, root = ROOT, kind = 'main-review-repair') {
  const publication = require('../unit/phase47-package-publication.test.cjs');
  const common = gitText(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert(['original', 'final', 'successor', 'volume-successor', 'main-review-repair'].includes(kind), 'unknown generation branch');
  const authenticated = kind === 'main-review-repair' ? publication.authenticateRepairSuccessor(common, root)
    : kind === 'volume-successor' ? publication.authenticateVolumeSuccessor(common, root, true)
    : kind === 'successor' ? publication.authenticateSuccessor(common, root, true)
    : kind === 'final' ? publication.authenticateFinal(common, root, true)
    : publication.authenticateOriginal(common);
  const { handback, selected } = authenticated;
  const { selection, binding, selectionPath } = selected;
  if (candidate) assert.equal(candidate, selection.candidate_path, 'foreign candidate');
  const packageEvidence = comparePackage(selection.candidate_path, binding, true);
  if (kind === 'main-review-repair') publication.validatePublication(root, selected, 'candidate');
  const dirty = gitText(root, 'status', '--porcelain=v1', '--untracked-files=all');
  const result = { selection, binding, identity: { ...packageEvidence,
    source_head: binding.source.head, source_tree: binding.source.tree,
    canonical_input_digest: binding.canonical_input_digest, policy_sha256: binding.source.policy_sha256,
    worktree: root, common_dir: common, head: gitText(root, 'rev-parse', 'HEAD'),
    tree: gitText(root, 'rev-parse', 'HEAD^{tree}'), dirty_sha256: sha(dirty),
    selection_path: selectionPath, selection_sha256: handback.selection_sha256,
    binding_path: selection.binding_path, binding_sha256: selection.binding_sha256,
    candidate_path: selection.candidate_path, candidate_sha256: selection.candidate_sha256,
    generation_handback: { path: kind === 'main-review-repair' ? publication.F1_HANDOFF : kind === 'volume-successor' ? publication.VOLUME_HANDOFF : kind === 'successor' ? publication.SUCCESSOR_HANDOFF : kind === 'final' ? publication.FINAL_HANDOFF : HANDOFF,
      sha256: kind === 'main-review-repair' ? publication.F1_HANDOFF_SHA : kind === 'volume-successor' ? publication.VOLUME_HANDOFF_SHA : kind === 'successor' ? publication.SUCCESSOR_HANDOFF_SHA : kind === 'final' ? publication.FINAL_HANDOFF_SHA : HANDOFF_SHA256 },
    historical_only: kind !== 'main-review-repair', generation_kind: kind }, authenticated };
  if (kind === 'main-review-repair') {
    publication.recheckRepairSuccessor(authenticated, root);
    publication.validatePublication(root, selected, 'candidate');
  } else if (kind === 'volume-successor') {
    assert.deepEqual(publication.authenticateVolumeSuccessor(common, root, true), authenticated);
  } else if (kind === 'successor') {
    assert.deepEqual(publication.authenticateSuccessor(common, root, true), authenticated);
  } else publication.selectedArtifact(common, handback, kind === 'final'
    ? 'shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-026-source-update-1' : undefined);
  return result;
}

function originalReceipt(reference, scripts = SCRIPTS) {
  assert(typeof reference.dispatch_id === 'string' && reference.dispatch_id, 'original dispatch required');
  assert.equal(physical(reference.store, true).mode & 0o077, 0, 'original receipt store must be private');
  const key = path.join(path.dirname(reference.store), '.shipyard-dispatch-authority-'
    + sha(reference.store) + '.key');
  assert(fs.existsSync(key), 'original receipt authority is missing');
  assert.equal(physical(key).mode & 0o077, 0, 'original receipt authority must be private');
  const keyBytes = stableRead(key, 32);
  assert.equal(keyBytes.length, 32, 'original receipt authority length mismatch');
  const recordFile = path.join(reference.store, 'record-' + sha(reference.dispatch_id) + '.json');
  assert.equal(physical(recordFile).mode & 0o077, 0, 'original receipt must be private');
  const before = stableRead(recordFile);
  const envelope = JSON.parse(before);
  assert.equal(envelope.format, 'adr-014.durable-boundary.v1', 'unauthenticated original receipt envelope');
  assert.equal(envelope.integrity?.algorithm, 'hmac-sha256');
  assert.match(envelope.integrity?.mac || '', /^[a-f0-9]{64}$/);
  const mac = crypto.createHmac('sha256', keyBytes).update(canonical(envelope.payload)).digest();
  assert(crypto.timingSafeEqual(mac, Buffer.from(envelope.integrity.mac, 'hex')), 'tampered original receipt');
  const record = envelope.payload;
  assert(record && record.dispatch_id === reference.dispatch_id
    && record.receipt?.dispatch_id === reference.dispatch_id, 'foreign original receipt');
  assert.equal(record.receipt.compliance, 'verified');
  require(path.join(scripts, 'model-policy.cjs')).validateResolution(record.resolution, { requireDispatchId: true });
  assert.equal(record.receipt.policy_hash, record.resolution.policy_hash, 'original policy mismatch');
  assert.equal(record.receipt.compliance_proof?.dispatch_id, reference.dispatch_id);
  assert.equal(record.receipt.compliance_proof?.status, 'verified');
  assert.equal(sha(stableRead(key, 32)), sha(keyBytes), 'receipt authority changed during read');
  assert.equal(sha(stableRead(recordFile)), sha(before), 'receipt changed while authenticating');
  if (reference.receipt) assert(isDeepStrictEqual(record.receipt, reference.receipt), 'foreign original receipt');
  return record;
}

function signedApproval(reference) {
  const bytes = readOriginal(reference);
  const signature = readOriginal(reference.signature);
  const publicKey = readOriginal(reference.public_key);
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p47-signature-')));
  fs.chmodSync(temporary, 0o700);
  try {
    const data = path.join(temporary, 'approval.json'), sig = path.join(temporary, 'approval.asc');
    const key = path.join(temporary, 'operator.asc'), ring = path.join(temporary, 'operator.gpg');
    fs.writeFileSync(data, bytes); fs.writeFileSync(sig, signature); fs.writeFileSync(key, publicKey);
    execFileSync('gpg', ['--batch', '--no-options', '--homedir', temporary, '--dearmor', '--output', ring, key],
      { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = execFileSync('gpgv', ['--homedir', temporary, '--keyring', ring, '--status-fd', '1', sig, data],
      { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const valid = output.split('\n').filter(line => line.startsWith('[GNUPG:] VALIDSIG '));
    assert.equal(valid.length, 1, 'original trusted-host approval signature missing');
    assert(valid[0].split(' ').slice(2).includes(OPERATOR), 'foreign approval signer');
    readOriginal(reference); readOriginal(reference.signature); readOriginal(reference.public_key);
    return JSON.parse(bytes);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function validateHostProof(proof, obligation, identity, row) {
  assert(proof?.kind === 'approved-host', 'authentic applicable original proof required');
  const approval = signedApproval(proof.approval);
  assert.equal(approval.schema, 'shipyard.phase47-acceptance-approval.v1');
  assert.equal(approval.actor, 'trusted-host');
  assert.equal(approval.ticket, 'T-47-08');
  assert.equal(approval.plan_sha256, PLAN_SHA256);
  assert(isDeepStrictEqual(approval.identity, identity), 'approval candidate/install/run identity mismatch');
  const assignment = approval.obligations?.[obligation];
  assert(assignment && assignment.implementation_approval_ref, 'independent implementation approval required');
  readOriginal(assignment.implementation_approval_ref);
  assert(isDeepStrictEqual(assignment.governing_inputs, row.governing_inputs), 'governing input applicability mismatch');
  assert(isDeepStrictEqual(assignment.commands.map(command => command.argv), row.command), 'original command mismatch');
  assert(isDeepStrictEqual(assignment.environment, row.environment), 'original environment mismatch');
  if (proof.native) assert(isDeepStrictEqual(assignment.native, proof.native), 'foreign original native evidence locator');
  assert(isDeepStrictEqual(assignment.evidence, proof.evidence), 'foreign original host evidence');
  readOriginal(proof.evidence);
  const payload = require(path.join(SCRIPTS, 'host-verification.cjs')).readEvidence(
    proof.evidence.path, proof.evidence.digest);
  assert(payload && payload.ticket === assignment.ticket && payload.plan_sha256 === assignment.plan_sha256,
    'missing/tampered authenticated host result');
  assert.equal(payload.verification, 'configured');
  assert(payload.results.length > 0, 'transport-only success is not proof');
  assert(isDeepStrictEqual(payload.results.map(result => ({ argv: result.argv, profile: result.profile,
    timeout_ms: result.timeout_ms })), assignment.commands), 'exact host argv/profile/timeout mismatch');
  for (const result of payload.results) {
    assert.equal(result.outcome, 'passed'); assert.equal(result.status, 0);
    assert(!result.signal && !result.timed_out && !result.error_code, 'host assertion did not complete');
    assert.match(assignment.candidate_head || '', /^[a-f0-9]{40}$/);
    assert.match(assignment.candidate_tree || '', /^[a-f0-9]{40}$/);
    assert.equal(result.tree_before, assignment.candidate_tree);
    assert.equal(result.tree_after, assignment.candidate_tree);
  }
  assert.equal(assignment.property, obligation);
  assert.equal(assignment.outcome, 'verified');
  assert(Array.isArray(assignment.artifacts) && assignment.artifacts.length > 0, 'original artifacts required');
  for (const reference of assignment.artifacts) readOriginal(reference);
  return { evidence: proof.evidence.path, digest: proof.evidence.digest,
    ...(assignment.accounting ? { accounting: assignment.accounting } : {}) };
}

function validateFirstCall(proof, role, scripts = SCRIPTS) {
  const record = originalReceipt(proof, scripts);
  assert.equal(record.receipt.gsd_role, role);
  const child = record.receipt.runtime_evidence?.native_child_evidence;
  assert(child && child.sha256 === proof.transcript.sha256, 'original native transcript digest mismatch');
  assert(isDeepStrictEqual(child.task_relay, proof.task), 'original native task binding mismatch');
  const raw = readOriginal(proof.transcript, 32 * 1024 * 1024).toString();
  validateInlineFirstCall(raw, proof.task, proof.relay, scripts);
  return record;
}

function validateNativeOriginal(proof, identity, scripts = SCRIPTS) {
  assert(proof, 'original native receipt/transcript required; fixture success cannot substitute');
  const record = originalReceipt(proof, scripts);
  const evidence = record.receipt.runtime_evidence;
  assert.equal(record.receipt.runtime, 'codex');
  assert.equal(evidence?.provider, 'openai');
  assert.equal(evidence.run_id, identity.run_id, 'original native run identity mismatch');
  assert.equal(evidence.worktree, identity.worktree, 'original native worktree identity mismatch');
  assert.equal(evidence.dispatch_id, record.dispatch_id);
  assert.equal(proof.parent_transcript?.sha256, evidence.native_session_evidence?.sha256,
    'original native parent transcript digest mismatch');
  const raw = readOriginal(proof.parent_transcript, 32 * 1024 * 1024).toString();
  const native = require(path.join(scripts, 'codex-runtime-host.cjs')).parseNativeCodexTranscript(raw, evidence.session_id);
  assert(native.models.includes(record.receipt.applied_model) && native.efforts.includes(record.receipt.applied_effort),
    'original native selection mismatch');
  assert.equal(proof.transcript?.sha256, evidence.native_child_evidence?.sha256,
    'original native child transcript digest mismatch');
  readOriginal(proof.transcript, 32 * 1024 * 1024);
  return record;
}

function validateInlineFirstCall(raw, task, relay, scripts = SCRIPTS) {
  const records = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const first = records.find(row => row.type === 'response_item'
    && ['custom_tool_call', 'function_call'].includes(row.payload?.type));
  assert(first, 'original first call missing');
  const command = typeof first.payload.input === 'string' ? first.payload.input : first.payload.arguments;
  assert(typeof command === 'string' && /(?:python(?:3)?\s+-c\b|node\s+-e\b)/.test(command)
    && !/<<|mktemp|writeFile|open\([^\n]*["']w["']/.test(command),
  'original first call must use read-only inline filesystem hashing');
  const runtime = require(path.join(scripts, 'codex-runtime-host.cjs'));
  runtime.verifyTaskRelay(raw, task, relay, true);
  const output = records.find(row => row.type === 'response_item'
    && row.payload?.call_id === first.payload.call_id
    && ['custom_tool_call_output', 'function_call_output'].includes(row.payload.type));
  assert(output && JSON.stringify(output.payload).includes(task.sha256), 'original first-call computed hash missing');
  const toolOutput = typeof output.payload.output === 'string' ? output.payload.output
    : Array.isArray(output.payload.output) ? output.payload.output.map(item => item.text || '').join('\n')
      : JSON.stringify(output.payload);
  const diagnostics = toolOutput.split(/\n(?:SOURCE=|GATES\n|AGENTS\n|TASK\n)/, 1)[0];
  assert(diagnostics.includes(task.sha256), 'original first-call hash must precede printed source text');
  assert(!/denied|permission denied|not permitted/i.test(diagnostics), 'original first call was denied');
  return true;
}

function validateResearchOriginal(reference) {
  const record = originalReceipt(reference);
  assert.equal(record.receipt.role, 'research');
  assert.equal(record.receipt.policy_hash, reference.scope.policyHash);
  const verified = require(path.join(SCRIPTS, 'planning-result-sealer.cjs')).verifySealedLine({
    root: reference.archive_root, scope: reference.scope, line: reference.line,
  });
  assert.equal(record.receipt.dispatch_id, JSON.parse(stableRead(reference.line.artifact_ref)).dispatch_id);
  assert.equal(verified.status, 'completed');
  return { id: verified.id, dispatch_id: record.dispatch_id,
    receipt_sha256: sha(canonical(record.receipt)), artifact_ref: verified.artifact_ref,
    artifact_digest: verified.artifact_digest, artifact_index: verified.artifact_index,
    applicability: 'historical-original-only' };
}

function openLedger() {
  return { schema: 'shipyard.phase47-runtime-acceptance.v1', ticket: 'T-47-08',
    plan_sha256: PLAN_SHA256, candidate: null, installation: null,
    accounting: { parent_tokens: null, child_tokens: null, efficiency: 'inconclusive' },
    obligations: OBLIGATIONS.map(id => ({ id, owner: 'trusted-coordinator', status: 'HOLD',
      governing_inputs: null, command: null, environment: null, original_outcome: null,
      exit_code: null, proof: null, reason: 'Applicable original evidence has not been supplied.' })) };
}

function validateLedger(ledger) {
  assert.equal(ledger.schema, 'shipyard.phase47-runtime-acceptance.v1');
  assert.equal(ledger.ticket, 'T-47-08'); assert.equal(ledger.plan_sha256, PLAN_SHA256);
  assert.deepEqual(ledger.obligations?.map(row => row.id).sort(), [...OBLIGATIONS].sort(), 'obligation inventory incomplete');
  assert.equal(ledger.accounting?.efficiency, 'inconclusive', 'efficiency remains inconclusive without matched cohorts');
  if (ledger.corrective_generation) {
    assert(ledger.candidate, 'corrective ledger requires current candidate');
    const publication = require('../unit/phase47-package-publication.test.cjs');
    const repair = ledger.corrective_generation.kind === 'main-review-repair';
    const volume = ledger.corrective_generation.kind === 'volume-successor';
    assert(['successor', 'volume-successor', 'main-review-repair'].includes(ledger.corrective_generation.kind), 'unknown corrective generation');
    assert.deepEqual(ledger.corrective_generation.handback,
      { path: repair ? publication.F1_HANDOFF : volume ? publication.VOLUME_HANDOFF : publication.SUCCESSOR_HANDOFF, sha256: repair ? publication.F1_HANDOFF_SHA : volume ? publication.VOLUME_HANDOFF_SHA : publication.SUCCESSOR_HANDOFF_SHA }, 'foreign corrective handback');
    const common = gitText(ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const authenticated = repair ? publication.authenticateRepairSuccessor(common)
      : volume ? publication.authenticateVolumeSuccessor(common, ROOT, true)
      : publication.authenticateSuccessor(common, ROOT, true);
    assert.deepEqual(ledger.corrective_generation.original_ledger, authenticated.handback.original_ledger,
      'foreign retained original ledger');
    assert.deepEqual(ledger.corrective_generation.source_approval, authenticated.handback.current_source_approval);
    const original = jsonOriginal(authenticated.handback.original_ledger);
    assert.equal(ledger.corrective_generation.ticket, repair ? 'T-47-27' : volume ? 'T-47-23' : 'T-47-21');
    assert.equal(ledger.corrective_generation.plan_sha256, authenticated.approval.tail_plan_amendments[repair ? 3 : 1].sha256);
    assert.equal(ledger.acceptance, 'HOLD');
    assert.equal(ledger.current_verification.accepted, false);
    assert.equal(ledger.current_verification.native_launches, 0);
    assert.deepEqual(ledger.corrective_generation.predecessor, original.corrective_generation);
    assert.deepEqual(ledger.corrective_generation.prior_handoff_document, authenticated.handback.prior_handoff_document);
    assert.deepEqual(ledger.obligations, original.obligations, 'twenty original HOLD rows must remain unchanged');
    for (const field of ['ticket', 'plan_sha256', 'historical_research', 'retained_references', 'historical_unknowns', 'accounting'])
      assert.deepEqual(ledger[field], original[field], 'retained original ledger drift: ' + field);
    for (const row of ledger.obligations.filter(row => row.status !== 'proven'))
      assert.deepEqual(row, original.obligations.find(prior => prior.id === row.id), 'original HOLD obligation drift');
    if (repair) publication.recheckRepairSuccessor(authenticated);
    else if (volume) assert.deepEqual(publication.authenticateVolumeSuccessor(common, ROOT, true), authenticated);
    else assert.deepEqual(publication.authenticateSuccessor(common, ROOT, true), authenticated);
  }
  const open = [], verified = [];
  const historical = (ledger.historical_research || []).map(reference => {
    assert.equal(reference.store, '/Users/serhii/.local/state/shipyard/codex/'
      + '0fd9a841a5da4528f18a5ddd346452ddd67b8bbf03ddc67639480665e11af98f/receipts',
    'foreign INV014 original store');
    return validateResearchOriginal(reference);
  });
  for (const row of ledger.obligations) {
    assert(typeof row.owner === 'string' && row.owner, 'obligation owner required');
    assert(['HOLD', 'open', 'blocked', 'proven'].includes(row.status), 'unsupported obligation status');
    if (row.status !== 'proven') {
      assert(typeof row.reason === 'string' && row.reason, 'open obligation requires cause');
      assert(!row.proof, 'unaccepted references belong in retained_references, not proof');
      open.push({ id: row.id, status: row.status, reason: row.reason }); continue;
    }
    assert(object(row.governing_inputs) && Array.isArray(row.command) && row.command.length
      && object(row.environment) && row.exit_code === 0 && row.original_outcome === 'verified',
    'complete original proof command/environment/outcome required');
    if (['planner-first-call', 'checker-first-call'].includes(row.id)) {
      assert(row.proof?.native, 'original native receipt required');
      assert(ledger.installation, 'original native installation identity required');
      validateNativeOriginal(row.proof.native, ledger.installation);
      validateFirstCall(row.proof.native, row.id === 'planner-first-call' ? 'gsd-planner' : 'gsd-plan-checker');
    }
    if (['detached-parent-child', 'architecture-context-consumption', 'architecture-capacity'].includes(row.id)) {
      assert(ledger.installation, 'original native installation identity required');
      validateNativeOriginal(row.proof?.native, ledger.installation);
    }
    verified.push({ id: row.id, ...validateHostProof(row.proof, row.id, ledger.installation, row) });
  }
  let inspected = null;
  if (ledger.candidate) {
    inspected = inspectCandidate(ledger.candidate.candidate_path, ROOT, ledger.corrective_generation?.kind || 'original');
    for (const key of ['candidate_sha256', 'binding_sha256', 'canonical_input_digest', 'package_sha256',
      'manifest_sha256', 'source_head', 'source_tree', 'policy_sha256', 'selection_path', 'selection_sha256',
      'binding_path', 'candidate_path', 'generation_handback'])
      assert.deepEqual(ledger.candidate[key], inspected.identity[key], 'ledger candidate identity mismatch: ' + key);
  }
  if (ledger.installation || verified.length) {
    assert(inspected && ledger.installation, 'current installed candidate identity required');
    inspectInstalled(ledger.installation, inspected);
  }
  const originalAccounting = verified.find(row => row.id === 'detached-parent-child')?.accounting;
  for (const field of ['parent_tokens', 'child_tokens']) {
    if (ledger.accounting[field] === null) continue;
    assert(originalAccounting && Number.isSafeInteger(ledger.accounting[field]) && ledger.accounting[field] >= 0
      && originalAccounting[field] === ledger.accounting[field], 'unknown accounting must remain unknown without original observations');
  }
  if (inspected) {
    const publication = require('../unit/phase47-package-publication.test.cjs');
    if (inspected.identity.generation_kind === 'main-review-repair') publication.recheckRepairSuccessor(inspected.authenticated);
    else if (inspected.identity.generation_kind === 'volume-successor')
      assert.deepEqual(publication.authenticateVolumeSuccessor(inspected.binding.source.common, ROOT, true), inspected.authenticated);
    else if (inspected.identity.generation_kind === 'successor')
      assert.deepEqual(publication.authenticateSuccessor(inspected.binding.source.common, ROOT, true), inspected.authenticated);
    else if (inspected.identity.generation_kind === 'final')
      assert.deepEqual(publication.authenticateFinal(inspected.binding.source.common, ROOT, true), inspected.authenticated);
    else assert.deepEqual(publication.authenticateOriginal(inspected.binding.source.common), inspected.authenticated);
    comparePackage(path.join(ROOT, 'plugins/shipyard'), inspected.binding);
  }
  return { schema: 'shipyard.phase47-runtime-acceptance-result.v1', status: open.length ? 'HOLD' : 'accepted',
    evidence_check: 'passed', accepted: open.length === 0, native_launches: 0,
    fixture_only: false, candidate: inspected?.identity || null, historical_research: historical, verified, open };
}

function inspectInstalled(identity, selected) {
  assert.equal(identity.runtime, 'codex', 'explicit runtime=codex required');
  assert.equal(identity.candidate_sha256, selected.selection.candidate_sha256);
  physical(identity.runtime_root, true);
  assert.equal(physical(identity.runtime_root, true).uid, process.getuid(), 'foreign isolated runtime owner');
  assert.notEqual(identity.runtime_root, path.join(os.homedir(), '.codex'), 'shared runtime is not isolated acceptance');
  physical(identity.package_root, true);
  assert(identity.package_root.startsWith(identity.runtime_root + path.sep), 'installed package outside owned runtime');
  const observed = comparePackage(identity.package_root, selected.binding);
  assert.equal(identity.package_sha256, observed.package_sha256);
  assert.equal(identity.manifest_sha256, observed.manifest_sha256);
  const provenance = jsonOriginal(identity.provenance);
  assert(identity.provenance.path.startsWith(identity.runtime_root + path.sep), 'foreign install provenance');
  assert.equal(provenance.schema, 'shipyard.host-provenance.v1');
  assert.equal(provenance.install_kind, 'dogfood', 'isolated candidate must preserve dogfood identity');
  assert.equal(provenance.dirty, identity.source_dirty);
  assert.equal(provenance.source_sha, identity.source_head);
  git(ROOT, 'merge-base', '--is-ancestor', selected.binding.source.head, identity.source_head);
  for (const entry of selected.binding.source.identities)
    assert.equal(sha(git(ROOT, 'show', identity.source_head + ':' + entry.path)), entry.sha256, 'installed provenance source drift');
  readOriginal(identity.capability);
  for (const output of selected.binding.outputs) {
    const prefix = 'host/capabilities/delivery-pipeline/';
    if (!output.path.startsWith(prefix)) continue;
    assert.equal(sha(stableRead(path.join(path.dirname(identity.capability.path), output.path.slice(prefix.length)))),
      output.sha256, 'installed registered capability drift');
  }
  const agents = jsonOriginal(identity.agent_manifest);
  assert.equal(agents.policy_hash, selected.binding.source.policy_sha256, 'installed generated agent policy drift');
  assert(object(agents.agent_digests) && Object.keys(agents.agent_digests).length > 0,
    'installed generated agent digests required');
  for (const [name, digest] of Object.entries(agents.agent_digests)) {
    assert.equal(path.basename(name), name, 'generated agent path escape');
    readOriginal({ path: path.join(path.dirname(identity.agent_manifest.path), name), sha256: digest });
  }
  const nativeCapability = jsonOriginal(identity.native_capabilities);
  readOriginal(identity.codex_executable, 256 * 1024 * 1024);
  assert(Array.isArray(nativeCapability.supportedModels) && nativeCapability.supportedModels.length
    && Array.isArray(nativeCapability.supportedEfforts) && nativeCapability.supportedEfforts.length,
  'explicit native runtime capabilities required');
  for (const ref of [identity.capability, identity.agent_manifest])
    assert(ref.path.startsWith(identity.runtime_root + path.sep), 'foreign installed capability/agent manifest');
  assert.equal(identity.host_root, path.join(identity.runtime_root, 'shipyard'), 'unsupported installed bundle root');
  for (const output of selected.binding.outputs) {
    const prefix = 'host/plugins/delivery-pipeline/scripts/';
    if (!output.path.startsWith(prefix)) continue;
    const executable = path.join(identity.host_root, 'scripts', output.path.slice(prefix.length));
    assert.equal(sha(stableRead(executable)), output.sha256, 'actual installed executable drift');
    assert.equal(physical(executable).mode & 0o777, output.publication_mode, 'actual installed executable mode drift');
  }
  assert.equal(identity.policy_sha256, selected.binding.source.policy_sha256);
  for (const field of ['run_id', 'repository_id', 'worktree', 'controller', 'source_tree', 'source_dirty'])
    assert(identity[field] !== undefined && identity[field] !== null, 'installed ' + field + ' identity required');
  assert.equal(identity.worktree, ROOT); assert.equal(identity.repository_id, selected.binding.source.common);
  assert.equal(identity.worktree_head, selected.identity.head, 'current worktree head mismatch');
  assert.equal(identity.worktree_tree, selected.identity.tree, 'current worktree tree mismatch');
  assert.equal(identity.worktree_dirty_sha256, selected.identity.dirty_sha256, 'current worktree dirty inventory mismatch');
  assert.equal(gitText(ROOT, 'rev-parse', identity.source_head + '^{tree}'), identity.source_tree);
  return observed;
}

function parseArgs(argv) {
  const result = { native: false, runtime: 'codex' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--native') { assert(!result.native, 'duplicate native switch'); result.native = true; }
    else if (['--evidence', '--candidate', '--runtime-root', '--runtime'].includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      assert(argv[i + 1] && !argv[i + 1].startsWith('--'), 'switch requires a value');
      assert(key === 'runtime' || result[key] === undefined, 'duplicate switch'); result[key] = argv[++i];
    } else assert.fail('unsupported switch: ' + arg);
  }
  assert.equal(result.runtime, 'codex', 'explicit Codex runtime only');
  assert(result.evidence, '--evidence required');
  if (result.native) assert(result.candidate && result.runtimeRoot,
    '--native requires --candidate --runtime-root --evidence');
  return result;
}

function collectNative(ledger, options, report) {
  const selected = inspectCandidate(options.candidate);
  assert(ledger.installation && ledger.collection, 'native collection requires current host authorization');
  assert.equal(options.runtimeRoot, ledger.installation.runtime_root);
  inspectInstalled(ledger.installation, selected);
  const approval = signedApproval(ledger.collection.approval);
  assert.equal(approval.schema, 'shipyard.phase47-native-authorization.v1');
  assert.equal(approval.ticket, 'T-47-08'); assert.equal(approval.plan_sha256, PLAN_SHA256);
  assert.equal(approval.status, 'authorized');
  assert(isDeepStrictEqual(approval.identity, ledger.installation), 'current candidate/runtime authorization mismatch');
  assert.equal(approval.writer_released, true, 'active writer must complete/release before collection');
  assert.equal(approval.implementation_approved, true, 'independent implementation approval missing');
  assert.equal(approval.rollback_ready, true, 'exact safe rollback identity missing');
  assert(approval.rollback_package_sha256 && /^[a-f0-9]{64}$/.test(approval.rollback_package_sha256));
  assert(Array.isArray(approval.prerequisites) && approval.prerequisites.length > 0);
  for (const id of ['publication-12', 'phase48-absence', 'installer-runtime-capability',
    'implementation-approval', 'recovery-writer-release', 'rollback-owned-cleanup'])
    assert(report.verified.some(row => row.id === id), 'native prerequisite HOLD: ' + id);
  for (const ref of approval.prerequisites) readOriginal(ref);
  const request = jsonOriginal(approval.request);
  const installed = path.join(ledger.installation.host_root, 'scripts');
  const host = path.join(installed, 'codex-planning-context-host.cjs');
  const { scope, ...launch } = request;
  assert.equal(launch.gsd_role, 'gsd-phase-researcher',
    'acceptance may collect one planning-context trace; it never replaces planner/checker');
  require(path.join(installed, 'codex-runtime-host.cjs')).normalizeScope(scope);
  require(host).requestValue(launch, { worktreePath: scope.worktree });
  assert.equal(scope.runtime, 'codex'); assert.equal(scope.run_id, ledger.installation.run_id);
  assert.equal(scope.worktree, ROOT);
  const argv = [host, '--args-file', approval.request.path];
  assert.deepEqual(approval.argv, ['node', ...argv], 'argv must resolve from installed supported host');
  assert(Number.isSafeInteger(approval.timeout_ms) && approval.timeout_ms > 0 && approval.timeout_ms <= 600000);
  jsonOriginal(approval.config);
  assert.equal(approval.config.path, path.join(path.dirname(approval.graph_dir), 'config.json'),
    'native admission must use canonical graph config');
  const configModule = require(path.join(installed, 'pipeline-config.cjs'));
  const config = configModule.loadConfig(path.resolve(approval.graph_dir, '../..'));
  assert(config.valid !== false, 'native config admission is invalid');
  const allowList = configModule.repoValue(config, 'verification_commands', scope.repository);
  const admitted = require(path.join(installed, 'host-verification.cjs')).admit([approval.argv], allowList);
  assert(admitted.configured && !admitted.not_allowed.length && admitted.commands.length === 1,
    'native exact host admission is HOLD');
  assert.equal(admitted.commands[0].profile, 'host');
  assert.equal(admitted.commands[0].timeout_ms, approval.timeout_ms);
  assert(object(approval.environment) && approval.environment.CODEX_HOME === options.runtimeRoot,
    'supported installer/runtime environment missing');
  assert(!Object.hasOwn(approval.environment, 'TMPDIR'), 'unsuitable/ambiguous inherited TMPDIR must be omitted');
  assert(!Object.hasOwn(approval.environment, 'NODE_OPTIONS'), 'native module replacement is not supported');
  const env = { ...approval.environment };
  assert(env.PATH && env.SHIPYARD_GRAPH_DIR === approval.graph_dir, 'canonical graph/environment binding required');
  assert.equal(env.SHIPYARD_CODEX_CAPABILITIES_FILE, ledger.installation.native_capabilities.path,
    'native capability environment mismatch');
  const resolvedCodex = env.PATH.split(path.delimiter).map(directory => path.join(directory, 'codex'))
    .find(file => fs.existsSync(file));
  assert(resolvedCodex && fs.realpathSync(resolvedCodex) === ledger.installation.codex_executable.path,
    'ambiguous native executable identity');
  physical(approval.graph_dir, true);
  readOriginal(approval.request);
  inspectInstalled(ledger.installation, inspectCandidate(options.candidate));
  process.stdout.write(JSON.stringify({ event: 'authorized-native-command', argv: approval.argv,
    environment_sha256: sha(canonical(env)), candidate_sha256: selected.selection.candidate_sha256 }) + '\n');
  const result = spawnSync(process.execPath, argv, { env, cwd: ROOT, encoding: 'utf8',
    timeout: approval.timeout_ms, maxBuffer: 16 * 1024 * 1024 });
  return { ...report, native_launches: null, native_host_invocations: 1, status: 'HOLD', accepted: false,
    collection: { argv: approval.argv, exit_code: result.status, signal: result.signal,
      error_code: result.error?.code || null, stdout_sha256: sha(result.stdout || ''),
      stderr_sha256: sha(result.stderr || ''),
      next: 'Inspect original dispatch/receipt/native artifacts before retry; collection alone is not acceptance.' } };
}

function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const file = fs.realpathSync(options.evidence);
  assert.equal(path.resolve(options.evidence), file, 'ledger may not be symlinked');
  const ledger = JSON.parse(stableRead(file));
  let report = validateLedger(ledger);
  const commands = [['node', '--test', 'tests/unit/phase47-runtime-acceptance.test.cjs'],
    ['node', 'tests/smoke/phase47-runtime-acceptance.cjs', '--evidence', 'docs/audits/phase47-runtime-acceptance.json']];
  const configModule = require(path.join(SCRIPTS, 'pipeline-config.cjs'));
  const config = configModule.loadConfig(ROOT);
  assert(config.valid !== false, 'T-47-10 current admission config is invalid');
  const admission = require(path.join(SCRIPTS, 'host-verification.cjs')).admit(commands,
    configModule.repoValue(config, 'verification_commands', 'serhii-nochevnyi/shipyard'));
  assert(admission.configured && !admission.not_allowed.length && admission.commands.length === 2,
    'T-47-10 exact verification admission is HOLD');
  for (const command of admission.commands) {
    assert.equal(command.profile, 'sandbox'); assert.equal(command.timeout_ms, 600000);
  }
  report.admission = { config_sha256: sha(stableRead(path.join(ROOT, '.planning/config.json'))),
    plan_sha256: PLAN_SHA256, commands: admission.commands };
  if (options.candidate) inspectCandidate(options.candidate);
  if (options.native) report = collectNative(ledger, options, report);
  if (report.collection && (report.collection.exit_code !== 0 || report.collection.signal
    || report.collection.error_code)) process.exitCode = 1;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

module.exports = { OBLIGATIONS, OWNED, PLAN_SHA256, sha, canonical, readOriginal, comparePackage,
  inspectCandidate, inspectInstalled, originalReceipt, validateFirstCall, validateResearchOriginal,
  validateNativeOriginal, validateInlineFirstCall, openLedger, validateLedger, parseArgs, runCli };
if (require.main === module) {
  try { runCli(); } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'refused', accepted: false,
      reason: error.code || error.message, native_launches: 0 }) + '\n');
    process.exitCode = 1;
  }
}
