'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const SOURCE = 'plugins/delivery-pipeline/scripts/role-artifact.cjs';
const REVISION = '17849271574ff61b795f91bd8a33afca7fa42572';
const SHA = 'b616bc9ec959abcefbbcbe5b960acb38074b373d896e84caa723073d61764555';
const CAPTURE = path.join(h.ROOT, 'tests/fixtures/phase53/pre-material-hotpath.json');
const PHASES = ['package setup', 'fixture setup', 'producer', 'current consumer', 'original reader',
  'cold producer current', 'cold producer originals', 'cold shipped current', 'cold shipped originals',
  'staged package', 'cold staged current', 'cold staged originals', 'unchanged recovery', 'purpose assertions'];
function baseline(file = CAPTURE) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && stat.size <= 262144);
  const capture = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(Object.keys(capture).sort(), ['revision', 'sources']);
  assert.equal(capture.revision, REVISION); assert.equal(capture.sources.length, 1);
  const source = capture.sources[0];
  assert.deepEqual(Object.keys(source).sort(), ['bytes', 'compressed_bytes', 'compressed_sha256', 'data', 'encoding', 'path', 'sha256']);
  assert.equal(source.path, SOURCE); assert.equal(source.bytes, 728382); assert.equal(source.sha256, SHA);
  assert.equal(source.encoding, 'gzip-base64'); assert.ok(source.compressed_bytes <= 262144);
  const compressed = Buffer.from(source.data, 'base64');
  assert.equal(compressed.toString('base64'), source.data); assert.equal(compressed.length, source.compressed_bytes);
  assert.equal(h.hash(compressed), source.compressed_sha256);
  const bytes = require('node:zlib').gunzipSync(compressed, { maxOutputLength: 728382 });
  assert.equal(bytes.length, 728382); assert.equal(h.hash(bytes), SHA);
  return bytes.toString('utf8');
}
function load(source, file = path.join(h.ROOT, SOURCE), internals = false) {
  const loaded = new Module(file, module); loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(source + (internals ? '\nmodule.exports = { immutableVerificationFacts, immutableFileFact };' : ''), file);
  return loaded.exports;
}
function measured(run) {
  const parse = JSON.parse, stringify = JSON.stringify, hash = crypto.createHash;
  const work = { parses: 0, parse_bytes: 0, serializations: 0, serialization_bytes: 0, hashes: 0, hash_bytes: 0 };
  JSON.parse = function(value, ...rest) {
    work.parses++; work.parse_bytes += Buffer.byteLength(String(value)); return parse.call(this, value, ...rest);
  };
  JSON.stringify = function(...args) {
    const value = stringify.apply(this, args); work.serializations++;
    work.serialization_bytes += Buffer.byteLength(value || ''); return value;
  };
  crypto.createHash = function(...args) {
    const value = hash.apply(this, args), update = value.update;
    value.update = function(bytes, encoding) {
      work.hashes++; work.hash_bytes += typeof bytes === 'string' ? Buffer.byteLength(bytes, encoding) : bytes.byteLength;
      return update.call(this, bytes, encoding);
    };
    return value;
  };
  try { return { value: run(), work }; }
  finally { JSON.parse = parse; JSON.stringify = stringify; crypto.createHash = hash; }
}
function environment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  return { ...env, HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: home, TMP: home, TEMP: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' };
}
async function vertical(runtime, incomplete) {
  const defs = h.setup('phase53-z30-semantic-material-retention.test.cjs', '\nfunction runShard(',
    'public30, evidence, setPhase(run) { phase30 = run; }');
  defs.setPhase(async (name, run) => {
    parentPort.postMessage({ ready: name });
    const command = await new Promise(resolve => parentPort.once('message', resolve));
    assert.equal(command, name);
    const started = performance.now(); const value = await run();
    parentPort.postMessage({ phase: name, duration_ms: performance.now() - started, completed: name }); return value;
  });
  await defs.public30(runtime, { oversized: false, incomplete,
    async inspect(context) {
      const { f, api, plugin, prepared, originals, current } = context;
      const file = path.join(plugin, 'scripts/role-artifact.cjs');
      const previous = load(baseline(), file), input = h.inputFor(f);
      const before = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
      const authority = h.inventory(api.archiveAuthorityDirectory(f.worktree));
      const old = measured(() => previous.currentCodeReviewVerdict(input));
      const candidate = measured(() => api.currentCodeReviewVerdict(input));
      assert.deepEqual(candidate.value, old.value); assert.deepEqual(candidate.value, current);
      const repeated = measured(() => api.currentCodeReviewVerdict(input));
      assert.deepEqual(repeated.value, current); assert.deepEqual(repeated.work, candidate.work);
      for (const original of originals) {
        const request = { worktreePath: f.worktree, snapshot_sha256: prepared.launches[0].payload.snapshot_sha256,
          assignment_id: original.result.assignment_id };
        assert.deepEqual(previous.readSemanticOriginal(request), original);
        assert.deepEqual(api.readSemanticOriginal(request), original);
      }
      const reduction = candidate.work.parse_bytes < old.work.parse_bytes;
      parentPort.postMessage({ work: { runtime, incomplete, baseline: old.work, candidate: candidate.work,
        exact_output_parity: true, reduction } });
      assert.ok(reduction, 'public current consumer must decode strictly fewer complete bytes than current178');
      assert.ok(candidate.work.parses < old.work.parses);
      assert.ok(candidate.work.serialization_bytes < old.work.serialization_bytes);
      assert.equal(prepared.launches.length, 3);
      assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), before);
      assert.deepEqual(h.inventory(api.archiveAuthorityDirectory(f.worktree)), authority);
      for (const original of originals) {
        assert.ok(original.result.findings.some(row => row.severity === 'INFO'));
        if (incomplete) assert.ok(original.result.unread.length && original.result.required_context.length);
      }
      const { record } = defs.evidence(context);
      const internals = new Module(file, module); internals.filename = file; internals.paths = Module._nodeModulePaths(path.dirname(file));
      internals._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { semanticInputFiles };', file);
      const inputs = internals.exports.semanticInputFiles(record);
      const request = { worktreePath: f.worktree, snapshot_sha256: prepared.launches[0].payload.snapshot_sha256,
        assignment_id: originals[0].result.assignment_id };
      const tamper = [inputs.material[0].read_path, inputs.catalog.read_path, originals[0].native.native_pin.path];
      for (const target of tamper) {
        const raw = fs.readFileSync(target), stat = fs.statSync(target), changed = Buffer.from(raw);
        changed[0] ^= 1;
        try {
          fs.writeFileSync(target, changed); fs.utimesSync(target, stat.atime, stat.mtime);
          const outcomes = [previous, api].map(consumer => {
            try { return { value: consumer.readSemanticOriginal(request) }; }
            catch (error) { return { code: error.code }; }
          });
          assert.deepEqual(outcomes[0], outcomes[1]); assert.equal(typeof outcomes[1].code, 'string');
        } finally { fs.writeFileSync(target, raw); }
        assert.deepEqual(api.currentCodeReviewVerdict(input), current);
      }
      const manifest = path.join(f.worktree, originals[0].reference.artifact_ref);
      fs.renameSync(manifest, manifest + '.held');
      try {
        for (const consumer of [previous, api]) assert.throws(() => consumer.readSemanticOriginal(request));
      } finally { fs.renameSync(manifest + '.held', manifest); }
      const result = api.readSemanticOriginal({ worktreePath: f.worktree,
        snapshot_sha256: prepared.launches[0].payload.snapshot_sha256, assignment_id: originals[0].result.assignment_id });
      assert.throws(() => { result.result.findings[0].summary = 'foreign'; }, TypeError);
      assert.deepEqual(h.cold(f, 'code-review', context.staged), current);
    },
  });
}
if (!isMainThread) {
  os.homedir = () => fs.realpathSync(process.env.HOME);
  vertical(workerData.runtime, workerData.incomplete).then(() => { parentPort.postMessage({ finished: true }); parentPort.close(); })
    .catch(error => { setImmediate(() => { throw error; }); });
} else {
  test('T38 complete portable current178 baseline authenticates all bytes and refuses descriptor tampering', t => {
    assert.equal(h.hash(baseline()), SHA);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't38-baseline-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const change of [value => value.sources.push(value.sources[0]), value => value.sources[0].bytes--,
      value => { value.sources[0].path += '.foreign'; }, value => { value.sources[0].data = value.sources[0].data.slice(4); },
      value => { value.revision = 'a'.repeat(40); }, value => { value.extra = true; }]) {
      const capture = JSON.parse(fs.readFileSync(CAPTURE)); change(capture);
      const file = path.join(directory, 'bad.json'); fs.writeFileSync(file, JSON.stringify(capture));
      assert.throws(() => baseline(file));
    }
    const link = path.join(directory, 'link.json'); fs.symlinkSync(CAPTURE, link);
    assert.throws(() => baseline(link));
  });
  test('T38 private facts reauthenticate changed bytes, binding, inode and independent operations', t => {
    const { immutableVerificationFacts, immutableFileFact } = load(fs.readFileSync(path.join(h.ROOT, SOURCE), 'utf8'), undefined, true);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't38-facts-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'input'); fs.writeFileSync(file, 'aaaa');
    let calls = 0; const facts = immutableVerificationFacts(), binding = { session: 'original' };
    const read = (operation = facts) => immutableFileFact(operation, 'complete', file, fs.readFileSync(file), binding,
      () => ({ value: fs.readFileSync(file, 'utf8'), ordinal: ++calls }));
    const first = read(); assert.deepEqual(read(), first); assert.equal(calls, 1);
    assert.throws(() => { first.value = 'foreign'; }, TypeError);
    const stat = fs.statSync(file); fs.writeFileSync(file, 'bbbb'); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal(read().value, 'bbbb'); assert.equal(calls, 2);
    fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'bbbb'); assert.equal(read().ordinal, 3);
    binding.session = 'foreign'; assert.equal(read().ordinal, 4);
    assert.equal(read(immutableVerificationFacts()).ordinal, 5);
  });
  test('T38 actual detached checkout without local branches or optional origin HEAD retains full metadata verification',
    { timeout: 180000 }, t => {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't38-detached-')));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const checkout = path.join(directory, 'checkout'), env = environment(directory);
      const command = (program, args, cwd = directory) => {
        const result = cp.spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout.trim();
      };
      command('git', ['clone', '--quiet', '--no-local', '--single-branch', '--no-tags', h.ROOT, checkout]);
      command('git', ['checkout', '--quiet', '--detach'], checkout);
      const symbolic = cp.spawnSync('git', ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], { cwd: checkout, env });
      assert.equal(symbolic.error, undefined); assert.ok([0, 128].includes(symbolic.status));
      for (const ref of command('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], checkout).split('\n').filter(Boolean))
        command('git', ['update-ref', '-d', ref], checkout);
      assert.equal(command('git', ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin/HEAD'], checkout), '');
      const relative = 'tests/unit/phase53-z37-ci-checkout-readiness.test.cjs';
      fs.copyFileSync(path.join(h.ROOT, relative), path.join(checkout, relative));
      const output = command(process.execPath, ['--test', '--test-name-pattern=^T37-portable-baseline complete original metadata', relative], checkout);
      assert.match(output, /(?:ℹ |# )pass 1/); assert.match(output, /(?:ℹ |# )fail 0/);
      assert.equal((output.match(/\\"exact_parity\\":true/g) || []).length, 2);
    });
  for (const runtime of ['codex', 'claude']) for (const incomplete of [false, true])
    describe('T38 ' + runtime + ' complete public lifecycle ' + (incomplete ? 'INFO BLOCKER unread' : 'current and original parity'),
      { concurrency: false }, () => {
        let home, worker, failure, finished = false, waiting;
        const messages = new Map();
        const receive = key => {
          if (failure) return Promise.reject(failure);
          if (messages.has(key)) { const value = messages.get(key); messages.delete(key); return Promise.resolve(value); }
          return new Promise((resolve, reject) => { waiting = { key, resolve, reject }; });
        };
        const signal = (key, value) => {
          if (waiting?.key === key) { const held = waiting; waiting = null; held.resolve(value); }
          else messages.set(key, value);
        };
        after(async () => { await worker?.terminate(); if (home) fs.rmSync(home, { recursive: true, force: true }); });
        test('physical candidate setup', { timeout: 180000 }, async () => {
          home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-t38-')));
          const env = environment(home);
          const fixture = h.setup('phase53-z24-historical-producer-reference.test.cjs', '\nif (isMainThread) {', 'squashCandidate');
          const candidate = fixture.squashCandidate(home, env);
          worker = new Worker(path.join(candidate, 'tests/unit', path.basename(__filename)), { env, workerData: { runtime, incomplete } });
          const fail = error => { failure ||= error; if (waiting) { waiting.reject(failure); waiting = null; } };
          worker.on('message', message => {
            if (message.ready) signal('ready:' + message.ready, message.ready);
            if (message.completed) signal('completed:' + message.completed, message.completed);
            if (message.finished) finished = true;
            if (message.phase || message.work) process.stdout.write(JSON.stringify({ runtime, incomplete, ...message }) + '\n');
          });
          worker.once('error', fail);
          worker.once('exit', code => { if (code || !finished) fail(Error('incomplete public lifecycle exit ' + code)); signal('exit', code); });
          await receive('ready:' + PHASES[0]);
        });
        for (const [index, name] of PHASES.entries()) test(name, { timeout: 180000 }, async t => {
          if (failure) throw Error('prerequisite failed: ' + failure.message, { cause: failure });
          const stop = () => { failure = Error('public lifecycle phase deadline: ' + name); worker.terminate(); };
          t.signal.addEventListener('abort', stop, { once: true });
          try {
            if (index) await receive('ready:' + name);
            worker.postMessage(name); await receive('completed:' + name);
            if (index === PHASES.length - 1) { assert.equal(await receive('exit'), 0); assert.equal(finished, true); }
          } finally { t.signal.removeEventListener('abort', stop); }
        });
      });
}
