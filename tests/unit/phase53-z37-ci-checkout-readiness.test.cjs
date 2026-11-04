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
function isolatedEnvironment(directory) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  Object.assign(env, { HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
  return env;
}
const portableCase = 'T37-portable-baseline complete original metadata cases in a reachable-history clone with H3 absent';
function mainAncestry(root, env) {
  return success('git', ['merge-base', 'HEAD', 'refs/remotes/origin/main'], root, { env });
}
test(portableCase, bounded, t => {
  const directory = temporary(t), checkout = path.join(directory, 'checkout'), env = isolatedEnvironment(directory);
  const head = success('git', ['rev-parse', 'HEAD'], h.ROOT, { env });
  const parent = success('git', ['rev-parse', 'HEAD^'], h.ROOT, { env });
  const base = success('git', ['merge-base', 'HEAD', parent], h.ROOT, { env });
  assert.equal(base, parent);
  success('git', ['clone', '--quiet', '--no-local', '--single-branch', '--no-tags', h.ROOT, checkout], directory, { env });
  assert.equal(success('git', ['rev-parse', 'HEAD'], checkout, { env }), head);
  assert.equal(success('git', ['rev-parse', 'HEAD^'], checkout, { env }), parent);
  assert.equal(success('git', ['merge-base', 'HEAD', base], checkout, { env }), base);
  success('git', ['merge-base', '--is-ancestor', base, 'HEAD'], checkout, { env });
  assert.equal(success('git', ['remote', 'get-url', 'origin'], checkout, { env }), h.ROOT);
  assert.equal(success('git', ['rev-parse', 'refs/remotes/origin/HEAD'], checkout, { env }), head);
  assert.deepEqual(success('git', ['rev-list', 'HEAD'], checkout, { env }).split('\n'),
    success('git', ['rev-list', 'HEAD'], h.ROOT, { env }).split('\n'));
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
  process.stdout.write(JSON.stringify({ head, parent, base, origin: h.ROOT, missing, historical_bytes: bytes.length,
    historical_sha256: h.hash(bytes), metadata_output: result.stdout }) + '\n');
});
test('T37-portable-baseline squash-equivalent full current tree over genuine main excludes epic-only history', bounded, t => {
  const directory = temporary(t), repository = path.join(directory, 'squash'), env = isolatedEnvironment(directory);
  const head = success('git', ['rev-parse', 'HEAD'], h.ROOT, { env });
  const tree = success('git', ['rev-parse', 'HEAD^{tree}'], h.ROOT, { env });
  const main = mainAncestry(h.ROOT, env);
  success('git', ['merge-base', '--is-ancestor', main, head], h.ROOT, { env });
  const epicOnly = success('git', ['rev-list', head, '^' + main], h.ROOT, { env }).split('\n').filter(Boolean);
  success('git', ['init', '--quiet', '--initial-branch=squash-fixture', repository], directory, { env });
  const pack = path.join(directory, 'reachable.pack'), output = fs.openSync(pack, 'wx');
  try {
    const result = command('git', ['pack-objects', '--stdout', '--revs'], h.ROOT,
      { env, input: tree + '\n' + main + '\n', stdio: ['pipe', output, 'pipe'] });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  } finally { fs.closeSync(output); }
  const input = fs.openSync(pack, 'r');
  try {
    success('git', ['index-pack', '--stdin'], repository, { env, stdio: [input, 'pipe', 'pipe'] });
  } finally { fs.closeSync(input); }
  const identity = { ...env, GIT_AUTHOR_NAME: 'T37 isolated fixture', GIT_AUTHOR_EMAIL: 't37@example.invalid',
    GIT_COMMITTER_NAME: 'T37 isolated fixture', GIT_COMMITTER_EMAIL: 't37@example.invalid' };
  const mainTree = success('git', ['rev-parse', main + '^{tree}'], repository, { env });
  const advancedMain = success('git', ['-c', 'commit.gpgsign=false', 'commit-tree', mainTree, '-p', main], repository,
    { env: identity, input: 'T37 isolated diverged main\n\nSigned-off-by: T37 isolated fixture <t37@example.invalid>\n' });
  const ticket = success('git', ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', main], repository,
    { env: identity, input: 'T37 isolated ticket tree\n\nSigned-off-by: T37 isolated fixture <t37@example.invalid>\n' });
  success('git', ['update-ref', 'refs/heads/squash-fixture', ticket], repository, { env });
  success('git', ['update-ref', 'refs/remotes/origin/main', advancedMain], repository, { env });
  assert.equal(command('git', ['merge-base', '--is-ancestor', advancedMain, 'HEAD'], repository, { env }).status, 1);
  const anchor = mainAncestry(repository, env);
  assert.equal(anchor, main);
  const squash = success('git', ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', anchor], repository,
    { env: identity, input: 'T37 temporary squash-equivalent fixture\n\nSigned-off-by: T37 isolated fixture <t37@example.invalid>\n' });
  success('git', ['update-ref', 'refs/heads/squash-fixture', squash], repository, { env });
  success('git', ['reset', '--hard', '--quiet', squash], repository, { env });
  assert.equal(success('git', ['rev-parse', 'HEAD^{tree}'], repository, { env }), tree);
  assert.equal(success('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], repository, { env }), squash + ' ' + main);
  assert.equal(success('git', ['merge-base', 'HEAD', main], repository, { env }), main);
  assert.deepEqual(success('git', ['rev-list', 'HEAD^'], repository, { env }).split('\n'),
    success('git', ['rev-list', main], h.ROOT, { env }).split('\n'));
  for (const revision of [...epicOnly, REVISION]) {
    const result = command('git', ['cat-file', '-e', revision + '^{commit}'], repository, { env });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0, revision + ' must be absent');
  }
  for (const name of ['alternates', 'http-alternates'])
    assert.equal(fs.existsSync(path.join(repository, '.git/objects/info', name)), false);
  fs.copyFileSync(__filename, path.join(repository, 'tests/unit', path.basename(__filename)));
  const result = command(process.execPath, ['--test', '--test-name-pattern=^' + portableCase + '$',
    'tests/unit/' + path.basename(__filename)], repository, { env });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /(?:# |ℹ )tests 1/); assert.match(result.stdout, /(?:# |ℹ )pass 1/);
  assert.match(result.stdout, /(?:# |ℹ )fail 0/);
  const proof = JSON.parse(result.stdout.split('\n').map(line => line.replace(/^# /, ''))
    .find(line => line.startsWith('{"head":')));
  assert.equal(proof.head, squash); assert.equal(proof.parent, main); assert.equal(proof.base, main);
  assert.equal(proof.origin, repository);
  process.stdout.write(JSON.stringify({ source_head: head, full_tree: tree, genuine_main_parent: main,
    diverged_main: advancedMain, derived_main_anchor: anchor,
    squash_head: squash, excluded_epic_commits: epicOnly, portable_test_output: result.stdout }) + '\n');
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
test('T37-admission exact75 prefix and one default76th shard with79 total checks', bounded, t => {
  const s = require('./shard-files.cjs'), files = s.unitFiles(), tasks = s.unitTasks(files);
  const actual = s.appendShard(s.readManifest(), tasks), self = path.basename(__filename);
  assert.ok(actual.shards.length >= 76);
  assert.equal(h.hash(JSON.stringify(actual.shards.slice(0, 74))), 'a6a52de553ecef8424b4a39d85bd6ce7338549072450a91c902c63a63a0da9b6');
  assert.deepEqual(actual.shards[74], ['phase53-z36-completed-ci-original-recovery.test.cjs']);
  assert.deepEqual(actual.shards[75], [self]);
  assert.equal(actual.shards.flat().filter(task => task === self).length, 1);
  assert.deepEqual([...actual.shards.flat()].sort(), tasks);
  assert.equal(new Set(actual.shards.flat()).size, tasks.length);
  const runner = fs.readFileSync(path.join(__dirname, 'run.sh'), 'utf8');
  const selection = /unit_selection="\$\(node - "\$\{UNIT_SHARD:-\}" <<'NODE'\n([^]*?)\nNODE\n\)"/.exec(runner);
  assert.ok(selection);
  function discovery(root, roster, discovered) {
    const directory = path.join(root, 'tests/unit'), count = roster.shards.length;
    const matrix = JSON.parse(success(process.execPath, [path.join(directory, 'shard-files.cjs'), '--matrix'], root));
    assert.deepEqual(matrix.shard, roster.shards.map((_, index) => (index + 1) + '/' + count));
    assert.deepEqual([...roster.shards.flat()].sort(), discovered);
    assert.equal(new Set(roster.shards.flat()).size, discovered.length);
    for (let index = 0; index < count; index++)
      assert.deepEqual(s.selectTaskShard((index + 1) + '/' + count, directory), roster.shards[index]);
    for (const shard of ['', '76/' + count, count + '/' + count]) {
      const queue = success(process.execPath, ['-', shard], root, { input: selection[1] });
      const expected = (shard ? roster.shards[s.parseSpec(shard).index - 1] : discovered).map(task => {
        const parsed = s.parseTask(task);
        return 'tests/unit/' + parsed.file + (parsed.partition === null ? '' : '#integration-partition=' + parsed.partition);
      });
      assert.deepEqual(queue.split('\n'), expected);
    }
    return { unit_shards: count, total_checks: count + 3, tasks: discovered.length };
  }
  const current = discovery(h.ROOT, actual, tasks);
  const baselineTasks = actual.shards.slice(0, 76).flat().sort();
  const baseline = s.appendShard(s.readManifest(), baselineTasks);
  assert.equal(baseline.shards.length, 76); assert.equal(baseline.shards.length + 3, 79);
  assert.deepEqual(baseline.shards, actual.shards.slice(0, 76));
  const futureRoot = temporary(t), futureDirectory = path.join(futureRoot, 'tests/unit');
  fs.mkdirSync(futureDirectory, { recursive: true });
  for (const name of [...files, 'shard-files.cjs', 'shard-manifest.json'])
    fs.copyFileSync(path.join(__dirname, name), path.join(futureDirectory, name));
  function appendFixture(name) {
    assert.deepEqual(s.parseTask(name), { file: name, partition: null });
    assert.equal(fs.existsSync(path.join(futureDirectory, name)), false);
    fs.writeFileSync(path.join(futureDirectory, name),
      "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\n"
      + "test('T37 isolated future shard fixture', () => assert.equal(37 + 1, 38));\n");
    success(process.execPath, ['--test', path.join(futureDirectory, name)], futureRoot);
  }
  function afterLast(names, suffix) {
    const name = [...names].sort().at(-1).slice(0, -'.test.cjs'.length) + 'z-' + suffix + '.test.cjs';
    assert.ok(names.every(existing => existing < name));
    return name;
  }
  const phase54 = 'phase54-t37-synthetic-extra.test.cjs';
  const unassigned = actual.shards.slice(s.readManifest().shards.length).flat();
  const preceding = !files.includes(phase54) && unassigned.every(name => name < phase54)
    ? phase54 : afterLast(files, 'phase54-t37-synthetic-extra');
  appendFixture(preceding);
  const precedingTasks = s.unitTasks(s.unitFiles(futureDirectory));
  const precedingRoster = s.appendShard(s.readManifest(), precedingTasks);
  assert.equal(precedingRoster.shards.length, actual.shards.length + 1);
  assert.deepEqual(precedingRoster.shards.slice(0, actual.shards.length), actual.shards);
  assert.deepEqual(precedingRoster.shards.at(-1), [preceding]);
  const withPhase54 = discovery(futureRoot, precedingRoster, precedingTasks);
  const extra = afterLast(s.unitFiles(futureDirectory), 't37-synthetic-extra');
  appendFixture(extra);
  const futureTasks = s.unitTasks(s.unitFiles(futureDirectory));
  assert.deepEqual(futureTasks, s.unitTasks([...files, preceding, extra]));
  const future = s.appendShard(s.readManifest(), futureTasks);
  assert.equal(future.shards.length, precedingRoster.shards.length + 1);
  assert.deepEqual(future.shards.slice(0, precedingRoster.shards.length), precedingRoster.shards);
  assert.deepEqual(future.shards.at(-1), [extra]);
  const appended = discovery(futureRoot, future, futureTasks);
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.throws(() => s.validateManifest({ ...actual, shards: [...actual.shards, [self]] }, tasks));
  assert.throws(() => s.validateManifest({ ...actual, shards: actual.shards.slice(0, -1) }, tasks));
  assert.throws(() => s.selectTaskShard('1/75'));
  assert.throws(() => s.selectTaskShard('1/' + actual.shards.length, futureDirectory));
  process.stdout.write(JSON.stringify({ baseline: { unit_shards: baseline.shards.length,
    total_checks: baseline.shards.length + 3 }, current, with_phase54: withPhase54, future: appended, synthetic_extra: extra,
    preserved_prefix_shards: actual.shards.length }) + '\n');
});
