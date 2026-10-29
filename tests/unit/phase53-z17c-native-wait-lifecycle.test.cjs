'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'z17c-wait-lifecycle-'));
after(() => fs.rmSync(stage, { recursive: true, force: true }));
require('../../scripts/package-shipyard-codex.cjs').build(path.join(stage, 'package'));
const parent = '01a0e224-6642-7f20-b2a3-68b283d429b9';
const child = '01a0e224-80bb-7d33-b57d-8c44061ac85d';
function captured(name) {
  return fs.readFileSync(path.join(ROOT, 'tests/fixtures/captured', name), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('{"shipyard_fixture"'))
    .map(line => line.replace(/<SESSION-\d+>/g, token => token === '<SESSION-2>' ? parent : token === '<SESSION-6>' ? child : token))
    .join('\n') + '\n';
}
const original = captured('codex-agent-stream-parent.jsonl');
const childRecorded = captured('codex-agent-stream-child.jsonl');
const instructions = childRecorded.split('\n').filter(Boolean).map(JSON.parse)
  .find(r => r.type === 'response_item' && r.payload.role === 'developer').payload.content[0].text + '\n';
const childRaw = childRecorded.replace(JSON.stringify(instructions.slice(0, -1)), JSON.stringify(instructions));
const records = original.split('\n').filter(Boolean).map(JSON.parse);
const wait = records.find(r => r.type === 'response_item' && r.payload.type === 'function_call' && r.payload.name === 'wait_agent');
const waitOutput = records.find(r => r.type === 'response_item' && r.payload.type === 'function_call_output' && r.payload.call_id === wait.payload.call_id);
const transform = (raw, fn) => raw.split('\n').filter(Boolean).map(line => JSON.stringify(fn(JSON.parse(line)))).join('\n') + '\n';
const withWait = value => transform(original, r => {
  if (r.type === 'response_item' && r.payload.type === 'function_call_output' && r.payload.call_id === wait.payload.call_id)
    r.payload.output = value;
  return r;
});
const role = 'gsd-plan-checker', model = 'gpt-6-luna', effort = 'low';
for (const [name, file] of [
  ['source', path.join(ROOT, 'plugins/delivery-pipeline/scripts/codex-runtime-host.cjs')],
  ['genuinely staged package', path.join(stage, 'package/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs')],
]) {
  const runtime = require(file);
  const parse = raw => runtime.parseNativeParentSpawn(raw, parent, role, model, effort);
  for (const marker of ['aborted before dispatch', 'Wait interrupted by new input.'])
    test(`${name}: exact controlled ${marker} is interruption metadata without completion credit`, () => {
      const value = parse(withWait(marker));
      assert.equal(value.interrupted, true);
      assert.equal(value.timed_out, false);
      assert.equal(value.task_path, '/root/gsd_task');
      assert.equal(value.compliance, undefined);
      assert.equal(value.completed, undefined);
    });
  test(`${name}: aborted wait plus ordinary wait still binds the single original spawn`, () => {
    const r = withWait('aborted before dispatch').split('\n').filter(Boolean).map(JSON.parse);
    const call = structuredClone(wait); call.payload.call_id = 'controlled-next-wait';
    const output = structuredClone(waitOutput);
    output.payload.call_id = call.payload.call_id;
    output.payload.output = '{"message":"Wait completed.","timed_out":false}';
    assert.equal(parse([...r, call, output].map(JSON.stringify).join('\n')).interrupted, true);
  });
  for (const marker of ['Aborted before dispatch', ' aborted before dispatch', 'aborted before dispatch\n',
    'aborted before dispatch.', 'not json', '{"timed_out":"false"}'])
    test(`${name}: near or malformed marker ${JSON.stringify(marker)} refuses`, () => {
      assert.throws(() => parse(withWait(marker)), e => e.code === 'RUNTIME_EVIDENCE_INVALID');
    });
  test(`${name}: lifecycle normalization cannot authorize a missing or changed child`, () => {
    const evidence = parse(withWait('aborted before dispatch'));
    const agent = { file: '/tmp/fixture/gsd-plan-checker.toml', sha256: 'a'.repeat(64), instructions,
      instructions_sha256: crypto.createHash('sha256').update(instructions).digest('hex') };
    const consume = (raw, p = parent) => runtime.parseNativeChildTranscript(raw, child, p, role, model, effort, agent, evidence);
    assert.equal(consume(childRaw).task_path, '/root/gsd_task');
    for (const raw of [childRaw.split('\n').filter(line => !line.includes('"task_complete"')).join('\n'),
      transform(childRaw, r => { if (r.type === 'response_item' && r.payload.role === 'developer') r.payload.content[0].text += 'changed'; return r; })])
      assert.throws(() => consume(raw), e => /^RUNTIME_EVIDENCE_/.test(e.code));
    assert.throws(() => consume(childRaw, 'foreign-parent'), e => /^RUNTIME_EVIDENCE_/.test(e.code));
  });
  test(`${name}: interruption cannot relax exact role/model/task/spawn or tool output uniqueness`, () => {
    const raw = withWait('aborted before dispatch');
    assert.throws(() => runtime.parseNativeParentSpawn(raw, parent, 'gsd-planner', model, effort), e => e.code === 'RUNTIME_EVIDENCE_MISMATCH');
    assert.throws(() => runtime.parseNativeParentSpawn(raw, parent, role, 'gpt-6.1-sol', effort), e => e.code === 'RUNTIME_EVIDENCE_MISMATCH');
    const spawn = records.find(r => r.type === 'response_item' && r.payload.type === 'function_call' && r.payload.name === 'spawn_agent');
    assert.throws(() => parse(raw + JSON.stringify(spawn) + '\n'), e => e.code === 'RUNTIME_EVIDENCE_MISSING');
    const out = JSON.parse(raw.split('\n').find(line => line.includes('"function_call_output"') && line.includes(wait.payload.call_id)));
    assert.throws(() => parse(raw + JSON.stringify(out) + '\n'), e => e.code === 'RUNTIME_EVIDENCE_INVALID');
  });
  test(`${name}: controlled mixed wait aggregation retains timeouts and exact effort/task/child identity`, () => {
    const raw = withWait('aborted before dispatch');
    const call = structuredClone(wait); call.payload.call_id = 'controlled-timed-out-wait';
    const output = structuredClone(waitOutput);
    output.payload.call_id = call.payload.call_id;
    output.payload.output = '{"timed_out":true}';
    const mixed = parse(raw + [call, output].map(JSON.stringify).join('\n') + '\n');
    assert.equal(mixed.interrupted, true);
    assert.equal(mixed.timed_out, true);
    assert.throws(() => runtime.parseNativeParentSpawn(raw, parent, role, model, 'high'), e => e.code === 'RUNTIME_EVIDENCE_MISMATCH');
    const changedTask = transform(raw, r => {
      if (r.type === 'response_item' && r.payload.type === 'function_call' && r.payload.name === 'spawn_agent') {
        const args = JSON.parse(r.payload.arguments); args.task_name = 'foreign_task';
        r.payload.arguments = JSON.stringify(args);
      }
      return r;
    });
    assert.throws(() => parse(changedTask), e => e.code === 'RUNTIME_EVIDENCE_MISMATCH');
    const evidence = parse(raw);
    const agent = { file: '/tmp/fixture/gsd-plan-checker.toml', sha256: 'a'.repeat(64), instructions,
      instructions_sha256: crypto.createHash('sha256').update(instructions).digest('hex') };
    assert.throws(() => runtime.parseNativeChildTranscript(childRaw, 'foreign-child', parent, role, model, effort, agent, evidence),
      e => /^RUNTIME_EVIDENCE_/.test(e.code));
  });
}

test('native lifecycle shard39 preserves exact prior37 and singleton38 plus future separate40/check43', t => {
  const selector = require('./shard-files.cjs'), manifest = selector.readManifest();
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const current = selector.appendShard(manifest, selector.unitTasks(selector.unitFiles()));
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(current.shards.slice(0, 16), manifest.shards);
  assert.equal(hash(JSON.stringify(current.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(current.shards.slice(0, 36), require('../fixtures/phase53/github-job-attempts.json').parent.shards);
  assert.equal(hash(JSON.stringify(current.shards.slice(0, 37))), '5bf00ad885a7e3e264b1dcdb8ad32fedb9d7d7d4ccd23928a1d7b4c184bba84c');
  assert.deepEqual(current.shards[36], ['phase53-z17-ci-job-attempts.test.cjs']);
  assert.deepEqual(current.shards[37], ['phase53-z17b-ci-wait-published-read.test.cjs']);
  assert.deepEqual(current.shards[38], ['phase53-z17c-native-wait-lifecycle.test.cjs']);
  assert.equal(current.shards.length, 39);
  assert.equal(current.shards.length + 3, 42);
  for (let i = 0; i < current.shards.length; i++)
    assert.deepEqual(selector.selectTaskShard(`${i + 1}/${current.shards.length}`), current.shards[i]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z17c-future-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of selector.unitFiles()) fs.writeFileSync(path.join(dir, file), '');
  const future = 'phase53-z99-future.test.cjs';
  fs.writeFileSync(path.join(dir, future), '');
  const next = selector.appendShard(current, selector.unitTasks(selector.unitFiles(dir)));
  assert.deepEqual(next.shards.slice(0, 39), current.shards);
  assert.deepEqual(next.shards[39], [future]);
  assert.equal(next.shards.length + 3, 43);
  for (let i = 0; i < next.shards.length; i++)
    assert.deepEqual(selector.selectTaskShard(`${i + 1}/${next.shards.length}`, dir, current), next.shards[i]);
});
