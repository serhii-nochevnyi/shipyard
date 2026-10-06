'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  writeTaskFile, taskRelayInput, verifyTaskRelay,
  parseNativeParentSpawn, parseNativeChildTranscript,
} = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');

const PARENT = 'phase47-controlled-parent';
const CHILD = 'phase47-controlled-child';
const ROLE = 'gsd-plan-checker';
const MODEL = 'gpt-6.1-sol';
const EFFORT = 'low';
const TASK_PATH = '/root/gsd_task';
const AGENT = { file: 'controlled-checker.toml', sha256: 'a'.repeat(64),
  instructions: 'Read mandatory sources before the exact task.', instructions_sha256: 'b'.repeat(64) };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const response = (payload) => ({ type: 'response_item', payload });
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

// Deterministic byte caps model bounded prefix output at the two independent
// boundaries (roughly 4K and 12K text-token budgets). No live native launch.
const NESTED_BYTES = 16000;
const OUTER_BYTES = 48000;
function boundedItems(items, budget) {
  const result = [];
  for (const item of items) {
    const bytes = Buffer.from(item, 'utf8');
    if (bytes.length <= budget) {
      result.push(item);
      budget -= bytes.length;
    } else {
      result.push(bytes.subarray(0, budget).toString('utf8'), '[output truncated]');
      break;
    }
  }
  return result;
}

async function fixture(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase47-task-relay-')));
  try {
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    const sources = ['AGENTS.md', 'GSD.md'].map((name, index) => {
      const file = path.join(root, name);
      fs.writeFileSync(file, name + '\n' + ('source-' + index + '-0123456789\n').repeat(24000), { mode: 0o600 });
      return file;
    });
    const task = writeTaskFile(path.join(root, 'private'), { worktree }, 'original',
      'Read the original task bytes: Київ.\n' + 'synthetic-task-0123456789\n'.repeat(24000));
    const input = taskRelayInput(ROLE, MODEL, EFFORT, task);
    const parentRaw = jsonl([
      { type: 'session_meta', payload: { id: PARENT, model_provider: 'openai' } },
      { type: 'turn_context', payload: { model: MODEL, effort: EFFORT } },
      response({ type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: JSON.stringify({
        agent_type: ROLE, model: MODEL, reasoning_effort: EFFORT, fork_turns: 'none', task_name: 'gsd_task',
        message: input.slice(input.indexOf('TASK_FILE='), input.indexOf('Wait for that child')),
      }) }),
      response({ type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ task_name: TASK_PATH }) }),
      response({ type: 'function_call', name: 'wait_agent', call_id: 'wait', arguments: '{}' }),
      response({ type: 'function_call_output', call_id: 'wait', output: '{"timed_out":false}' }),
    ]);
    const relay = parseNativeParentSpawn(parentRaw, PARENT, ROLE, MODEL, EFFORT);
    return await run({ root, task, sources, input, relay });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function inlineCall(task, sources, suffix = false, nestedBudget = NESTED_BYTES) {
  // Only inline code reaches the child shell: source/task reads and byte hashing
  // use readFileSync; there are no filesystem writes or shell temporary files.
  const code = [
    'const fs = require("node:fs"), crypto = require("node:crypto");',
    'const order = [];',
    'const read = (file) => { order.push(file); return fs.readFileSync(file); };',
    'const sources = ' + JSON.stringify(sources) + '.map(read);',
    'const task = read(' + JSON.stringify(task.path) + ');',
    'const marker = "TASK_SHA256=" + crypto.createHash("sha256").update(task).digest("hex") + "\\n";',
    'const body = "READ_ORDER=" + JSON.stringify(order) + "\\n" + sources.join("\\n") + task.toString("utf8") + "\\nTOOL_INVENTORY\\n";',
    'process.stdout.write(' + (suffix ? 'body + marker' : 'marker + body') + ');',
  ].join('\n');
  const command = quote(process.execPath) + ' -e ' + quote(code);
  return '// @exec: {"max_output_tokens":12000}\n'
    + 'const r = await tools.exec_command(' + JSON.stringify({ cmd: command, max_output_tokens: nestedBudget / 4 }) + ');\n'
    + 'const boundary = r.output.indexOf("\\n");\n'
    + 'const marker = r.output.slice(0, boundary);\n'
    + 'text(marker);\ntext(r.output.slice(boundary + 1));';
}

async function execute(call, nestedBudget, outerBudget) {
  const items = [];
  let stdout;
  await new AsyncFunction('tools', 'text', call)({
    async exec_command({ cmd, max_output_tokens }) {
      assert.equal(max_output_tokens * 4, nestedBudget);
      stdout = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      return { output: boundedItems([stdout], nestedBudget).join('\n') };
    },
  }, (item) => items.push(String(item)));
  const output = boundedItems(items, outerBudget).map((text) => ({ type: 'input_text', text }));
  return { stdout, items, output };
}

function childRecords(call, output, stdout) {
  const spawned = { parent_thread_id: PARENT, agent_role: ROLE, agent_path: TASK_PATH };
  return [
    { type: 'session_meta', payload: { id: CHILD, model_provider: 'openai', ...spawned,
      source: { subagent: { thread_spawn: { ...spawned } } } } },
    { type: 'turn_context', payload: { model: MODEL, effort: EFFORT } },
    response({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: AGENT.instructions }] }),
    // The original native delivery proves authority without a plaintext shortcut
    // that could bypass the first-call output requirement under test.
    response({ type: 'agent_message', author: '/root', recipient: TASK_PATH }),
    response({ type: 'custom_tool_call', name: 'exec', call_id: 'first', input: call }),
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', stdout } } },
    response({ type: 'custom_tool_call_output', call_id: 'first', output }),
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'controlled fixture only' } },
  ];
}

function verify(records, task, relay) {
  const raw = jsonl(records);
  parseNativeChildTranscript(raw, CHILD, PARENT, ROLE, MODEL, EFFORT, AGENT, relay);
  return verifyTaskRelay(raw, task, relay);
}

function refuses(records, task, relay, missing) {
  assert.throws(() => verify(records, task, relay), (error) => {
    assert.equal(error.code, 'TASK_RELAY_UNVERIFIED');
    assert.ok(error.details.missing.includes(missing));
    assert.ok(!error.message.includes('synthetic-task'));
    return true;
  });
}

suite('phase47 task relay — original computed output under independent budgets');

test('read-only first call reads mandatory sources in order and forwards the computed prefix first', async () => {
  await fixture(async ({ task, sources, input, relay }) => {
    assert.ok(input.includes('If those sources must come first, read them before TASK_FILE'));
    assert.ok(input.includes('before any source bodies, task text, or tool inventory'));
    assert.ok(input.includes('separate FIRST text item with text(marker)'));
    const call = inlineCall(task, sources);
    const result = await execute(call, NESTED_BYTES, OUTER_BYTES);
    assert.equal(task.sha256, crypto.createHash('sha256').update(fs.readFileSync(task.path)).digest('hex'));
    assert.equal(result.items[0], 'TASK_SHA256=' + task.sha256);
    assert.ok(result.items[1].startsWith('READ_ORDER=' + JSON.stringify([...sources, task.path]) + '\n'));
    assert.ok(result.stdout.length > OUTER_BYTES);
    assert.ok(result.output.some((item) => item.text.includes('[output truncated]')));
    assert.deepStrictEqual(verify(childRecords(call, result.output, result.stdout), task, relay), task);
  });
});

test('prefix survives outer truncation while identical suffix stdout cannot attest the first result', async () => {
  await fixture(async ({ task, sources, relay }) => {
    for (const nestedBudget of [NESTED_BYTES, 4 * 1024 * 1024]) {
      for (const suffix of [false, true]) {
        const call = inlineCall(task, sources, suffix, nestedBudget);
        const result = await execute(call, nestedBudget, OUTER_BYTES);
        assert.ok(result.stdout.includes('TASK_SHA256=' + task.sha256));
        assert.ok(result.output.some((item) => item.text.includes('[output truncated]')));
        if (nestedBudget > result.stdout.length) {
          assert.ok(result.items.join('\n').length > OUTER_BYTES);
          assert.ok(!result.items.join('\n').includes('[output truncated]'));
        }
        const records = childRecords(call, result.output, result.stdout);
        if (suffix) {
          assert.ok(!JSON.stringify(result.output).includes(task.sha256));
          if (nestedBudget > result.stdout.length) assert.ok(result.items.join('\n').includes(task.sha256));
          refuses(records, task, relay, 'TASK_SHA256 in child tool output');
        } else {
          assert.deepStrictEqual(verify(records, task, relay), task);
        }
      }
    }
  });
});

test('bounded output retains strict hash, path, parent, role and unchanged private-task checks', async () => {
  await fixture(async ({ task, sources, relay }) => {
    const call = inlineCall(task, sources, false, 4 * 1024 * 1024);
    const result = await execute(call, 4 * 1024 * 1024, OUTER_BYTES);
    const original = childRecords(call, result.output, result.stdout);
    const edit = (fn) => { const records = JSON.parse(JSON.stringify(original)); fn(records); return records; };
    for (const output of [[], [{ type: 'input_text', text: 'TASK_SHA256=' + '0'.repeat(64) }]]) {
      refuses(edit((records) => { records[6].payload.output = output; }), task, relay, 'TASK_SHA256 in child tool output');
    }
    refuses(original.filter((record) => record.payload.type !== 'custom_tool_call_output'), task, relay,
      'TASK_SHA256 in child tool output');
    for (const wrongPath of [task.path + '.other', path.join(path.dirname(task.path), 'other.md')]) {
      refuses(edit((records) => { records[4].payload.input = call.split(task.path).join(wrongPath); }), task, relay,
        'first tool call reading TASK_FILE');
    }
    refuses(edit((records) => { records[6].payload.call_id = 'unrelated'; }), task, relay,
      'TASK_SHA256 in child tool output');
    for (const field of ['parent_thread_id', 'agent_role']) {
      const records = edit((records) => { records[0].payload[field] = 'foreign'; });
      assert.throws(() => verify(records, task, relay), (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
    }
    const wrongParent = edit((records) => { records[0].payload.parent_thread_id = 'foreign'; });
    assert.throws(() => verifyTaskRelay(jsonl(wrongParent), task, relay),
      (error) => error.code === 'TASK_RELAY_UNVERIFIED' && error.details.missing.includes('child session parent'));
    refuses(original.filter((record) => record.payload.type !== 'agent_message'), task, relay,
      '/root agent_message to ' + TASK_PATH);
    const bytes = fs.readFileSync(task.path);
    fs.chmodSync(task.path, 0o644);
    refuses(original, task, relay, 'private regular task file');
    fs.chmodSync(task.path, 0o600);
    // Same byte length, different digest: verification must check both.
    bytes[0] ^= 1;
    fs.writeFileSync(task.path, bytes);
    refuses(original, task, relay, 'unchanged task file');
  });
});

test('denied heredoc first call and later computed hash stay unaccepted; a fresh inline first call passes', async () => {
  await fixture(async ({ task, sources, relay }) => {
    const validCall = inlineCall(task, sources);
    const valid = await execute(validCall, NESTED_BYTES, OUTER_BYTES);
    const deniedCommand = "python - <<'PY'\nimport hashlib\nprint(hashlib.sha256(open(" + JSON.stringify(task.path)
      + ", 'rb').read()).hexdigest())\nPY";
    const deniedCall = 'const r = await tools.exec_command(' + JSON.stringify({ cmd: deniedCommand }) + '); text(r.output);';
    const denial = "zsh: can't create temp file for here document: operation not permitted";
    // Controlled protected-boundary denial, never a replay or edit of historical evidence.
    const denied = childRecords(deniedCall, [{ type: 'input_text', text: denial }], '');
    const deniedRaw = jsonl(denied);
    refuses(denied, task, relay, 'TASK_SHA256 in child tool output');
    const later = [
      response({ type: 'custom_tool_call', name: 'exec', call_id: 'second', input: validCall }),
      response({ type: 'custom_tool_call_output', call_id: 'second', output: valid.output }),
    ];
    refuses([...denied.slice(0, -1), ...later, denied[denied.length - 1]], task, relay,
      'TASK_SHA256 in child tool output');
    assert.equal(jsonl(denied), deniedRaw);
    assert.deepStrictEqual(verify(childRecords(validCall, valid.output, valid.stdout), task, relay), task);
    const absent = childRecords(validCall, [], valid.stdout);
    refuses([...absent.slice(0, -1), ...later, absent[absent.length - 1]], task, relay,
      'TASK_SHA256 in child tool output');
  });
});

done();
