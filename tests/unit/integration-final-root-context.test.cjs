'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner;
loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
  };
  loaded._compile(fs.readFileSync(owner, 'utf8')
    + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, originalPartitionSessions };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller,
  originalPartitionSessions } = loaded.exports;
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const runtimeHost = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function pinnedBytes(pin) {
  const raw = fs.readFileSync(pin.path);
  assert.equal(raw.length, pin.bytes);
  assert.equal(hash(raw), pin.sha256);
  return raw;
}

function originalCapture(prepared, nativeRuntime, dispatchId) {
  const record = prepared.recorder.getVerifiedRecord(dispatchId);
  assert.ok(record, 'retain the authenticated original native receipt');
  const receipt = record.receipt;
  assert.equal(receipt.dispatch_id, dispatchId);
  assert.equal(receipt.runtime, nativeRuntime);
  assert.equal(receipt.role, 'integrator');
  assert.equal(receipt.compliance, 'verified');
  let session, nativePin;
  if (nativeRuntime === 'codex') {
    const native = receipt.runtime_evidence.native_session_evidence;
    session = native.session_id;
    const files = runtimeHost.nativeSessionCandidates(path.join(process.env.CODEX_HOME, 'sessions'), session);
    assert.equal(files.length, 1);
    nativePin = { ...native, path: files[0] };
  } else {
    session = receipt.session_id;
    nativePin = { ...receipt.selection_evidence.transcript,
      path: path.join(path.dirname(receipt.transcript.path), 'projects', receipt.selection_evidence.transcript.path) };
  }
  const nativeBytes = pinnedBytes(nativePin);
  const rows = nativeBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const users = nativeRuntime === 'codex'
    ? rows.filter(row => row.type === 'response_item' && row.payload?.role === 'user')
      .map(row => row.payload.content.map(block => block.text || '').join(''))
    : rows.filter(row => row.type === 'user' && row.sessionId === session).map(row => row.message.content);
  const inputs = users.filter(input => input.includes('<AUTHENTICATED_INTEGRATION_PARTITION>'));
  assert.equal(inputs.length, 1);
  const text = nativeRuntime === 'codex'
    ? rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text
    : JSON.stringify(rows.find(row => row.type === 'assistant').message.content[0].input);
  const result = JSON.parse(text);
  const launch = prepared.controls.launches.find(item => hash(item.input) === result.input_sha256);
  assert.ok(launch);
  assert.equal(inputs[0], launch.input);
  assert.equal(result.plan_sha256, launch.payload.plan_sha256);
  assert.equal(result.kind, launch.payload.kind);
  const outputPin = nativeRuntime === 'codex' ? receipt.runtime_evidence.transcript : receipt.transcript;
  const outputBytes = pinnedBytes(outputPin);
  return { record, receipt, session, result, text, nativePin, nativeBytes, outputPin, outputBytes };
}

async function rootCase(nativeRuntime, fields, refusal) {
  await publicIntegrationFixture(async f => {
    const observed = nativeRuntime === 'claude';
    let indexPath, indexBefore, expectedText;
    const prepared = publicPartitionFixture(f, nativeRuntime, { observed,
      onLaunch(_input, payload) {
        assert.equal(payload.format, undefined, 'exercise a noncompact plan');
        const directory = authority.archiveAuthorityDirectory(f.worktree);
        const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'integration-plan-' + payload.plan_sha256 + '.json')));
        assert.equal(envelope.payload.plan.version, observed ? 2 : 1);
        if (payload.kind === 'phase') {
          indexPath = path.join(directory, 'integration-units-' + payload.plan_sha256 + '.json');
          indexBefore = fs.readFileSync(indexPath);
          const index = JSON.parse(indexBefore).payload;
          assert.ok(index.entries.length > 0);
          assert.deepEqual(index.entries.map(entry => entry.unit_id), index.expected_unit_ids);
        }
      },
      result(result, payload) {
        if (payload.kind !== 'phase') return;
        delete result.limitations;
        delete result.required_context;
        Object.assign(result, structuredClone(fields));
        expectedText = JSON.stringify(result);
      } });
    let completed;
    if (refusal) {
      await assert.rejects(supportedPartitionCaller(f, nativeRuntime, prepared.options), error => {
        assert.equal(error.code, 'INTEGRATION_PARTITION_INVALID');
        assert.equal(error.message, refusal);
        return true;
      });
    } else {
      completed = await supportedPartitionCaller(f, nativeRuntime, prepared.options);
      assert.equal(completed.result.outcome, 'passed');
      const sessions = originalPartitionSessions(f, nativeRuntime, prepared.recorder, prepared.controls);
      assert.equal(sessions.filter(item => item.result.kind === 'phase').length, 1);
    }
    assert.ok(expectedText);
    assert.equal(prepared.controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
    const latest = prepared.recorder.getLatestReceipt(nativeRuntime, 'integrator');
    assert.ok(latest);
    const final = originalCapture(prepared, nativeRuntime, latest.dispatch_id);
    assert.equal(final.result.kind, 'phase');
    assert.equal(final.text, expectedText, 'retain the original final answer exactly');
    const index = JSON.parse(indexBefore).payload;
    assert.ok(!index.entries.some(entry => entry.dispatch_id === final.receipt.dispatch_id));
    const sessions = index.entries.map(entry => {
      const unit = originalCapture(prepared, nativeRuntime, entry.dispatch_id);
      assert.equal(unit.result.kind, 'unit');
      assert.equal(unit.result.outcome, 'passed');
      return unit.session;
    });
    assert.equal(new Set([...sessions, final.session]).size, sessions.length + 1);
    if (refusal) {
      const manifests = authority.authenticatedArchivePins(f.worktree)
        .filter(pin => pin.path.endsWith('/.shipyard-role-artifact.json'))
        .map(pin => JSON.parse(fs.readFileSync(path.join(f.worktree, pin.path))));
      assert.equal(manifests.filter(manifest => manifest.integration_partition?.kind === 'phase').length, 0);
      assert.equal(manifests.filter(manifest => manifest.artifact_kind === 'integration-unit').length, index.entries.length);
    } else {
      for (const field of ['limitations', 'required_context']) {
        assert.equal(Object.hasOwn(final.result, field), Object.hasOwn(fields, field));
        if (Object.hasOwn(fields, field)) assert.deepEqual(final.result[field], fields[field]);
      }
    }
    assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'final refusal or lookup cannot change accepted units');
    assert.deepEqual(prepared.recorder.getVerifiedRecord(final.receipt.dispatch_id), final.record);
    assert.deepEqual(pinnedBytes(final.nativePin), final.nativeBytes);
    assert.deepEqual(pinnedBytes(final.outputPin), final.outputBytes);
  });
}

const passRefusal = 'unresolved seams or limits cannot yield passed';
test('critical codex strict final limitations alone refuse passing authority', async () => {
  await rootCase('codex', { limitations: ['Assigned consumer source is unavailable'] }, passRefusal);
});
test('behavior codex strict final required_context alone refuses passing authority', async () => {
  await rootCase('codex', { required_context: ['Missing assigned consumer context'] }, passRefusal);
});
test('behavior codex null final limitations refuse their field type', async () => {
  await rootCase('codex', { limitations: null }, 'legacy final limitations must be an array');
});
test('behavior codex object final required_context refuses its field type', async () => {
  await rootCase('codex', { required_context: {} }, 'legacy final required_context must be an array');
});
test('behavior omitted and empty final root arrays preserve current original authority', async () => {
  await rootCase('codex', {}, null);
});
