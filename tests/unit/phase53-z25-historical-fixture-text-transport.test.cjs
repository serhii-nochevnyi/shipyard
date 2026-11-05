'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const ROOT = path.resolve(__dirname, '../..');
const HELPER = 'tests/fixtures/phase53/semantic-result-helpers.cjs';
const FIXTURES = 'tests/fixtures/phase53/historical-semantic-producer';
const SELF = 'tests/unit/phase53-z25-historical-fixture-text-transport.test.cjs';
const REVISIONS = ['cfc5bcc51be8815b09d1c5a64f038715f316cf76', '2e9890bddd11a062b56f3d41c222bc59ffbc4e58'];
const PINS = {
  'role-artifact.cjs': [194853, '22f91fcd6722041a26f40c64d9ce054c90062dc0372c3c41d374314da5aa528b',
    146138, '901d06c5a0231fc0993b05b9cdb039e0d3b9fb0dac0bfd5a5a5b2a05fe8370a9',
    700187, '8bbca68a49a1029bcc29dd9f81046cab0241617f39bcf711238a55925456e94f',
    '12f5aec2819e1179ddaadea0765f9a70d62ef559'],
  'codex-delivery-host.cjs': [84237, 'c69057f9528453b8cad1385f0990011cc9ff2396712b69da831ef044c78cc04b',
    63176, 'e8b9829143bd5f120634c75324ac7e7f3fd7d8715b94eda4f8df9f60142667e3',
    282399, '0c7fc0c69e28770a53b108957cb5704c44dd6434d42fb14e7922784b0f605b85',
    'bafb153b3c6e88177b1497c5abf608d277e1a01e'],
  'claude-role-host.cjs': [52777, '26bab3d762926d222d6197bdd87011c05d85ea07d1c42f0e3dd9af0d5335e653',
    39581, 'bb2466836f4106b12d515cafccb57a3717b751482894a065c36ba9a5130db9fb',
    170119, '0a7669a6cfc890ee5fcad129cf463fb8e9b65a13859a110de7833952f9743f7f',
    '53b71ef1d86c9bc669fc32095019df8829aa697f'],
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blob = bytes => crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const armor = bytes => bytes.toString('base64') + '\n';
const OWNED = [HELPER, FIXTURES + '/manifest.json', ...Object.keys(PINS).map(name => FIXTURES + '/' + name + '.gz'),
  ...Object.keys(PINS).map(name => FIXTURES + '/' + name + '.gz.b64'),
  'tests/unit/phase53-z24-historical-producer-reference.test.cjs', SELF];

function identity(root) {
  const directory = path.join(root, FIXTURES), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  assert.deepEqual(Object.keys(manifest).sort(), ['compression', 'encoding', 'revisions', 'schema', 'sources', 'version']);
  assert.equal(manifest.version, 2); assert.equal(manifest.encoding, 'base64');
  assert.equal(manifest.compression, 'gzip');
  assert.equal(manifest.schema, 'shipyard.historical-semantic-producer-fixture');
  assert.deepEqual(manifest.revisions, REVISIONS);
  assert.deepEqual(Object.keys(manifest.sources).sort(), Object.keys(PINS).sort());
  for (const [name, [textCount, textHash, gzipCount, gzipHash, count, digest, gitBlob]] of Object.entries(PINS)) {
    const file = path.join(directory, name + '.gz.b64'), text = fs.readFileSync(file);
    assert.equal(fs.existsSync(path.join(directory, name + '.gz')), false);
    assert.equal(fs.lstatSync(file).isFile(), true); assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(text.length, textCount); assert.equal(sha(text), textHash);
    assert.equal(text.every(byte => byte <= 127), true);
    assert.match(text.toString('ascii'), /^[A-Za-z0-9+/]+={0,2}\n(?![\s\S])/);
    const compressed = Buffer.from(text.subarray(0, -1).toString('ascii'), 'base64');
    assert.equal(armor(compressed), text.toString('ascii'));
    assert.equal(compressed.length, gzipCount); assert.equal(sha(compressed), gzipHash);
    assert.deepEqual([...compressed.subarray(0, 10)], [31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
    const decoded = zlib.gunzipSync(compressed, { maxOutputLength: count });
    assert.equal(decoded.length, count); assert.equal(sha(decoded), digest); assert.equal(blob(decoded), gitBlob);
    assert.deepEqual(manifest.sources[name], { fixture: name + '.gz.b64',
      source_path: 'plugins/delivery-pipeline/scripts/' + name, mode: '100644', blob: gitBlob,
      uncompressed_bytes: count, uncompressed_sha256: digest, compressed_bytes: gzipCount, compressed_sha256: gzipHash });
  }
}

function oldSetup() {
  const file = path.join(ROOT, 'tests/unit/phase53-z24-historical-producer-reference.test.cjs');
  const source = fs.readFileSync(file, 'utf8'), boundary = source.indexOf('\nif (isMainThread) {');
  assert.ok(boundary > 0);
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = Module._load;
  try {
    Module._load = function(request, ...args) {
      if (request === 'node:test') return { test() { assert.fail('old registration'); }, before() { assert.fail('old hook'); },
        after() { assert.fail('old hook'); } };
      return original.call(this, request, ...args);
    };
    loaded._compile(source.slice(0, boundary) + '\nmodule.exports = { cleanEnv, absentHistory, squashCandidate };', file);
    return loaded.exports;
  } finally { Module._load = original; }
}

function loadHelper(root, io = fs) {
  const file = path.join(root, HELPER), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = Module._load;
  try {
    Module._load = function(request, ...args) {
      if (request === 'node:fs') return io;
      if (request === 'node:os') return { ...os };
      if (request === path.join(root, 'plugins/delivery-pipeline/scripts/model-policy-internal.cjs'))
        return original.call(this, path.join(ROOT, 'plugins/delivery-pipeline/scripts/model-policy-internal.cjs'), ...args);
      return original.call(this, request, ...args);
    };
    loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.historicalSources = historicalSources;', file);
    return loaded.exports;
  } finally { Module._load = original; }
}

async function refusals() {
  const root = path.join(process.env.HOME, 'candidate'), directory = path.join(root, FIXTURES);
  fs.mkdirSync(path.dirname(path.join(root, HELPER)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, HELPER), path.join(root, HELPER));
  const saved = new Map(fs.readdirSync(path.join(ROOT, FIXTURES)).map(name =>
    [name, fs.readFileSync(path.join(ROOT, FIXTURES, name))]));
  const name = 'role-artifact.cjs', manifestFile = path.join(directory, 'manifest.json');
  const file = path.join(directory, name + '.gz.b64'), original = saved.get(name + '.gz.b64');
  const compressed = Buffer.from(original.toString('ascii').slice(0, -1), 'base64');
  const edit = change => {
    const value = JSON.parse(fs.readFileSync(manifestFile)); change(value);
    fs.writeFileSync(manifestFile, JSON.stringify(value));
  };
  const store = bytes => fs.writeFileSync(file, bytes);
  const outer = bytes => {
    store(armor(bytes)); edit(m => { m.sources[name].compressed_bytes = bytes.length;
      m.sources[name].compressed_sha256 = sha(bytes); });
  };
  const gzip = bytes => { const value = zlib.gzipSync(bytes, { level: 9 }); value[9] = 255; return value; };
  const decoded = zlib.gunzipSync(compressed);
  const replace = (offset, value) => { const bytes = Buffer.from(original); bytes[offset] = value; store(bytes); };
  const cases = [
    ['BOM', () => store(Buffer.concat([Buffer.from([239, 187, 191]), original])), /encoded byte count/],
    ['CRLF', () => store(original.subarray(0, -1).toString() + '\r\n'), /encoded byte count/],
    ['space', () => replace(20, 32), /canonical base64/],
    ['tab', () => replace(20, 9), /canonical base64/],
    ['embedded LF', () => replace(20, 10), /canonical base64/],
    ['trailing LF', () => store(Buffer.concat([original, Buffer.from('\n')])), /encoded byte count/],
    ['missing LF', () => store(original.subarray(0, -1)), /encoded byte count/],
    ['replaced final LF', () => replace(original.length - 1, 65), /canonical base64/],
    ['URL-safe minus', () => replace(20, 45), /canonical base64/],
    ['URL-safe underscore', () => replace(20, 95), /canonical base64/],
    ['high-bit byte', () => replace(20, 193), /raw ASCII/],
    ['missing padding', () => store(original.subarray(0, -2).toString() + '\n'), /encoded byte count/],
    ['excess padding', () => {
      const bytes = Buffer.from(original); bytes[original.length - 4] = 61; bytes[original.length - 3] = 61; store(bytes);
    }, /canonical base64/],
    ['noncanonical pad bits', () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const index = original.length - 3, bytes = Buffer.from(original);
      bytes[index] = alphabet.charCodeAt(alphabet.indexOf(String.fromCharCode(bytes[index])) | 1); store(bytes);
    }, /canonical base64 pad bits/],
    ['trailing junk', () => store(original.toString() + '!'), /encoded byte count/],
    ['equal-length junk', () => replace(20, 33), /canonical base64/],
    ['false encoded length', () => edit(m => { m.sources[name].compressed_bytes += 3; }), /encoded byte count/],
    ['encoded input exceeds 262144', () => store(Buffer.alloc(262145, 65)), /byte bound/],
    ['old version', () => edit(m => { m.version = 1; }), /2/],
    ['unknown version', () => edit(m => { m.version = 3; }), /2/],
    ['wrong schema', () => edit(m => { m.schema = 'other'; }), /shipyard.historical-semantic-producer-fixture/],
    ['wrong encoding', () => edit(m => { m.encoding = 'base64url'; }), /base64/],
    ['wrong compression', () => edit(m => { m.compression = 'deflate'; }), /gzip/],
    ['wrong revision', () => edit(m => { m.revisions[0] = '0'.repeat(40); }), /deep.equal/],
    ['wrong mode', () => edit(m => { m.sources[name].mode = '100755'; }), /immutable original/],
    ['wrong blob', () => edit(m => { m.sources[name].blob = '0'.repeat(40); }), /immutable original/],
    ['wrong decoded digest', () => edit(m => { m.sources[name].uncompressed_sha256 = '0'.repeat(64); }), /immutable original/],
    ['wrong decoded count', () => edit(m => { m.sources[name].uncompressed_bytes++; }), /immutable original/],
    ['wrong compressed digest', () => edit(m => { m.sources[name].compressed_sha256 = '0'.repeat(64); }), /exact compressed digest/],
    ['missing encoding', () => edit(m => { delete m.encoding; }), /closed historical manifest/],
    ['extra top-level key', () => edit(m => { m.fallback = true; }), /closed historical manifest/],
    ['missing source row', () => edit(m => { delete m.sources[name]; }), /closed historical manifest/],
    ['extra source row', () => edit(m => { m.sources['extra.cjs'] = m.sources[name]; }), /closed historical manifest/],
    ['extra row key', () => edit(m => { m.sources[name].encoding = 'base64'; }), /closed historical manifest/],
    ['missing row key', () => edit(m => { delete m.sources[name].blob; }), /closed historical manifest/],
    ['wrong constant filename', () => edit(m => { m.sources[name].fixture = 'other.gz.b64'; }), /immutable original/],
    ['traversal filename', () => edit(m => { m.sources[name].fixture = '../escape.gz.b64'; }), /immutable original/],
    ['absolute filename', () => edit(m => { m.sources[name].fixture = file; }), /immutable original/],
    ['traversal source path', () => edit(m => { m.sources[name].source_path = '../role-artifact.cjs'; }), /immutable original/],
    ['absolute source path', () => edit(m => { m.sources[name].source_path = file; }), /immutable original/],
    ['missing armor', () => fs.unlinkSync(file), /ENOENT/],
    ['missing manifest', () => fs.unlinkSync(manifestFile), /ENOENT/],
    ['nonregular armor', () => { fs.unlinkSync(file); fs.mkdirSync(file); }, /regular nonsymlink/],
    ['symlink armor', () => { fs.unlinkSync(file); fs.symlinkSync(path.join(process.env.HOME, 'escape.b64'), file); },
      /regular nonsymlink/],
    ['nonregular manifest', () => { fs.unlinkSync(manifestFile); fs.mkdirSync(manifestFile); }, /regular nonsymlink/],
    ['symlink manifest', () => { fs.unlinkSync(manifestFile); fs.symlinkSync(path.join(process.env.HOME, 'escape.json'), manifestFile); },
      /regular nonsymlink/],
    ['symlink directory', () => { fs.rmSync(directory, { recursive: true });
      fs.symlinkSync(path.join(process.env.HOME, 'escape-directory'), directory); }, /physical fixture directory/],
    ['manifest exceeds 16384', () => fs.writeFileSync(manifestFile, Buffer.alloc(16385, 32)), /byte bound/],
    ['deterministic gzip header', () => { const bytes = Buffer.from(compressed); bytes[9] = 3; outer(bytes); }, /deterministic gzip/],
    ['truncated valid armor and checksum', () => outer(compressed.subarray(0, -8)), /unexpected end|buffer/i],
    ['invalid gzip valid armor and checksum', () => outer(Buffer.concat([compressed.subarray(0, 10), Buffer.alloc(40, 255)])),
      /invalid|unknown|incorrect/i],
    ['decoded digest valid armor and checksum', () => {
      const bytes = Buffer.from(decoded); bytes[100] ^= 1; outer(gzip(bytes));
    }, /exact original digest/],
    ['decoded count valid armor and checksum', () => outer(gzip(decoded.subarray(0, -1))), /exact decoded byte count/],
    ['bounded gzip expansion', () => outer(gzip(Buffer.alloc(PINS[name][4] + 1))), /larger than|buffer|length/i],
    ['changed third selection', () => {
      const target = path.join(directory, 'claude-role-host.cjs.gz.b64');
      const bytes = Buffer.from(fs.readFileSync(target, 'ascii').slice(0, -1), 'base64'); bytes[30] ^= 1;
      fs.writeFileSync(target, armor(bytes));
    }, /exact compressed digest/],
    ['compressed metadata exceeds 262144', () => edit(m => { m.sources[name].compressed_bytes = 262145; }), /assertion|falsy/i],
    ['unsafe compressed metadata', () => edit(m => { m.sources[name].compressed_bytes = Number.MAX_SAFE_INTEGER + 1; }),
      /assertion|falsy/i],
    ['zero compressed metadata', () => edit(m => { m.sources[name].compressed_bytes = 0; }), /assertion|falsy/i],
    ['fractional compressed metadata', () => edit(m => { m.sources[name].compressed_bytes = 1.5; }), /assertion|falsy/i],
    ['string compressed metadata', () => edit(m => { m.sources[name].compressed_bytes = '146138'; }), /assertion|falsy/i],
  ];
  fs.writeFileSync(path.join(process.env.HOME, 'escape.b64'), original);
  fs.writeFileSync(path.join(process.env.HOME, 'escape.json'), saved.get('manifest.json'));
  fs.mkdirSync(path.join(process.env.HOME, 'escape-directory'));
  for (const [name, bytes] of saved) fs.writeFileSync(path.join(process.env.HOME, 'escape-directory', name), bytes);
  function reset() {
    fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory);
    for (const [name, bytes] of saved) fs.writeFileSync(path.join(directory, name), bytes);
  }
  let count = 0;
  async function refused(label, mutate, expected, io = fs) {
    reset(); const h = loadHelper(root, io);
    mutate();
    const before = fs.readdirSync(process.env.HOME).filter(name => name.startsWith('producer-'));
    await assert.rejects(h.publicRole('integrator', 'codex', { historical: true, full: true }), expected, label);
    assert.deepEqual(fs.readdirSync(process.env.HOME).filter(name => name.startsWith('producer-')), before, label);
    count++;
  }
  for (const row of cases) await refused(...row);
  let opened = 0, decodedTransport = 0;
  const noRead = new Proxy(fs, { get(target, key) {
    if (key === 'openSync') return (targetFile, ...args) => {
      if (targetFile === file) { opened++; assert.fail('over-limit calculated armor was opened'); }
      return target.openSync(targetFile, ...args);
    };
    return target[key];
  } });
  const from = Buffer.from;
  try {
    Buffer.from = function(value, encoding, ...args) {
      if (encoding === 'base64') decodedTransport++;
      return from(value, encoding, ...args);
    };
    await refused('calculated encoded bound before read or decode', () => edit(m => { m.sources[name].compressed_bytes = 196608; }),
      /encoded historical fixture exceeds byte bound/, noRead);
    assert.equal(opened, 0); assert.equal(decodedTransport, 0);
  } finally { Buffer.from = from; }
  for (const kind of ['inode before open', 'inode after read', 'device mismatch', 'incomplete read', 'same inode mutation']) {
    let fd, fired = false;
    const io = new Proxy(fs, { get(target, key) {
      if (key === 'openSync') return (targetFile, ...args) => {
        if (targetFile === file && kind === 'inode before open') {
          fs.renameSync(file, file + '.old'); fs.writeFileSync(file, original); fired = true;
        }
        const value = target.openSync(targetFile, ...args); if (targetFile === file) fd = value; return value;
      };
      if (key === 'fstatSync') return value => {
        const stat = target.fstatSync(value);
        if (value === fd && kind === 'device mismatch') {
          fired = true; return new Proxy(stat, { get(row, field) { return field === 'dev' ? row.dev + 1 : row[field]; } });
        }
        return stat;
      };
      if (key === 'readSync') return (value, ...args) => {
        if (value === fd && kind === 'incomplete read') { fired = true; return 0; }
        const size = target.readSync(value, ...args);
        if (value === fd && size && !fired && ['inode after read', 'same inode mutation'].includes(kind)) {
          fired = true;
          if (kind === 'inode after read') { fs.renameSync(file, file + '.old'); fs.writeFileSync(file, original); }
          else {
            const changed = Buffer.from(original); changed[20] ^= 1; fs.writeFileSync(file, changed);
            fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
          }
        }
        return size;
      };
      return target[key];
    } });
    await refused(kind, () => {}, /changed while reading|strictly equal|byte count/, io); assert.equal(fired, true, kind);
  }
  reset();
  const h = loadHelper(root), result = h.historicalSources(Object.keys(PINS));
  assert.equal(result.length, 3);
  for (const [source, bytes] of result) assert.equal(sha(bytes), PINS[source][5]);
  assert.throws(() => h.historicalSources(['../role-artifact.cjs']), /closed historical module name/);
  const bytes = Buffer.from(compressed); bytes[30] ^= 1; store(armor(bytes));
  assert.throws(() => h.historicalSources(Object.keys(PINS)), /exact compressed digest/);
  reset();
  const parent = path.dirname(directory), moved = parent + '-physical';
  try {
    fs.renameSync(parent, moved); fs.symlinkSync(moved, parent);
    assert.throws(() => h.historicalSources(Object.keys(PINS)), /physical fixture ancestry/);
  } finally { fs.rmSync(parent, { force: true }); fs.renameSync(moved, parent); }
  let reads = 0;
  const chunks = new Proxy(fs, { get(target, key) {
    if (key === 'readSync') return (fd, buffer, offset, length, position) => {
      reads++; return target.readSync(fd, buffer, offset, Math.min(length, 4096), position);
    };
    return target[key];
  } });
  assert.equal(loadHelper(root, chunks).historicalSources(Object.keys(PINS)).length, 3);
  assert.ok(reads > 10);
  return count;
}

function material() {
  os.homedir = () => process.env.HOME;
  const root = path.join(process.env.HOME, 'material');
  fs.mkdirSync(root);
  const command = (program, args, cwd = root) => execFileSync(program, args,
    { cwd, env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 }).trim();
  const git = (...args) => command('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Transport fixture',
    '-c', 'user.email=fixture@example.invalid', ...args]);
  const write = (relative, value) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  };
  const plan = '.planning/phases/38-transport-fixture/38-01-PLAN.md', epic = 'epic/38-transport-fixture';
  const row = { title: 'Isolated transport material fixture', plan, phase: '38', repo: null, wave: 1,
    depends_on: [], cross_phase_deps: [], cross_repo_deps: [], files: [...OWNED],
    risk: 'high', type: 'implementation', human_checkpoint: false, critical: false,
    branch: 'ticket/T-38-01', epic, pr_base: 'main' };
  const graph = { tickets: { 'T-38-01': row } }, state = { 'T-38-01': { status: 'merged', pr: 301 } };
  const rawManifest = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURES, 'manifest.json')));
  rawManifest.version = 1; delete rawManifest.encoding;
  for (const name of Object.keys(PINS)) {
    const stored = fs.readFileSync(path.join(ROOT, FIXTURES, name + '.gz.b64'), 'ascii');
    write(FIXTURES + '/' + name + '.gz', Buffer.from(stored.slice(0, -1), 'base64'));
    rawManifest.sources[name].fixture = name + '.gz';
  }
  write(FIXTURES + '/manifest.json', JSON.stringify(rawManifest, null, 2) + '\n');
  write('.planning/graph/tickets.json', JSON.stringify(graph));
  write('.planning/graph/delivery-state.json', JSON.stringify(state));
  write('.planning/config.json', JSON.stringify({ git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'report' } }));
  write('.planning/architecture/ADR-014-transport-fixture.md', '# ADR-014\nIsolated text transport fixture.\n');
  write(plan, '---\nphase: 38\nplan: 01\ntitle: Isolated text transport fixture\n---\n\n'
    + '## Context\nADR-014\n\n## Acceptance criteria\n- Retain complete owned material.\n\n'
    + '## Verification commands\n- node --test tests/unit/phase53-z25-historical-fixture-text-transport.test.cjs\n');
  git('init', '--initial-branch=main', '--template='); git('add', '--all'); git('commit', '--no-gpg-sign', '-m', 'Raw fixture base');
  const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base); git('switch', '-c', epic);
  for (const relative of OWNED) {
    const source = path.join(ROOT, relative), target = path.join(root, relative);
    if (!fs.existsSync(source)) { fs.rmSync(target, { force: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode & 0o777);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
    assert.equal(fs.statSync(target).mode & 0o777, fs.statSync(source).mode & 0o777);
  }
  identity(root);
  git('add', '--all'); git('commit', '--no-gpg-sign', '-m', 'Actual text transport candidate');
  const pr = { number: 301, state: 'OPEN', isDraft: false, title: 'Isolated transport fixture',
    body: 'Fixture facts only; no live PR or provider judgment.', headRefName: epic,
    headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', baseRefOid: base,
    reviewDecision: 'REVIEW_REQUIRED', mergedAt: null, mergeCommit: null };
  assert.notEqual(pr.number, 577);
  const scripts = path.join(ROOT, 'plugins/delivery-pipeline/scripts');
  const context = require(path.join(scripts, 'codex-code-review-context.cjs'));
  const target = require(path.join(scripts, 'architecture-target.cjs'));
  const policy = require(path.join(scripts, 'model-policy.cjs'));
  const architecture = require(path.join(scripts, 'codex-arch-review-context.cjs'));
  const storage = path.join(process.env.HOME, 'storage'), agentDir = path.join(storage, 'fixture-instructions');
  fs.mkdirSync(agentDir, { recursive: true });
  const instructions = "developer_instructions = '''\nInspect isolated transport fixture material.\n'''\n";
  const agentManifest = path.join(agentDir, '.shipyard-manifest.json');
  const trace = [], options = { graphDir: path.join(root, '.planning/graph'), refreshGit: false,
    defaultBranch: 'main', getPullRequest: () => ({ ...pr }), storageRoot: storage, agentDir, agentManifest,
    execFileSync(program, args, execution) {
      assert.equal(program, 'git');
      assert.equal(args.some(arg => ['fetch', 'pull', 'push', 'clone', 'ls-remote'].includes(arg)), false);
      trace.push([...args]);
      return execFileSync(program, args, execution);
    } };
  const prepare = () => {
    const binding = target.phaseBinding({ graph, state, phase: 38, repository: target.repositoryIdentity(root),
      pr: pr.number, head: pr.headRefOid, base: pr.baseRefOid, branch: epic });
    return context.prepareSemantic({ worktree: root, phase: 38, ticket: binding.subject },
      { role: 'code-review', context: {}, signals: {} }, options);
  };
  const value = prepare();
  const selection = policy.resolveDispatch({ runtime: 'codex', role: 'code-review', signals: value.prepared.signals });
  fs.writeFileSync(path.join(agentDir, selection.agent_file), instructions);
  fs.writeFileSync(agentManifest, JSON.stringify({ agent_files: [selection.agent_file],
    agent_digests: { [selection.agent_file]: sha(instructions) } }));
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(value.prepared.rows.flatMap(({ row }) => row.files), OWNED);
  const result = context.semanticSource(value), changes = architecture.focusedChangeInventory(
    result.packet.role_context.change_metadata.name_status, result.packet.role_context.change_metadata.numstat);
  assert.deepEqual(result.rows.flatMap(({ row }) => row.files), OWNED);
  assert.deepEqual(result.packet.immutable_scope.files_modified, OWNED);
  assert.equal(result.identity.head, pr.headRefOid); assert.equal(result.identity.base, base);
  for (const [name, [count, digest]] of Object.entries(PINS)) {
    const raw = FIXTURES + '/' + name + '.gz', text = raw + '.b64';
    const deletion = changes.find(change => change.old_path === raw);
    assert.equal(deletion?.status, 'D'); assert.equal(deletion.binary, true);
    assert.equal(deletion.classification, 'product'); assert.equal(deletion.new_path, null);
    const addition = changes.find(change => change.new_path === text);
    assert.equal(addition?.status, 'A'); assert.equal(addition.binary, false);
    assert.equal(addition.classification, 'product'); assert.equal(addition.old_path, null);
    const source = result.packet.product_sources.filter(source => source.path === text && source.revision === pr.headRefOid);
    assert.equal(source.length, 1);
    const bytes = fs.readFileSync(path.join(ROOT, text));
    assert.equal(source[0].content, bytes.toString('ascii'));
    assert.equal(source[0].bytes, count); assert.equal(source[0].sha256, digest);
    assert.equal(sha(Buffer.from(source[0].content)), digest);
    assert.equal(git('ls-tree', pr.headRefOid, '--', text).split(' ')[0], '100644');
    assert.ok(trace.some(args => args.includes('ls-tree') && args.at(-1) === text));
    assert.ok(trace.some(args => args.includes('show') && args.at(-1) === pr.headRefOid + ':' + text));
    const compressed = execFileSync('git', ['-C', root, 'show', base + ':' + raw],
      { env: process.env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(compressed.length, PINS[name][2]); assert.equal(sha(compressed), PINS[name][3]);
  }
  const inventory = new Set(changes.flatMap(change => change.paths));
  for (const relative of OWNED) assert.equal(inventory.has(relative), true, relative);
  const invalid = 'tests/fixtures/phase53/invalid-owned.bin';
  write(invalid, Buffer.from([255, 254, 0, 97]));
  row.files.push(invalid); write('.planning/graph/tickets.json', JSON.stringify(graph));
  git('add', '--all'); git('commit', '--no-gpg-sign', '-m', 'Genuine invalid UTF8 owned blob fixture');
  pr.headRefOid = git('rev-parse', 'HEAD');
  const negative = prepare();
  assert.equal(Object.isFrozen(negative), true);
  assert.ok(negative.prepared.rows[0].row.files.includes(invalid));
  assert.throws(() => context.semanticSource(negative), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
  assert.ok(trace.some(args => args.includes('show') && args.at(-1) === pr.headRefOid + ':' + invalid));
  assert.equal(git('remote'), '');
  assert.equal(fs.existsSync(path.join(root, '.git/objects/info/alternates')), false);
  return { assets: Object.keys(PINS).length, invalidUTF8Refused: true };
}

function discovery(temporary) {
  const s = require('./shard-files.cjs'), manifest = s.readManifest();
  const parent = require('../fixtures/phase53/github-job-attempts.json').parent.shards;
  const first39 = [...parent, ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first40 = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs']];
  const first44 = [...first40, ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs']];
  const first46 = [...first44, ['phase53-z23-verification-owner-heartbeat.test.cjs'],
    ['phase53-z24-historical-producer-reference.test.cjs']];
  const files = s.unitFiles(), tasks = s.unitTasks(files), actual = s.appendShard(manifest, tasks);
  assert.equal(sha(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  assert.equal(sha(JSON.stringify(actual.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(actual.shards.slice(0, 39), first39); assert.deepEqual(actual.shards.slice(0, 40), first40);
  assert.deepEqual(actual.shards.slice(0, 44), first44); assert.deepEqual(actual.shards.slice(0, 46), first46);
  const missing = tasks.filter(task => !first46.flat().includes(task)).sort();
  assert.deepEqual(actual.shards, [...first46, ...missing.map(task => [task])]);
  assert.deepEqual(actual.shards[46], [path.basename(SELF)]);
  for (let index = 0; index < actual.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  for (const job of ['shards', 'rest', 'test-fast']) assert.match(workflow, new RegExp('^  ' + job + ':$', 'm'));
  assert.match(workflow, /name: unit \(shard \$\{\{ matrix.shard \}\}\)/);
  const checks = ['shards', ...actual.shards.map((_, index) => `unit (shard ${index + 1}/${actual.shards.length})`),
    'gates and smoke', 'test-fast'];
  assert.equal(new Set(checks).size, actual.shards.length + 3);
  const current = s.appendShard(manifest, tasks.filter(task => first46.flat().includes(task) || task === path.basename(SELF)));
  assert.equal(current.shards.length, 47); assert.equal(current.shards.length + 3, 50);
  fs.mkdirSync(temporary);
  for (const file of files) fs.writeFileSync(path.join(temporary, file), '');
  fs.writeFileSync(path.join(temporary, 'zz-future-transport.test.cjs'), '');
  const future = s.appendShard(actual, s.unitTasks(s.unitFiles(temporary)));
  assert.deepEqual(future.shards.slice(0, actual.shards.length), actual.shards);
  assert.deepEqual(future.shards.at(-1), ['zz-future-transport.test.cjs']);
  assert.equal(future.shards.length, actual.shards.length + 1);
  for (let index = 0; index < future.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${future.shards.length}`, temporary, actual), future.shards[index]);
}

async function isolated(t, mode) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-z25-'))), temporary = path.join(home, 'tmp');
  fs.mkdirSync(temporary);
  const env = oldSetup().cleanEnv(home, temporary);
  const worker = new Worker(__filename, { workerData: { mode }, env });
  t.after(async () => { await worker.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
  return new Promise((resolve, reject) => {
    let value, failure;
    worker.once('message', message => { value = message; });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => failure ? reject(failure) : code || !value
      ? reject(Error(mode + ' exited without assertions: ' + code)) : resolve(value));
  });
}

function denyNetwork() {
  const bin = path.join(process.env.HOME, 'offline-bin'); fs.mkdirSync(bin);
  const local = path.join(bin, 'local-fixture.json');
  const git = process.env.PATH.split(path.delimiter).map(directory => path.join(directory, 'git')).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  assert.ok(git);
  const guard = function(executable, fixtureFile) {
    const fs = require('node:fs'), path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2), env = { ...process.env, GIT_ALLOW_PROTOCOL: '' };
    const index = args.findIndex(arg => ['fetch', 'pull', 'push', 'clone', 'ls-remote'].includes(arg));
    if (index >= 0) {
      try {
        const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
        const cwd = args.includes('-C') ? path.resolve(args[args.indexOf('-C') + 1]) : process.cwd();
        if (fs.realpathSync(cwd) !== fixture.worktree) process.exit(89);
        const operation = args.slice(index);
        if (operation[0] === 'clone') {
          if (JSON.stringify(operation) !== JSON.stringify(['clone', '--bare', '--quiet', fixture.worktree, fixture.remote])
              || fs.existsSync(fixture.remote)) process.exit(89);
        } else if (operation[0] === 'fetch') {
          if (!['--quiet', '--no-tags'].includes(operation[1]) || operation[2] !== 'origin'
              || operation.length !== 4 || !/^\+refs\/heads\/[A-Za-z0-9._/-]+:refs\/remotes\/origin\/[A-Za-z0-9._/-]+$/.test(operation[3]))
            process.exit(89);
          const remote = spawnSync(executable, ['-C', cwd, 'config', '--get', 'remote.origin.url'],
            { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
          if (remote.error || remote.status !== 0 || remote.stdout.trim() !== fixture.remote
              || fs.realpathSync(fixture.remote) !== fixture.remote) process.exit(89);
        } else process.exit(89);
        env.GIT_ALLOW_PROTOCOL = 'file';
      } catch { process.exit(89); }
    }
    const child = spawnSync(executable, args, { env, stdio: 'inherit', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    process.exit(child.error ? 90 : child.status ?? 91);
  };
  const guardFile = path.join(bin, 'network-operation.cjs');
  const guardSource = '(' + guard.toString() + ')(' + JSON.stringify(git) + ', ' + JSON.stringify(local) + ');\n';
  fs.writeFileSync(guardFile, guardSource);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const source = '#!/bin/sh\nfor arg do\ncase "$arg" in fetch|pull|push|clone|ls-remote) exec '
    + quote(process.execPath) + ' ' + quote(guardFile) + ' "$@";; esac\ndone\nexec ' + quote(git) + ' "$@"\n';
  fs.writeFileSync(path.join(bin, 'git'), source, { mode: 0o755 });
  for (const name of ['gh', 'curl', 'wget', 'ssh', 'scp'])
    fs.writeFileSync(path.join(bin, name), '#!' + process.execPath + '\nprocess.exit(89);\n', { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.GIT_ALLOW_PROTOCOL = '';
  const original = Module._load;
  Module._load = function(request, ...args) {
    if (['net', 'node:net', 'tls', 'node:tls', 'http', 'node:http', 'https', 'node:https', 'http2', 'node:http2',
      'dgram', 'node:dgram'].includes(request)) throw Error('network unavailable in transport fixture');
    return original.call(this, request, ...args);
  };
  globalThis.fetch = () => { throw Error('network unavailable in transport fixture'); };
  return f => {
    const temporary = fs.realpathSync(process.env.TMPDIR), root = fs.realpathSync(f.root);
    assert.ok(root.startsWith(temporary + path.sep));
    assert.equal(fs.realpathSync(f.worktree), path.join(root, 'worktree'));
    fs.writeFileSync(local, JSON.stringify({ worktree: f.worktree, remote: path.join(root, 'origin.git') }));
  };
}

if (isMainThread) {
  test('all three text compressed and decoded identities equal independent immutable pins', () => identity(ROOT));
  test('closed canonical bounded transport physical provenance and inner gzip refusals precede installation',
    { timeout: 180000 }, async t => {
      const value = await isolated(t, 'refusals'); assert.ok(value.refusals >= 55);
    });
  test('ordinary private prepareSemantic then real Git semanticSource retains full text and rejects invalid UTF8',
    { timeout: 180000 }, async t => {
      assert.deepEqual(await isolated(t, 'material'), { assets: 3, invalidUTF8Refused: true });
    });
  test('physical discovery retains every frozen and current row appends z25 and permits future singleton', t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z25-shards-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true })); discovery(path.join(directory, 'future'));
  });
  test('actual armor candidate survives one-root squash and Codex shared full-report cold authentication',
    { timeout: 180000 }, async t => {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z25-portable-')));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const h = oldSetup(), home = path.join(directory, 'z21-case-transport'), temporary = path.join(home, 'tmp');
      fs.mkdirSync(temporary, { recursive: true }); const env = h.cleanEnv(home, temporary);
      const root = h.squashCandidate(directory, env); identity(root); h.absentHistory(root, env);
      const worker = new Worker(path.join(root, SELF), { workerData: { root }, env });
      t.after(() => worker.terminate());
      await new Promise((resolve, reject) => {
        let completed = false, failure;
        worker.once('message', value => { completed = value?.completed === true; });
        worker.once('error', error => { failure = error; });
        worker.once('exit', code => failure ? reject(failure) : code || !completed
          ? reject(Error('transport flow exited without assertions: ' + code)) : resolve());
      });
      h.absentHistory(root, env);
    });
} else Promise.resolve().then(async () => {
  if (workerData.mode === 'refusals') { parentPort.postMessage({ refusals: await refusals() }); return; }
  if (workerData.mode === 'material') { parentPort.postMessage(material()); return; }
  const configureFixture = denyNetwork();
  identity(workerData.root);
  oldSetup().absentHistory(workerData.root, process.env);
  const refuseCandidateTransfer = () => {
    for (const args of [['fetch', 'origin'], ['clone', '--bare', '--quiet', workerData.root, path.join(process.env.HOME, 'forbidden.git')]])
      assert.throws(() => execFileSync('git', ['-C', workerData.root, ...args],
        { env: process.env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }), error => error.status === 89);
  };
  refuseCandidateTransfer();
  const h = require(path.join(workerData.root, HELPER));
  await h.publicRole('integrator', 'codex', { historical: true, historicalShared: true, full: true,
    configureFixture,
    inspect({ f, plugin, originals, prepared }) {
      refuseCandidateTransfer();
      assert.equal(prepared.launches.length, 3); assert.equal(originals.length, 2);
      const bytes = fs.readFileSync(path.join(plugin, 'scripts/role-artifact.cjs'));
      assert.equal(bytes.length, PINS['role-artifact.cjs'][4]); assert.equal(sha(bytes), PINS['role-artifact.cjs'][5]);
      assert.equal(blob(bytes), PINS['role-artifact.cjs'][6]);
      for (const original of originals) assert.deepEqual(JSON.parse(original.original_text), original.result);
      assert.equal(h.cold(f, 'integrator', path.dirname(h.SCRIPTS))?.authenticated, true);
      assert.deepEqual(h.cold(f, 'integrator', path.dirname(h.SCRIPTS), originals), originals);
    } });
  const file = path.join(workerData.root, FIXTURES, 'role-artifact.cjs.gz.b64');
  const bytes = Buffer.from(fs.readFileSync(file, 'ascii').slice(0, -1), 'base64'); bytes[30] ^= 1;
  const before = fs.readdirSync(process.env.HOME).filter(name => name.startsWith('producer-'));
  try {
    fs.writeFileSync(file, armor(bytes));
    await assert.rejects(h.publicRole('integrator', 'codex', { historical: true, historicalShared: true, full: true }),
      /exact compressed digest/);
    assert.deepEqual(fs.readdirSync(process.env.HOME).filter(name => name.startsWith('producer-')), before);
  } finally {
    bytes[30] ^= 1; fs.writeFileSync(file, armor(bytes));
  }
  oldSetup().absentHistory(workerData.root, process.env);
  parentPort.postMessage({ completed: true });
}).catch(error => setImmediate(() => { throw error; }));
