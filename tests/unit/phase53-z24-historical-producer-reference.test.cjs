'use strict';

// @contract: Only this singleton registers the portable historical fixture cases.
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test, before, after } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const HELPER = 'tests/fixtures/phase53/semantic-result-helpers.cjs';
const FIXTURES = 'tests/fixtures/phase53/historical-semantic-producer';
const SELF = 'tests/unit/phase53-z24-historical-producer-reference.test.cjs';
const REVISIONS = ['cfc5bcc51be8815b09d1c5a64f038715f316cf76', '2e9890bddd11a062b56f3d41c222bc59ffbc4e58'];
const ORIGINALS = {
  'role-artifact.cjs': [700187, '8bbca68a49a1029bcc29dd9f81046cab0241617f39bcf711238a55925456e94f', '12f5aec2819e1179ddaadea0765f9a70d62ef559', '100644'],
  'codex-delivery-host.cjs': [282399, '0c7fc0c69e28770a53b108957cb5704c44dd6434d42fb14e7922784b0f605b85', 'bafb153b3c6e88177b1497c5abf608d277e1a01e', '100644'],
  'claude-role-host.cjs': [170119, '0a7669a6cfc890ee5fcad129cf463fb8e9b65a13859a110de7833952f9743f7f', '53b71ef1d86c9bc669fc32095019df8829aa697f', '100644'],
};
const OWNED = [HELPER, SELF, 'tests/unit/phase53-z25-historical-fixture-text-transport.test.cjs',
  FIXTURES + '/manifest.json', ...Object.keys(ORIGINALS).flatMap(name => [FIXTURES + '/' + name + '.gz', FIXTURES + '/' + name + '.gz.b64'])];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blob = bytes => crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
function cleanEnv(home, temporary) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  return { ...env, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
}
function command(program, args, cwd, env) {
  const child = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, program + ' ' + args.join(' ') + '\n' + child.stderr);
  return program === 'git' && args.some(arg => arg === '-z' || arg === '-rz') ? child.stdout : child.stdout.trim();
}
function absentHistory(root, env) {
  const git = (...args) => command('git', args, root, env);
  assert.equal(git('rev-list', '--all', '--count'), '1');
  assert.match(git('rev-list', '--parents', 'HEAD'), /^[a-f0-9]{40}$/);
  assert.equal(git('remote'), ''); assert.equal(git('tag'), '');
  assert.equal(git('for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  const config = git('config', '--local', '--list').split('\n');
  for (const row of config) assert.match(row, /^core\.(?:repositoryformatversion=0|filemode=true|bare=false|logallrefupdates=true|ignorecase=true|precomposeunicode=true)$/);
  assert.ok(config.includes('core.bare=false'));
  assert.equal(fs.lstatSync(path.join(root, '.git')).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(root, '.git/commondir')), false);
  for (const name of ['alternates', 'http-alternates']) assert.equal(fs.existsSync(path.join(root, '.git/objects/info', name)), false);
  assert.equal(fs.existsSync(path.join(root, '.git/shallow')), false);
  for (const revision of REVISIONS) {
    const child = spawnSync('git', ['cat-file', '-e', revision + '^{commit}'], { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.error, undefined); assert.notEqual(child.status, 0, 'historical commit must genuinely be absent');
  }
  const lookup = spawnSync('git', ['show', REVISIONS[0] + ':plugins/delivery-pipeline/scripts/role-artifact.cjs'],
    { cwd: root, env, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(lookup.error, undefined); assert.notEqual(lookup.status, 0);
}
function fixtureIdentity(root) {
  const directory = path.join(root, FIXTURES), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  assert.equal(manifest.schema, 'shipyard.historical-semantic-producer-fixture');
  assert.equal(manifest.version, 2); assert.equal(manifest.compression, 'gzip');
  assert.deepEqual(manifest.revisions, REVISIONS);
  assert.deepEqual(Object.keys(manifest.sources).sort(), Object.keys(ORIGINALS).sort());
  for (const [name, [count, digest, identity, mode]] of Object.entries(ORIGINALS)) {
    const row = manifest.sources[name], compressed = Buffer.from(fs.readFileSync(path.join(directory, name + '.gz.b64'), 'ascii').trimEnd(), 'base64');
    assert.equal(row.fixture, name + '.gz.b64'); assert.equal(row.source_path, 'plugins/delivery-pipeline/scripts/' + name);
    assert.equal(row.mode, mode); assert.equal(row.blob, identity);
    assert.equal(row.uncompressed_bytes, count); assert.equal(row.uncompressed_sha256, digest);
    assert.equal(compressed.length, row.compressed_bytes); assert.equal(sha(compressed), row.compressed_sha256);
    assert.deepEqual([...compressed.subarray(0, 10)], [31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
    const bytes = zlib.gunzipSync(compressed, { maxOutputLength: count });
    assert.equal(bytes.length, count); assert.equal(sha(bytes), digest); assert.equal(blob(bytes), identity);
  }
}
function squashCandidate(directory, env) {
  const checkout = path.join(directory, 'squash'), archive = path.join(directory, 'candidate.tar');
  if (fs.realpathSync(ROOT) !== ROOT || fs.realpathSync(directory) !== directory)
    throw Error('candidate roots must be physical');
  fs.mkdirSync(checkout);
  const listing = args => {
    const output = command('git', args, ROOT, env);
    if (!output) return [];
    const records = output.split('\0');
    if (records.pop() !== '') throw Error('incomplete NUL listing');
    return records;
  };
  const changed = [...new Set([...listing(['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']),
    ...listing(['ls-files', '--others', '--exclude-standard', '-z'])])];
  const lstat = file => {
    try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const entry = (root, relative, create = false) => {
    const parts = relative.split('/');
    if (path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part)))
      throw Error('unsafe candidate path: ' + relative);
    const file = path.join(root, relative);
    if (!file.startsWith(root + path.sep)) throw Error('candidate path escaped root');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      let stat = lstat(parent);
      if (!stat && create) { fs.mkdirSync(parent); stat = lstat(parent); }
      if (!stat || stat.isFile()) {
        if (create) throw Error('blocked candidate parent: ' + relative);
        return { file, stat: null };
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(parent) !== parent
          || lstat(path.join(parent, '.git')))
        throw Error('unsafe candidate parent: ' + relative);
    }
    return { file, stat: lstat(file) };
  };
  const tree = listing(['ls-tree', '-rz', '--full-tree', 'HEAD']).map(record => {
    const tab = record.indexOf('\t');
    if (tab < 0) throw Error('invalid tree entry');
    const [mode, type, identity] = record.slice(0, tab).split(' '), relative = record.slice(tab + 1);
    assert.equal(type, 'blob', 'no shared Git metadata or submodules');
    entry(ROOT, relative);
    return { mode, identity, relative };
  });
  const tracked = new Map(tree.map(row => [row.relative, row]));
  command('git', ['archive', '--format=tar', '--output=' + archive, 'HEAD'], ROOT, env);
  command('tar', ['-xf', archive, '-C', checkout], directory, env);
  fs.unlinkSync(archive);
  for (const { mode, identity, relative } of tree) {
    const { file, stat } = entry(checkout, relative);
    if (!stat || (mode === '120000' ? !stat.isSymbolicLink() : !stat.isFile() || stat.isSymbolicLink()))
      throw Error('archive omitted or substituted candidate type: ' + relative);
    const bytes = mode === '120000' ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    if (blob(bytes) !== identity || mode !== '120000' && (stat.mode & 0o777) !== (mode === '100755' ? 0o755 : 0o644))
      throw Error('archive substituted candidate bytes or mode: ' + relative);
  }
  const removed = new Set(), additions = [], completed = new Set();
  for (const relative of changed) {
    const { stat } = entry(ROOT, relative);
    if (!stat || stat.isDirectory() && tracked.has(relative)) {
      if (!tracked.has(relative)) throw Error('untracked candidate disappeared: ' + relative);
      removed.add(relative);
    } else additions.push(relative);
  }
  for (const relative of removed) {
    const { file, stat } = entry(checkout, relative);
    if (!stat || !stat.isFile() && !stat.isSymbolicLink()) throw Error('invalid archived removal: ' + relative);
    fs.unlinkSync(file);
    if (lstat(file)) throw Error('candidate removal incomplete: ' + relative);
    for (let parent = path.dirname(file); parent !== checkout; parent = path.dirname(parent)) {
      try { fs.rmdirSync(parent); } catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
        break;
      }
    }
    completed.add(relative);
  }
  for (const relative of additions) {
    const { file: source, stat } = entry(ROOT, relative), { file: target, stat: previous } = entry(checkout, relative, true);
    assert.equal(stat?.isFile(), true); assert.equal(stat?.isSymbolicLink(), false);
    if (previous) {
      if (previous.isDirectory()) fs.rmdirSync(target);
      else if (previous.isFile() || previous.isSymbolicLink()) fs.unlinkSync(target);
      else throw Error('unsupported archived replacement: ' + relative);
    }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, stat.mode & 0o777);
    const observed = fs.lstatSync(target);
    if (!observed.isFile() || observed.isSymbolicLink()) throw Error('candidate copy type changed: ' + relative);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source), relative);
    assert.equal(observed.mode & 0o777, fs.lstatSync(source).mode & 0o777);
    completed.add(relative);
  }
  const present = new Set([...tracked.keys(), ...additions].filter(relative => !removed.has(relative)));
  for (const relative of new Set([...tracked.keys(), ...changed])) {
    const { file: source, stat } = entry(ROOT, relative), { file: target, stat: observed } = entry(checkout, relative);
    if (removed.has(relative)) {
      if (observed && (!stat?.isDirectory() || !observed.isDirectory()))
        throw Error('candidate deletion was not preserved: ' + relative);
      continue;
    }
    const mode = changed.includes(relative) ? '100644' : tracked.get(relative).mode;
    assert.equal(stat?.isSymbolicLink(), mode === '120000');
    if (!observed || observed.isSymbolicLink() !== stat.isSymbolicLink()
        || !stat.isSymbolicLink() && (!stat.isFile() || !observed.isFile()))
      throw Error('final candidate type mismatch: ' + relative);
    if (mode === '120000') assert.equal(fs.readlinkSync(target), fs.readlinkSync(source));
    else {
      assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source), 'archive must equal actual current candidate: ' + relative);
      assert.equal(observed.mode & 0o777, stat.mode & 0o777, relative);
    }
  }
  const expected = new Set(present), actual = new Set();
  for (const relative of present)
    for (let parent = path.dirname(relative); parent !== '.'; parent = path.dirname(parent)) expected.add(parent);
  const inventory = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix + name, { file, stat } = entry(checkout, relative);
      actual.add(relative);
      if (stat.isDirectory()) inventory(file, relative + '/');
      else if (!stat.isFile() && !stat.isSymbolicLink()) throw Error('unsupported destination node: ' + relative);
    }
  };
  inventory(checkout);
  assert.ok(changed.every(file => completed.has(file) && (removed.has(file)
    ? !present.has(file) && (!actual.has(file) || fs.lstatSync(path.join(checkout, file)).isDirectory()) : actual.has(file)))
    && actual.size === expected.size && [...actual].every(file => expected.has(file)),
  'unrelated dirty candidate files must not be silently archived away');
  command('git', ['init', '--initial-branch=main', '--template='], checkout, env);
  command('git', ['add', '--all'], checkout, env);
  command('git', ['-c', 'user.name=Portable fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--no-gpg-sign', '-m', 'Squash-only current candidate fixture'], checkout, env);
  absentHistory(checkout, env); fixtureIdentity(checkout);
  return checkout;
}

async function flow(root, runtime, shared) {
  const h = require(path.join(root, HELPER));
  await h.publicRole('integrator', runtime, { historical: true, historicalShared: shared, full: true,
    inspect({ f, api, plugin, originals, prepared, snapshots }) {
      assert.equal(prepared.launches.length, 3); assert.equal(originals.length, 2);
      for (const launch of prepared.launches) {
        assert.equal(Object.hasOwn(launch.payload, 'result_formats'), false);
        assert.equal(Object.hasOwn(launch.result, 'result_format'), false);
      }
      for (const original of originals) assert.deepEqual(JSON.parse(original.original_text), original.result);
      for (const name of shared ? ['role-artifact.cjs'] : Object.keys(ORIGINALS)) {
        const bytes = fs.readFileSync(path.join(plugin, 'scripts', name));
        assert.equal(bytes.length, ORIGINALS[name][0]); assert.equal(sha(bytes), ORIGINALS[name][1]);
        assert.equal(blob(bytes), ORIGINALS[name][2]); assert.equal(fs.statSync(path.join(plugin, 'scripts', name)).mode & 0o777, 0o644);
      }
      const canonical = path.dirname(h.SCRIPTS);
      assert.equal(h.cold(f, 'integrator', canonical)?.authenticated, true);
      assert.deepEqual(h.cold(f, 'integrator', canonical, originals), originals);
      if (shared) return;
      const custody = () => {
        const directory = api.archiveAuthorityDirectory(f.worktree);
        return { artifacts: h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')),
          envelopes: fs.readdirSync(directory).filter(name => name.startsWith('integration-semantic-')).sort().map(name => {
            const file = h.physical(f.root, path.join(directory, name));
            return { name, mode: fs.statSync(file).mode & 0o777, sha256: h.hash(fs.readFileSync(file)) };
          }) };
      };
      const before = custody();
      const staged = require(path.join(root, 'scripts/package-shipyard-codex.cjs')).build(path.join(f.root, 'legacy-consumer'));
      h.packageParity(staged);
      const consumer = path.join(staged, 'host/plugins/delivery-pipeline');
      assert.equal(h.cold(f, 'integrator', consumer)?.authenticated, true);
      assert.deepEqual(h.cold(f, 'integrator', consumer, originals), originals);
      assert.deepEqual(custody(), before, 'cold replay preserves original archives, envelopes and launch bindings');
      const snapshot = snapshots.get(originals[0].result.snapshot_sha256);
      const producer = h.physical(process.env.HOME, path.join(plugin, 'scripts/codex-delivery-host.cjs'));
      const bytes = fs.readFileSync(producer);
      assert.equal(sha(bytes), ORIGINALS['codex-delivery-host.cjs'][1]);
      assert.ok(snapshot.pins.some(pin => path.resolve(pin.root, pin.path) === producer && pin.sha256 === sha(bytes)));
      try {
        fs.appendFileSync(producer, '\n');
        assert.equal(h.cold(f, 'integrator', canonical), null); assert.equal(h.cold(f, 'integrator', consumer), null);
      } finally { fs.writeFileSync(producer, bytes); }
      assert.equal(h.cold(f, 'integrator', consumer)?.authenticated, true);
    } });
}

async function corruptionChecks(root) {
  const h = require(path.join(root, HELPER)), directory = path.join(root, FIXTURES);
  const original = new Map(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name))]));
  const manifestFile = path.join(directory, 'manifest.json');
  const edit = change => {
    const manifest = JSON.parse(fs.readFileSync(manifestFile)); change(manifest);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  };
  const name = 'role-artifact.cjs', file = path.join(directory, name + '.gz.b64');
  const outer = bytes => {
    fs.writeFileSync(file, bytes.toString('base64') + '\n');
    edit(m => { m.sources[name].compressed_bytes = bytes.length; m.sources[name].compressed_sha256 = sha(bytes); });
  };
  const encode = bytes => { const compressed = zlib.gzipSync(bytes, { level: 9 }); compressed[9] = 255; return compressed; };
  const compressed = Buffer.from(original.get(name + '.gz.b64').toString('ascii').trimEnd(), 'base64');
  const decoded = zlib.gunzipSync(compressed, { maxOutputLength: ORIGINALS[name][0] });
  const mutations = [
    ['missing manifest', () => fs.unlinkSync(manifestFile)],
    ...Object.keys(ORIGINALS).map(source => ['missing ' + source, () => fs.unlinkSync(path.join(directory, source + '.gz.b64'))]),
    ['malformed JSON', () => fs.writeFileSync(manifestFile, '{')],
    ['wrong schema', () => edit(m => { m.schema = 'other'; })],
    ['wrong version', () => edit(m => { m.version = 1; })],
    ['wrong compression', () => edit(m => { m.compression = 'deflate'; })],
    ['wrong original revision', () => edit(m => { m.revisions[0] = '0'.repeat(40); })],
    ['extra top field', () => edit(m => { m.fallback = true; })],
    ['missing source row', () => edit(m => { delete m.sources[name]; })],
    ['unknown source name', () => edit(m => { m.sources['other.cjs'] = m.sources[name]; delete m.sources[name]; })],
    ['extra source row', () => edit(m => { m.sources['other.cjs'] = m.sources[name]; })],
    ['extra row field', () => edit(m => { m.sources[name].fallback = true; })],
    ['wrong original mode', () => edit(m => { m.sources[name].mode = '100755'; })],
    ['wrong original blob', () => edit(m => { m.sources[name].blob = '0'.repeat(40); })],
    ['wrong decoded hash pin', () => edit(m => { m.sources[name].uncompressed_sha256 = '0'.repeat(64); })],
    ['false decoded byte count', () => edit(m => { m.sources[name].uncompressed_bytes++; })],
    ['wrong fixture filename', () => edit(m => { m.sources[name].fixture = 'other.cjs.gz.b64'; })],
    ['traversal fixture filename', () => edit(m => { m.sources[name].fixture = '../role-artifact.cjs.gz.b64'; })],
    ['absolute fixture filename', () => edit(m => { m.sources[name].fixture = file; })],
    ['traversal source path', () => edit(m => { m.sources[name].source_path = '../role-artifact.cjs'; })],
    ['absolute source path', () => edit(m => { m.sources[name].source_path = path.join(root, 'plugins/delivery-pipeline/scripts', name); })],
    ['false compressed size', () => edit(m => { m.sources[name].compressed_bytes--; })],
    ['invalid compressed size type', () => edit(m => { m.sources[name].compressed_bytes = '146138'; })],
    ['over-limit compressed metadata', () => edit(m => { m.sources[name].compressed_bytes = 262145; })],
    ['wrong compressed hash', () => edit(m => { m.sources[name].compressed_sha256 = '0'.repeat(64); })],
    ['malformed compressed hash', () => edit(m => { m.sources[name].compressed_sha256 = null; })],
    ['corrupt compressed bytes', () => { const bytes = Buffer.from(compressed); bytes[30] ^= 1; fs.writeFileSync(file, bytes.toString('base64') + '\n'); }],
    ['truncated gzip with valid outer hash', () => outer(compressed.subarray(0, -8))],
    ['invalid gzip with valid outer hash', () => outer(Buffer.concat([compressed.subarray(0, 10), Buffer.alloc(40, 255)]))],
    ['changed decoded bytes with valid outer hash', () => { const bytes = Buffer.from(decoded); bytes[100] ^= 1; outer(encode(bytes)); }],
    ['short decoded bytes with valid outer hash', () => outer(encode(decoded.subarray(0, -1)))],
    ['bounded over-expansion with valid outer hash', () => outer(encode(Buffer.alloc(ORIGINALS[name][0] + 1)))],
    ['over-limit compressed file', () => { const bytes = Buffer.alloc(262145); fs.writeFileSync(file, bytes); }],
    ['over-limit manifest', () => fs.writeFileSync(manifestFile, Buffer.alloc(16385, 32))],
    ['nonregular gzip', () => { fs.unlinkSync(file); fs.mkdirSync(file); }],
    ['nonregular manifest', () => { fs.unlinkSync(manifestFile); fs.mkdirSync(manifestFile); }],
    ['symlink gzip escape', () => { fs.unlinkSync(file); fs.symlinkSync(path.join(process.env.HOME, 'escape.gz.b64'), file); }],
    ['symlink manifest escape', () => { fs.unlinkSync(manifestFile); fs.symlinkSync(path.join(process.env.HOME, 'escape.json'), manifestFile); }],
    ['symlink fixture directory escape', () => { fs.rmSync(directory, { recursive: true }); fs.symlinkSync(path.join(process.env.HOME, 'escape-fixtures'), directory); }],
  ];
  fs.writeFileSync(path.join(process.env.HOME, 'escape.gz.b64'), original.get(name + '.gz.b64'));
  fs.writeFileSync(path.join(process.env.HOME, 'escape.json'), original.get('manifest.json'));
  const escape = path.join(process.env.HOME, 'escape-fixtures'); fs.mkdirSync(escape);
  for (const [name, bytes] of original) fs.writeFileSync(path.join(escape, name), bytes);
  for (const [label, mutate] of mutations) {
    fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory);
    for (const [name, bytes] of original) fs.writeFileSync(path.join(directory, name), bytes);
    const filename = path.join(root, HELPER), source = fs.readFileSync(filename, 'utf8');
    const boundary = source.indexOf('async function publicRole('); assert.ok(boundary > 0);
    const loaded = new Module(filename, module); loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source.slice(0, boundary) + '\nmodule.exports = { historicalSources };', filename);
    const reader = loaded.exports.historicalSources;
    for (const [source, bytes] of reader(Object.keys(ORIGINALS))) {
      assert.equal(bytes.length, ORIGINALS[source][0]); assert.equal(sha(bytes), ORIGINALS[source][1]);
      assert.equal(blob(bytes), ORIGINALS[source][2]);
    }
    mutate();
    const before = fs.readdirSync(process.env.HOME).filter(name => name.startsWith('producer-'));
    await assert.rejects(h.publicRole('integrator', 'codex', { historical: true, full: true }), undefined, label);
    assert.deepEqual(fs.readdirSync(process.env.HOME).filter(name => name.startsWith('producer-')), before,
      'all selected bytes must validate before isolated producer installation: ' + label);
  }
  return mutations.length;
}
function shardChecks(temporary) {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'], ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const frozen = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs']];
  const actual = s.appendShard(manifest, s.unitTasks(s.unitFiles()));
  assert.equal(sha(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(sha(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(actual.shards.slice(0, 39), first39); assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.deepEqual(actual.shards.slice(0, 44), frozen);
  const remaining = s.unitTasks(s.unitFiles()).filter(task => !frozen.flat().includes(task)).sort();
  assert.deepEqual(actual.shards, [...frozen, ...remaining.map(task => [task])]);
  for (let i = 0; i < actual.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
  const z23 = 'phase53-z23-verification-owner-heartbeat.test.cjs', z24 = path.basename(__filename);
  for (const include23 of [false, true]) {
    const directory = path.join(temporary, include23 ? 'with-z23' : 'without-z23'); fs.mkdirSync(directory);
    for (const file of new Set(frozen.flat().map(task => s.parseTask(task).file))) fs.writeFileSync(path.join(directory, file), '');
    fs.writeFileSync(path.join(directory, z24), '');
    if (include23) fs.writeFileSync(path.join(directory, z23), '');
    const expected = [...frozen, ...(include23 ? [z23, z24] : [z24]).sort().map(task => [task])];
    const current = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(current.shards, expected);
    for (let i = 0; i < current.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${current.shards.length}`, directory), current.shards[i]);
  }
  const futureDirectory = path.join(temporary, 'future'); fs.mkdirSync(futureDirectory);
  for (const file of s.unitFiles()) fs.writeFileSync(path.join(futureDirectory, file), '');
  fs.writeFileSync(path.join(futureDirectory, 'zz-future-historical.test.cjs'), '');
  const future = s.appendShard(actual, s.unitTasks(s.unitFiles(futureDirectory)));
  assert.deepEqual(future.shards.slice(0, actual.shards.length), actual.shards);
  assert.deepEqual(future.shards.at(-1), ['zz-future-historical.test.cjs']);
  for (let i = 0; i < future.shards.length; i++) assert.deepEqual(s.selectTaskShard(`${i + 1}/${future.shards.length}`, futureDirectory, actual), future.shards[i]);
}

if (isMainThread) {
  let directory, checkout, env;
  before(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z24-portable-')));
    const home = path.join(directory, 'setup-home'), temporary = path.join(directory, 'setup-tmp');
    fs.mkdirSync(home); fs.mkdirSync(temporary); env = cleanEnv(home, temporary);
    checkout = squashCandidate(directory, env);
  }, { timeout: 30000 });
  after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  for (const [runtime, shared] of [['codex', true], ['claude', true], ['codex', false]]) {
    test(runtime + (shared ? ' previous shared API' : ' recorded parent') + ' preserves real full reports and current cold authority after squash',
      { timeout: 180000 }, async t => {
        const home = fs.realpathSync(fs.mkdtempSync(path.join(directory, 'z21-case-'))), temporary = path.join(home, 'worker-tmp');
        fs.mkdirSync(temporary);
        const root = path.join(home, 'candidate'); fs.cpSync(checkout, root, { recursive: true });
        for (const relative of OWNED.filter(relative => fs.existsSync(path.join(ROOT, relative)))) assert.deepEqual(fs.readFileSync(path.join(root, relative)), fs.readFileSync(path.join(ROOT, relative)));
        const worker = new Worker(path.join(root, SELF), { workerData: { root, runtime, shared, cache: runtime === 'codex' && shared }, env: cleanEnv(home, temporary) });
        t.after(async () => { await worker.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
        await new Promise((resolve, reject) => {
          let complete = false, failure;
          worker.once('message', value => { complete = value?.completed === true; });
          worker.once('error', error => { failure = error; });
          worker.once('exit', code => failure ? reject(failure) : code || !complete ? reject(Error('flow exited without assertions: ' + code)) : resolve());
        });
        absentHistory(checkout, env);
      });
  }
  test('stored producer integrity refuses every isolated manifest path hash size and gzip mutation', { timeout: 30000 }, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(directory, 'z21-case-'))), temporary = path.join(home, 'worker-tmp');
    fs.mkdirSync(temporary); const root = path.join(home, 'candidate'); fs.cpSync(checkout, root, { recursive: true });
    const worker = new Worker(path.join(root, SELF), { workerData: { root, corruptions: true }, env: cleanEnv(home, temporary) });
    t.after(async () => { await worker.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
    await new Promise((resolve, reject) => {
      let count = 0, failure;
      worker.once('message', value => { count = value?.refusals || 0; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => failure ? reject(failure) : code || count < 40 ? reject(Error('incomplete integrity assertions: ' + count)) : resolve());
    });
    fixtureIdentity(checkout); absentHistory(checkout, env);
  });
  test('physical shard membership preserves frozen prefixes and accepts either z23 arrival order and later append', { timeout: 180000 }, () => shardChecks(directory));
} else Promise.resolve().then(async () => {
  absentHistory(workerData.root, process.env); fixtureIdentity(workerData.root);
  if (workerData.corruptions) {
    const refusals = await corruptionChecks(workerData.root);
    absentHistory(workerData.root, process.env);
    parentPort.postMessage({ completed: true, refusals }); return;
  }
  await flow(workerData.root, workerData.runtime, workerData.shared);
  if (workerData.cache) {
    const h = require(path.join(workerData.root, HELPER));
    const file = path.join(workerData.root, FIXTURES, 'role-artifact.cjs.gz.b64');
    const bytes = Buffer.from(fs.readFileSync(file, 'ascii').trimEnd(), 'base64'); bytes[30] ^= 1; fs.writeFileSync(file, bytes.toString('base64') + '\n');
    await assert.rejects(h.publicRole('integrator', 'codex', { historical: true, historicalShared: true, full: true }),
      /exact compressed digest/, 'same-process successful setup must not cache away subsequent disk corruption');
  }
  absentHistory(workerData.root, process.env);
  parentPort.postMessage({ completed: true, installed_native_acceptance: false });
}).catch(error => setImmediate(() => { throw error; }));
