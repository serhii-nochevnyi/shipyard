'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { capture, parseArguments } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');

suite('claude-agent-start-hook — exact launched session evidence');

test('captures the exact SessionStart session, transcript path, and typed agent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-start-hook-'));
  const evidenceFile = path.join(directory, 'session-start.json');
  const expectedSession = '11111111-1111-4111-8111-111111111111';
  try {
    capture({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: expectedSession,
      transcript_path: '/private/claude/projects/project/11111111-1111-4111-8111-111111111111.jsonl',
      agent_type: 'gsd-plan-checker',
      cwd: '/tmp/shipyard-worktree',
    }, { evidenceFile, expectedSession, expectedAgent: 'gsd-plan-checker' });
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.session_id, expectedSession);
    assert.equal(evidence.agent_type, 'gsd-plan-checker');
    assert.equal(evidence.transcript_path, '/private/claude/projects/project/11111111-1111-4111-8111-111111111111.jsonl');
    assert.equal(fs.statSync(evidenceFile).mode & 0o777, 0o600);
    assert.throws(() => capture({}, { evidenceFile, expectedSession }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects mismatched session and agent values', () => {
  const expectedSession = '11111111-1111-4111-8111-111111111111';
  const evidence = {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: expectedSession,
    transcript_path: `/private/claude/projects/project/${expectedSession}.jsonl`,
    agent_type: 'gsd-planner',
    cwd: '/tmp/shipyard-worktree',
  };
  assert.throws(() => capture(evidence, { evidenceFile: '/tmp/ignored', expectedSession: '22222222-2222-4222-8222-222222222222' }));
  assert.throws(() => capture(evidence, { evidenceFile: '/tmp/ignored', expectedSession, expectedAgent: 'gsd-plan-checker' }));
});

test('accepts only the bounded hook argument contract', () => {
  assert.deepEqual(parseArguments([
    '--evidence-file', '/tmp/session-start.json',
    '--expected-session', '11111111-1111-4111-8111-111111111111',
    '--expected-agent', 'gsd-plan-checker',
  ]), {
    evidenceFile: '/tmp/session-start.json',
    expectedSession: '11111111-1111-4111-8111-111111111111',
    expectedAgent: 'gsd-plan-checker',
  });
  assert.throws(() => parseArguments(['--other', 'value']));
});

done();
