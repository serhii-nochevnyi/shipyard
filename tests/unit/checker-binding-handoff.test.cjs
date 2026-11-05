'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyTaskRelay, writeTaskFile } = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const { parseCheckerResult, sealCheckerResult } = require('../../plugins/delivery-pipeline/scripts/checker-result.cjs');

const pass = { verdict: 'pass', summary: 'Checked plans.', findings: [] };

test('first proof is ordered, standalone and independent of plaintext task delivery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-binding-'));
  try {
    const task = writeTaskFile(path.join(root, 'tasks'), { worktree: path.join(root, 'project') }, 'test', 'original task');
    const marker = { type: 'input_text', text: 'TASK_SHA256=' + task.sha256 };
    const framing = { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' };
    for (const plaintext of [false, true]) {
      const records = [
        { type: 'session_meta', payload: { parent_thread_id: 'parent' } },
        { type: 'response_item', payload: plaintext
          ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'TASK_FILE=' + task.path + '\nTASK_SHA256=' + task.sha256 }] }
          : { type: 'agent_message', author: '/root', recipient: '/root/checker' } },
        { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'first', input: 'read and hash ' + task.path } },
      ];
      const verify = output => verifyTaskRelay([...records,
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'first', output } },
        { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'later', input: task.path } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'later', output: [marker] } },
      ].map(JSON.stringify).join('\n'), task, { parent_thread_id: 'parent', task_path: '/root/checker' });
      for (const output of [[marker], [framing, marker], marker.text + '\n']) assert.deepEqual(verify(output), task);
      for (const output of [
        [], [null], [{ type: 'image', text: marker.text }], [{ ...marker, text: 'wrong digest' }],
        [{ ...marker, text: 'Warning: truncated output\n' + marker.text }],
        [framing, { ...marker, text: 'Warning: truncated output (original token count: 14028)\n' + marker.text }],
        [{ ...marker, text: 'Warning: truncated output (original token count: 52954)' }, marker],
        [{ ...marker, text: 'source body' }, marker],
        [{ ...marker, text: marker.text + '\nsource body' }],
        [{ ...marker, text: 'Script completed\nWarning: truncated output\nOutput:\n' }, marker],
        'warning\n' + marker.text,
      ]) assert.throws(() => verify(output), { code: 'TASK_RELAY_UNVERIFIED' });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('semantic checker pass cannot be inferred from a receipt, process status or Markdown heading', () => {
  assert.deepEqual(parseCheckerResult(JSON.stringify(pass)), pass);
  for (const raw of [undefined, { status: 'completed' }, '## VERIFICATION PASSED',
    { ...pass, verdict: undefined }, { ...pass, verdict: 'issues_found' },
    { ...pass, findings: [{ severity: 'blocker', message: 'First-call proof failed.' }] }]) {
    assert.throws(() => parseCheckerResult(raw), { code: 'CHECKER_VERDICT_UNVERIFIED' });
  }
});

for (const verdict of ['pass', 'issues_found', 'blocked']) {
  test('verified application receipt retains independent ' + verdict + ' verdict and original evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-seal-'));
    try {
      const plan = path.join(root, '11-12-PLAN.md');
      fs.writeFileSync(plan, 'accepted planner bytes');
      const receipt = { dispatch_id: 'original-checker', compliance: 'verified', gsd_role: 'gsd-plan-checker',
        runtime_evidence: { native_child_evidence: { session_id: 'original-child', sha256: 'a'.repeat(64) } } };
      const raw = JSON.stringify({ ...pass, verdict, findings: verdict === 'issues_found'
        ? [{ severity: 'blocker', message: 'Missing first marker.' }] : [] });
      const input = { raw, receipt, root: path.join(root, 'archive'), phaseDir: root, sourceRevision: 'b'.repeat(40) };
      const result = sealCheckerResult(input);
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.verdict, verdict);
      assert.equal(result.status, verdict === 'pass' ? 'completed' : verdict);
      const bytes = fs.readFileSync(result.artifact_index.path);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), result.artifact_index.sha256);
      const sealed = JSON.parse(bytes);
      assert.deepEqual(sealed.receipt, receipt);
      assert.equal(sealed.original_output, raw);
      assert.equal(sealed.plans[0].sha256, crypto.createHash('sha256').update('accepted planner bytes').digest('hex'));
      assert.deepEqual(sealCheckerResult(input), result);
      const retry = sealCheckerResult({ ...input, raw: JSON.stringify(pass), receipt: { ...receipt, dispatch_id: 'retry-checker' } });
      assert.notEqual(retry.artifact_index.path, result.artifact_index.path);
      assert.deepEqual(fs.readFileSync(result.artifact_index.path), bytes);
      assert.equal(fs.readFileSync(plan, 'utf8'), 'accepted planner bytes');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
