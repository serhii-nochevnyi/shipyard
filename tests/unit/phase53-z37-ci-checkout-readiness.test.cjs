'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const REVISION = '5ca137ef8a59fa8f30696f1b80cb93c0acc17afb';
const SOURCE = 'plugins/delivery-pipeline/scripts/codex-code-review-context.cjs';
const CAPTURE = 'tests/fixtures/phase53/h3-code-review-context.json';
const METADATA = 'tests/unit/phase53-z35-code-review-material-accounting.test.cjs';
function captureReader(root = h.ROOT) {
  const file = path.join(root, METADATA), text = fs.readFileSync(file, 'utf8');
  const first = text.indexOf('function historicalCollector('), last = text.indexOf('\nasync function metadataRegression(', first);
  assert.ok(first > 0 && last > first);
  const loaded = new Module(file, module); loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(text.slice(first, last) + '\nmodule.exports = historicalCollector;', file);
  return loaded.exports;
}
const historicalCollector = file => captureReader()(file || path.join(h.ROOT, CAPTURE));
const bounded = { timeout: 180000 };
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't37-checkout-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function command(program, argv, cwd, options = {}) {
  return cp.spawnSync(program, argv, { cwd, encoding: 'utf8', timeout: 180000,
    maxBuffer: 8 * 1024 * 1024, ...options });
}
function success(program, argv, cwd, options) {
  const result = command(program, argv, cwd, options);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
test('T37-portable-baseline complete original metadata cases in a reachable-history clone with H3 absent', bounded, t => {
  const directory = temporary(t), checkout = path.join(directory, 'checkout');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  Object.assign(env, { HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
  const head = success('git', ['rev-parse', 'HEAD'], h.ROOT, { env });
  const base = success('git', ['merge-base', 'HEAD', '67797902bedbe7cdd5a4df6757a06ac8181be49b'], h.ROOT, { env });
  success('git', ['clone', '--quiet', '--no-local', '--single-branch', '--no-tags', h.ROOT, checkout], directory, { env });
  assert.equal(success('git', ['rev-parse', 'HEAD'], checkout, { env }), head);
  assert.equal(success('git', ['merge-base', 'HEAD', base], checkout, { env }), base);
  for (const name of ['alternates', 'http-alternates'])
    assert.equal(fs.existsSync(path.join(checkout, '.git/objects/info', name)), false);
  const missing = [
    ['cat-file', '-e', REVISION + '^{commit}'],
    ['cat-file', '-e', REVISION + ':' + SOURCE],
    ['merge-base', '--is-ancestor', REVISION, 'HEAD'],
  ].map(argv => {
    const result = command('git', argv, checkout, { env });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    return { argv, exit: result.status, stderr: result.stderr.trim() };
  });
  for (const relative of [CAPTURE, METADATA, 'tests/fixtures/phase53/semantic-result-helpers.cjs']) {
    fs.copyFileSync(path.join(h.ROOT, relative), path.join(checkout, relative));
    assert.deepEqual(fs.readFileSync(path.join(checkout, relative)), fs.readFileSync(path.join(h.ROOT, relative)));
  }
  const bytes = captureReader(checkout)(path.join(checkout, CAPTURE));
  assert.equal(bytes.length, 52719);
  assert.equal(h.hash(bytes), '1b914f3aaa69aafa4647d325448cd7055b1ee44bbe01b0c44f352483a6f151c2');
  const result = command(process.execPath, ['--test', '--test-name-pattern=T35-git-metadata', METADATA], checkout, { env });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /(?:# |ℹ )tests 2/); assert.match(result.stdout, /(?:# |ℹ )pass 2/);
  assert.match(result.stdout, /(?:# |ℹ )fail 0/);
  const parity = result.stdout.split('\n').filter(line => line.includes('"exact_parity":true'));
  assert.equal(parity.length, 2); assert.ok(parity.some(line => line.includes('"runtime":"codex"')));
  assert.ok(parity.some(line => line.includes('"runtime":"claude"')));
  process.stdout.write(JSON.stringify({ head, base, missing, historical_bytes: bytes.length,
    historical_sha256: h.hash(bytes), metadata_output: result.stdout }) + '\n');
});
test('T37-portable-baseline bounded complete capture rejects raw tampering, truncation and foreign identities', bounded, t => {
  const directory = temporary(t), file = path.join(directory, 'capture.json');
  const original = fs.readFileSync(path.join(h.ROOT, CAPTURE)), descriptor = JSON.parse(original);
  fs.writeFileSync(file, original); assert.deepEqual(historicalCollector(file), historicalCollector());
  for (const mutate of [
    value => { value.revision = '0'.repeat(40); },
    value => { value.source_path += '.foreign'; },
    value => { value.bytes--; }, value => { value.sha256 = '0'.repeat(64); },
    value => { value.source = value.source.slice(0, -4); },
    value => { value.source = 'A' + value.source.slice(1); },
    value => { value.extra = true; }, value => { value.source += 'AAAA'; },
  ]) {
    const changed = h.clone(descriptor); mutate(changed); fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => historicalCollector(file));
  }
  for (const changed of [original.subarray(0, original.length - 20), Buffer.alloc(73729, 65)]) {
    fs.writeFileSync(file, changed); assert.throws(() => historicalCollector(file));
  }
  fs.unlinkSync(file); assert.throws(() => historicalCollector(file));
  fs.symlinkSync(path.join(h.ROOT, CAPTURE), file); assert.throws(() => historicalCollector(file));
});
test('T37-fixture-isolation historical input is authenticated afresh and never shares mutable returned bytes', bounded, t => {
  const file = path.join(temporary(t), 'capture.json'), original = fs.readFileSync(path.join(h.ROOT, CAPTURE));
  fs.writeFileSync(file, original);
  const first = historicalCollector(file), second = historicalCollector(file);
  assert.notEqual(first, second); assert.deepEqual(first, second); first.fill(0);
  assert.deepEqual(historicalCollector(file), second);
  fs.writeFileSync(file, original.subarray(0, -20)); assert.throws(() => historicalCollector(file));
  fs.writeFileSync(file, original); assert.deepEqual(historicalCollector(file), second);
});
test('T37-admission exact75 prefix and one default76th shard with79 total checks', bounded, () => {
  const s = require('./shard-files.cjs'), tasks = s.unitTasks(s.unitFiles());
  const actual = s.appendShard(s.readManifest(), tasks), self = path.basename(__filename);
  assert.equal(actual.shards.length, 76); assert.equal(actual.shards.length + 3, 79);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 74))), 'a6a52de553ecef8424b4a39d85bd6ce7338549072450a91c902c63a63a0da9b6');
  assert.deepEqual(actual.shards[74], ['phase53-z36-completed-ci-original-recovery.test.cjs']);
  assert.deepEqual(actual.shards[75], [self]);
  assert.deepEqual([...actual.shards.flat()].sort(), tasks);
  assert.equal(new Set(actual.shards.flat()).size, tasks.length);
  const matrix = JSON.parse(success(process.execPath, [path.join(__dirname, 'shard-files.cjs'), '--matrix'], h.ROOT));
  assert.deepEqual(matrix.shard, actual.shards.map((_, index) => (index + 1) + '/76'));
  for (let index = 0; index < actual.shards.length; index++)
    assert.deepEqual(s.selectTaskShard((index + 1) + '/76'), actual.shards[index]);
  const runner = fs.readFileSync(path.join(__dirname, 'run.sh'), 'utf8');
  const selection = /unit_selection="\$\(node - "\$\{UNIT_SHARD:-\}" <<'NODE'\n([^]*?)\nNODE\n\)"/.exec(runner);
  assert.ok(selection);
  for (const shard of ['', '76/76']) {
    const queue = success(process.execPath, ['-', shard], h.ROOT, { input: selection[1] });
    const expected = (shard ? [self] : tasks).map(task => {
      const parsed = s.parseTask(task);
      return 'tests/unit/' + parsed.file + (parsed.partition === null ? '' : '#integration-partition=' + parsed.partition);
    });
    assert.deepEqual(queue.split('\n'), expected);
  }
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.throws(() => s.validateManifest({ ...actual, shards: [...actual.shards, [self]] }, tasks));
  assert.throws(() => s.validateManifest({ ...actual, shards: actual.shards.slice(0, -1) }, tasks));
  assert.throws(() => s.selectTaskShard('1/75'));
});
