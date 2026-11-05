'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
const root = path.resolve(__dirname, '../..');
const scripts = path.join(root, 'plugins/delivery-pipeline/scripts');
const runtime = require(path.join(scripts, 'codex-runtime-host.cjs'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixtureHelpers() {
  const filename = path.join(__dirname, 'phase53-codex-integration.test.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  const original = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === 'node:test' ? { test() {} } : original.call(this, name, ...args);
    };
    const source = fs.readFileSync(filename, 'utf8');
    const boundary = "test('ordinary Codex caller";
    assert.ok(source.includes(boundary));
    loaded._compile(source.slice(0, source.indexOf(boundary)) + '\nmodule.exports = { semanticFixture, publicIntegrationFixture, supportedPartitionCaller, currentPartitionConsumer, coldCurrent, captureOriginals };', filename);
    return loaded.exports;
  } finally { Module._load = original; }
}

const nativeSource = registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl');
function nativeTemplate(predicate) {
  const row = template(nativeSource, predicate);
  if (row.payload.turn_id !== undefined) row.payload.turn_id = 'original-turn';
  if (row.payload.internal_chat_message_metadata_passthrough?.turn_id !== undefined)
    row.payload.internal_chat_message_metadata_passthrough.turn_id = 'original-turn';
  return row;
}
function nativeRows() {
  const start = nativeTemplate(row => row.payload?.type === 'task_started');
  const input = nativeTemplate(row => row.payload?.role === 'user');
  const final = nativeTemplate(row => row.payload?.phase === 'final_answer');
  const end = nativeTemplate(row => row.payload?.type === 'task_complete');
  start.payload.turn_id = end.payload.turn_id = 'original-turn';
  input.payload.content = [{ type: 'input_text', text: 'Review source.' }];
  final.payload.content = [{ type: 'output_text', text: 'Original report.' }];
  return [start, input, final, end];
}
function insertRead(rows, commands = ['rg -n absent src/provider.cjs'], results = [{ exit_code: 1, output: '' }], custom = false) {
  const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
  const call_id = 'query-' + rows.length;
  const args = commands.map(cmd => ({ cmd, max_output_tokens: 5000 }));
  const invocation = nativeTemplate(row => row.payload?.type === 'function_call');
  Object.assign(invocation.payload, { call_id,
    internal_chat_message_metadata_passthrough: { turn_id: turn }, ...(custom
      ? { type: 'custom_tool_call', name: 'functions.exec', input: args.map(arg => `text(await tools.exec_command(${JSON.stringify(arg)}));`).join('\n') }
      : { type: 'function_call', name: 'exec_command', arguments: JSON.stringify(args[0]) }) });
  if (custom) delete invocation.payload.arguments;
  else delete invocation.payload.input;
  const response = nativeTemplate(row => row.payload?.type === 'function_call_output');
  Object.assign(response.payload, { type: custom ? 'custom_tool_call_output' : 'function_call_output',
    call_id, internal_chat_message_metadata_passthrough: { turn_id: turn }, output: custom
      ? [{ type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' },
        ...results.map(result => ({ type: 'text', text: JSON.stringify(result) }))]
      : JSON.stringify(results[0]) });
  const boundary = rows.findIndex(row => row.payload?.phase === 'final_answer');
  rows.splice(boundary, 0, invocation, response);
  return { invocation, response, args };
}
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const verify = rows => runtime.verifySemanticReads(serialize(rows));
function noMatch(directory) {
  const args = ['-n', 'SHIPYARD_Z13_DEMONSTRABLY_ABSENT', 'src/provider.cjs'];
  const actual = spawnSync('rg', args, { cwd: directory, encoding: 'utf8', timeout: 10000 });
  assert.equal(actual.error, undefined);
  assert.equal(actual.status, 1, actual.stderr);
  assert.equal(actual.stdout, '');
  assert.equal(actual.stderr, '');
  return { command: 'rg ' + args.join(' '), result: { exit_code: actual.status, output: actual.stdout } };
}

test('an actual rg no-match preserves native command, exit and call identity with zero semantic credit', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z13-query-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src/provider.cjs'), 'exports.value = 1;\n');
  const query = noMatch(directory), rows = nativeRows();
  insertRead(rows, ['cat src/provider.cjs'], [{ exit_code: 0, output: 'exports.value = 1;\n' }]);
  const { invocation } = insertRead(rows, [query.command], [query.result]);
  const reads = verify(rows);
  assert.deepEqual(reads.incomplete, []);
  assert.equal(reads.completed.length, 2);
  assert.deepEqual(reads.negative_queries, [{ call_id: invocation.payload.call_id, operation_index: 0,
    command: query.command, exit_code: 1, outcome: 'no-match', semantic_credit: false }]);
  assert.equal(reads.semantic_credit, false);
});

for (const command of [
  'rg absent src/provider.cjs', "rg -n 'absent|missing' src/provider.cjs", 'rg --fixed-strings "absent value" src/provider.cjs',
  'rg -n -i absent src/provider.cjs src/consumer.cjs', 'rg -- -absent src/provider.cjs',
]) test('supported literal content query: ' + command, () => {
  const rows = nativeRows(); insertRead(rows, [command]);
  assert.deepEqual(verify(rows).incomplete, []);
  assert.equal(verify(rows).negative_queries.length, 1);
});

test('plain paired batch preserves operation order and accepts native empty completed framing', () => {
  const rows = nativeRows();
  const { response } = insertRead(rows, ['cat src/provider.cjs', 'rg -n absent src/provider.cjs'], [
    { exit_code: 0, output: 'exports.value = 1;\n' }, { exit_code: 1, output: '' },
  ], true);
  response.payload.output[2].text = 'Chunk ID: real-query\nWall time: 0.01 seconds\nProcess exited with code 1\nFinal output:\n';
  const reads = verify(rows);
  assert.deepEqual(reads.incomplete, []);
  assert.equal(reads.negative_queries[0].operation_index, 1);
  assert.deepEqual(reads.completed[0].commands, ['cat src/provider.cjs', 'rg -n absent src/provider.cjs']);
});

test('a paired negative query retains its outcome while a failed required open remains unresolved', () => {
  const rows = nativeRows();
  insertRead(rows, ['cat src/missing.cjs', 'rg absent src/provider.cjs'], [
    { exit_code: 1, output: 'cat: src/missing.cjs: No such file or directory\n' }, { exit_code: 1, output: '' },
  ], true);
  const reads = verify(rows);
  assert.equal(reads.incomplete.length, 1);
  assert.equal(reads.incomplete[0].reason, 'unfinished-or-failed');
  assert.equal(reads.negative_queries.length, 1);
  assert.equal(reads.negative_queries[0].operation_index, 1);
  assert.equal(reads.semantic_credit, false);
});

for (const command of [
  'false', 'cat src/missing.cjs', 'git diff --exit-code', 'rg --files src', 'rg --help', 'rg --version',
  'rg -q absent src', 'rg -l absent src', 'rg --count absent src', 'rg --json absent src', 'rg --unknown absent src',
  'rg -n absent src; false', 'rg -n absent src || true', 'rg -n absent src && true', 'rg absent src | cat',
  'env rg absent src', 'sh -c "rg absent src"', 'node -e "rg absent src"', 'rg "$PATTERN" src',
  'rg `pattern` src', 'rg absent src/*', 'rg absent src > /tmp/output', 'rg absent src\nfalse',
]) test('exit 1 stays unresolved for unsupported or composed command: ' + command, () => {
  const rows = nativeRows(); insertRead(rows, [command]);
  assert.equal(verify(rows).incomplete.length, 1);
  assert.equal(verify(rows).negative_queries, undefined);
});

for (const [label, result] of [
  ['rg error', { exit_code: 2, output: '' }], ['diagnostic', { exit_code: 1, output: 'rg: permission denied' }],
  ['stderr', { exit_code: 1, output: '', stderr: 'rg: IO error' }], ['error field', { exit_code: 1, output: '', error: 'failed' }],
  ['nonempty stdout', { exit_code: 1, output: '', stdout: 'match' }], ['absent output', { exit_code: 1 }],
  ['active', { exit_code: 1, session_id: 19, output: '' }], ['truncated', { exit_code: 1, output: '', truncated: true }],
  ['token truncation', { exit_code: 1, output: '', original_token_count: 9000 }],
  ['nonempty match', { exit_code: 1, output: 'match\n' }], ['missing exit', { output: '' }],
]) test('negative query requires a complete empty result: ' + label, () => {
  const rows = nativeRows(); insertRead(rows, undefined, [result]);
  assert.equal(verify(rows).incomplete.length, 1);
  assert.equal(verify(rows).negative_queries, undefined);
});

for (const mutation of ['missing', 'duplicate-result', 'duplicate-call', 'reversed', 'foreign-call', 'foreign-output', 'outside-turn']) {
  test('refuses absent or ambiguous native association: ' + mutation, () => {
    const rows = nativeRows();
    const { invocation, response } = insertRead(rows);
    if (mutation === 'missing') rows.splice(rows.indexOf(response), 1);
    if (mutation === 'duplicate-result') rows.splice(rows.indexOf(response), 0, structuredClone(response));
    if (mutation === 'duplicate-call') rows.splice(rows.indexOf(invocation), 0, structuredClone(invocation));
    if (mutation === 'reversed') rows.splice(rows.indexOf(invocation), 2, response, invocation);
    if (mutation === 'foreign-call') invocation.payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign';
    if (mutation === 'foreign-output') response.payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign';
    if (mutation === 'outside-turn') { rows.splice(rows.indexOf(invocation), 1); rows.unshift(invocation); }
    try { assert.ok(verify(rows).incomplete.length > 0); }
    catch (error) { if (error.code !== 'RUNTIME_EVIDENCE_MISMATCH') throw error; }
  });
}

for (const mutation of ['opaque', 'promise-batch', 'extra-text', 'missing-result', 'reversed-results', 'outer-running', 'outer-truncated', 'nested-truncated', 'foreign-shell']) {
  test('does not infer negative success from ambiguous batch/output: ' + mutation, () => {
    const rows = nativeRows();
    const { invocation, response, args } = insertRead(rows, ['cat src/provider.cjs', 'rg absent src/provider.cjs'], [
      { exit_code: 0, output: 'source' }, { exit_code: 1, output: '' },
    ], true);
    if (mutation === 'opaque') invocation.payload.input = 'if (unknown) { ' + invocation.payload.input + ' }';
    if (mutation === 'promise-batch') invocation.payload.input = `const results = await Promise.all([${args.map(arg => `tools.exec_command(${JSON.stringify(arg)})`).join(',')}]); results.reverse().forEach(text);`;
    if (mutation === 'extra-text') response.payload.output.push({ type: 'text', text: 'unassociated' });
    if (mutation === 'missing-result') response.payload.output.pop();
    if (mutation === 'reversed-results') response.payload.output.splice(1, 2, ...response.payload.output.slice(1).reverse());
    if (mutation === 'outer-running') response.payload.output[0].text = 'Script running with cell ID 9\nOutput:';
    if (mutation === 'outer-truncated') response.payload.output[0].text = 'Script completed\nWall time 0.1 seconds\nOriginal token count: 9000\nWarning: output truncated\nOutput:';
    if (mutation === 'nested-truncated') response.payload.output[2].text = 'Warning: truncated output (original token count: 9000)\n' + response.payload.output[2].text;
    if (mutation === 'foreign-shell') invocation.payload.input = `text(await tools.exec_command(${JSON.stringify({ ...args[1], shell: '/tmp/opaque-shell' })}));`;
    assert.equal(verify(rows).incomplete.length, 1);
    assert.equal(verify(rows).negative_queries, undefined);
  });
}

test('zero exits retain existing ordinary auxiliary accounting', () => {
  const rows = nativeRows(); insertRead(rows, ['git status --short'], [{ exit_code: 0, output: '' }]);
  const reads = verify(rows);
  assert.deepEqual(reads, { schema: 'shipyard.semantic-native-reads.v1',
    completed: [{ call_id: 'query-4', commands: ['git status --short'] }], incomplete: [],
    output_bytes: Buffer.byteLength(JSON.stringify(JSON.stringify({ exit_code: 0, output: '' }))), semantic_credit: false });
});

for (const output of [
  JSON.stringify([{ type: 'text', text: 'rg: IO error' }, { type: 'text', text: JSON.stringify({ exit_code: 1, output: '' }) }]),
  JSON.stringify(JSON.stringify({ exit_code: 1, output: '' })),
]) test('an indirect single-result envelope cannot hide other output: ' + output, () => {
  const rows = nativeRows(), { response } = insertRead(rows);
  response.payload.output = output;
  assert.equal(verify(rows).incomplete.length, 1);
  assert.equal(verify(rows).negative_queries, undefined);
});

for (const mutation of ['absent-output', 'row-truncated', 'payload-truncated', 'error-wrapper', 'malformed-arguments', 'invalid-arguments', 'foreign-tool']) {
  test('missing native facts and explicit error/truncation wrappers remain unresolved: ' + mutation, () => {
    const rows = nativeRows(), { invocation, response } = insertRead(rows);
    if (mutation === 'absent-output') delete response.payload.output;
    if (mutation === 'row-truncated') response.truncated = true;
    if (mutation === 'payload-truncated') response.payload.truncated = true;
    if (mutation === 'error-wrapper') response.payload.is_error = true;
    if (mutation === 'malformed-arguments') invocation.payload.arguments = '{';
    if (mutation === 'invalid-arguments') invocation.payload.arguments = 'null';
    if (mutation === 'foreign-tool') invocation.payload.name = 'foreign_exec_command';
    assert.equal(verify(rows).incomplete.length, 1);
    assert.equal(verify(rows).negative_queries, undefined);
  });
}

test('actual no-match traverses original recording, independent final and cold current consumption', async () => {
  const h = fixtureHelpers();
  await h.publicIntegrationFixture(async f => {
    const query = noMatch(f.worktree);
    const source = spawnSync('cat', ['src/provider.cjs'], { cwd: f.worktree, encoding: 'utf8' });
    assert.equal(source.status, 0, source.stderr);
    const prepared = h.semanticFixture(f, { native(rows) {
      insertRead(rows, ['cat src/provider.cjs'], [{ exit_code: source.status, output: source.stdout }]);
      insertRead(rows, [query.command], [query.result]);
    }, result(result) {
      result.findings = [{ id: 'Z13-INFO', type: 'informational', blocking: false,
        summary: 'Negative search is auxiliary metadata.', evidence: 'src/provider.cjs:1', ticket: null }];
      result.evidence_markdown += '\nINFO: negative search found no matching symbol; source review remains separately reported.';
    } });
    const completed = await h.supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(completed.result.outcome, 'passed');
    const originals = h.captureOriginals(f, prepared);
    for (const original of originals) {
      assert.deepEqual(original.native.reads.incomplete, []);
      assert.equal(original.native.reads.negative_queries.length, 1);
      assert.equal(original.native.reads.semantic_credit, false);
      assert.match(original.original_text, /INFO: negative search/);
      assert.equal(original.result.findings[0].id, 'Z13-INFO');
      assert.deepEqual(original.result.limitations, []);
    }
    assert.equal(h.currentPartitionConsumer(f)?.authenticated, true);
    assert.equal(h.coldCurrent(f)?.authenticated, true);
  });
});

test('a final-only failed required read cannot consume otherwise complete negative-query originals', async () => {
  const h = fixtureHelpers();
  await h.publicIntegrationFixture(async f => {
    const query = noMatch(f.worktree);
    const prepared = h.semanticFixture(f, { native(rows, payload) {
      insertRead(rows, [query.command], [query.result]);
      if (payload.stage === 'final') insertRead(rows, ['cat src/z13-missing-final.cjs'], [
        { exit_code: 1, output: 'cat: src/z13-missing-final.cjs: No such file or directory\n' },
      ]);
    } });
    await assert.rejects(h.supportedPartitionCaller(f, 'codex', prepared.options),
      error => error.code === 'SEMANTIC_REVIEW_INCOMPLETE');
    for (const original of h.captureOriginals(f, prepared)) {
      assert.deepEqual(original.native.reads.incomplete, []);
      assert.equal(original.native.reads.negative_queries.length, 1);
    }
    assert.equal(h.coldCurrent(f), null);
  });
});

for (const failure of ['required-source', 'required-context', 'unread', 'limitations', 'blocked-finding', 'native-resource', 'missing-usage']) {
  test('independent final retains actual incompleteness despite negative query: ' + failure, async () => {
    const h = fixtureHelpers();
    await h.publicIntegrationFixture(async f => {
      const query = noMatch(f.worktree);
      const prepared = h.semanticFixture(f, { native(rows, payload) {
        insertRead(rows, [query.command], [query.result]);
        if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
        if (failure === 'required-source') {
          const actual = spawnSync('cat', ['src/z13-missing-required.cjs'], { cwd: f.worktree, encoding: 'utf8' });
          assert.equal(actual.status, 1);
          insertRead(rows, ['cat src/z13-missing-required.cjs'], [{ exit_code: actual.status, output: actual.stderr }]);
        }
        if (failure === 'native-resource') rows.splice(-1, 0, { type: 'event_msg', payload: { type: 'output_truncated' } });
        if (failure === 'missing-usage') rows.splice(rows.findIndex(row => row.payload?.type === 'token_count'), 1);
      }, result(result, payload) {
        if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
        if (failure === 'required-context') result.required_context = ['Required source remains unresolved.'];
        if (failure === 'unread') result.unread = [result.coverage[0]];
        if (failure === 'limitations') result.limitations = ['Required source review could not be completed.'];
        if (failure === 'blocked-finding') {
          result.completeness = 'blocked'; result.outcome = 'needs-fix'; result.blocking_count = 1;
          result.findings = [{ id: 'Z13-B1', type: 'violation', blocking: true, summary: 'Actual unresolved source',
            evidence: 'src/provider.cjs:1; required semantic context remains unresolved.', ticket: null }];
        }
      } });
      if (failure === 'missing-usage') {
        await h.supportedPartitionCaller(f, 'codex', prepared.options);
        const original = h.captureOriginals(f, prepared)[0];
        assert.equal(original.native.accounting.status, 'unknown');
        assert.equal(original.native.resource_failure, null);
        assert.equal(h.coldCurrent(f)?.authenticated, true);
      } else {
        await assert.rejects(h.supportedPartitionCaller(f, 'codex', prepared.options),
          error => ['SEMANTIC_REVIEW_INCOMPLETE', 'SEMANTIC_REVIEW_INCOMPATIBLE'].includes(error.code));
        const original = h.captureOriginals(f, prepared)[0];
        assert.equal(original.native.reads.negative_queries.length, 1);
        assert.equal(prepared.launches.at(-1).payload.stage, 'final');
        if (failure === 'required-source') {
          assert.equal(original.native.reads.incomplete[0].reason, 'unfinished-or-failed');
          assert.deepEqual(original.native.reads.incomplete[0].commands, ['cat src/z13-missing-required.cjs']);
          assert.match(fs.readFileSync(original.native.native_pin.path, 'utf8'), /z13-missing-required/);
        }
        if (failure === 'required-context') assert.ok(original.result.required_context.length);
        if (failure === 'unread') assert.ok(original.result.unread.length);
        if (failure === 'limitations') assert.ok(original.result.limitations.length);
        if (failure === 'blocked-finding') assert.equal(original.result.findings[0].id, 'Z13-B1');
        if (failure === 'native-resource') assert.ok(original.native.resource_failure);
        assert.equal(h.currentPartitionConsumer(f), null);
        assert.equal(h.coldCurrent(f), null);
      }
    });
  });
}

test('the isolated builder exactly reproduces both mirrors and complete package identities', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'z13-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const shipped = path.join(root, 'plugins/shipyard');
  function inventory(directory, prefix = '') {
    return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const relative = prefix + entry.name, file = path.join(directory, relative);
        const stat = fs.lstatSync(file);
        assert.equal(stat.isSymbolicLink(), false, relative);
        const row = { path: relative, mode: stat.mode & 0o777, directory: entry.isDirectory() };
        return entry.isDirectory() ? [row, ...inventory(directory, relative + '/')]
          : [{ ...row, sha256: hash(fs.readFileSync(file)) }];
      });
  }
  const before = inventory(shipped);
  const built = require('../../scripts/package-shipyard-codex.cjs').build(path.join(temporary, 'package'));
  assert.deepEqual(inventory(shipped), before, 'isolated builder cannot mutate the shipped package');
  const generated = inventory(built);
  const mirrors = ['codex-runtime-host.cjs', 'role-artifact.cjs'];
  const owned = new Set([...mirrors.map(file => 'host/plugins/delivery-pipeline/scripts/' + file),
    '.codex-plugin/plugin.json', 'package-build.json']);
  assert.deepEqual(generated.filter(row => !owned.has(row.path)), before.filter(row => !owned.has(row.path)),
    'no undeclared package file or mode may change');
  assert.deepEqual(generated, before);
  for (const file of mirrors) {
    const canonical = path.join(scripts, file), mirror = path.join(built, 'host/plugins/delivery-pipeline/scripts', file);
    assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonical));
    assert.equal(fs.statSync(mirror).mode & 0o777, fs.statSync(canonical).mode & 0o777);
  }
  for (const file of owned) {
    assert.deepEqual(fs.readFileSync(path.join(built, file)), fs.readFileSync(path.join(shipped, file)));
    assert.equal(fs.statSync(path.join(built, file)).mode & 0o777, fs.statSync(path.join(shipped, file)).mode & 0o777);
  }
  const manifestBytes = fs.readFileSync(path.join(built, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes), identity = JSON.parse(fs.readFileSync(path.join(built, 'package-build.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json')));
  const payloadHash = crypto.createHash('sha256');
  for (const row of generated.filter(row => !row.directory && !['.codex-plugin/plugin.json', 'package-build.json'].includes(row.path))) {
    payloadHash.update(row.path + '\0'); payloadHash.update(fs.readFileSync(path.join(built, row.path)));
  }
  const sourceDigest = payloadHash.digest('hex');
  assert.equal(manifest.version, `${source.version}+codex.${sourceDigest.slice(0, 16)}`);
  assert.equal(identity.version, manifest.version);
  assert.equal(identity.digest, crypto.createHash('sha256').update(sourceDigest).update('\0').update(manifestBytes).digest('hex'));
  const staged = require(path.join(built, 'host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs'));
  const rows = nativeRows(); insertRead(rows);
  assert.deepEqual(staged.verifySemanticReads(serialize(rows)), verify(rows));
});
