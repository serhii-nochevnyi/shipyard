'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = fs.realpathSync(path.join(ROOT, 'plugins/delivery-pipeline/scripts'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'z17b-package-'));
after(() => fs.rmSync(stage, { recursive: true, force: true }));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function inventory(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix + entry.name, file = path.join(directory, relative), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, relative);
    const row = { path: relative, mode: stat.mode & 0o777, directory: entry.isDirectory() };
    return entry.isDirectory() ? [row, ...inventory(directory, relative + '/')]
      : [{ ...row, digest: hash(fs.readFileSync(file)) }];
  });
}
const tracked = inventory(path.join(ROOT, 'plugins/shipyard'));
const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(stage, 'package'));
const STAGED = fs.realpathSync(path.join(candidate, 'host/plugins/delivery-pipeline/scripts'));

function setupOnly(scripts) {
  const file = path.join(__dirname, 'phase53-ci-observation.test.cjs');
  const source = fs.readFileSync(file, 'utf8'), end = source.indexOf('\ntest(');
  assert.ok(end > 0);
  let registrations = 0;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:test' ? { test: () => { registrations++; } } : originalRequire(name);
  const prefix = source.slice(0, end).replace(
    "const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');",
    `const scripts = ${JSON.stringify(scripts)};`);
  assert.ok(prefix.includes(`const scripts = ${JSON.stringify(scripts)};`));
  loaded._compile(prefix + '\nmodule.exports = { fixture, publish, pendingBoard, run, HEAD, TICKET };\n', file);
  assert.equal(registrations, 0);
  assert.equal(require.cache[file], undefined);
  return loaded.exports;
}

function controlledParent() {
  'use strict';
  const fs = require('node:fs'), path = require('node:path');
  const control = JSON.parse(fs.readFileSync(process.env.Z17B_CONTROL));
  if (path.resolve(process.argv[1] || '') !== control.entry) return;
  const child = require('node:child_process'), spawn = child.spawnSync;
  const locks = require(path.join(control.scripts, 'lock.cjs')), withLock = locks.withLock;
  const realNow = Date.now;
  let lastNow, logical, ticks = 0, publicationCount = 0, held;
  const record = row => fs.appendFileSync(control.trace, JSON.stringify(row) + '\n');
  Date.now = () => {
    if (logical === undefined) return (lastNow = realNow());
    if (++ticks > 4096) throw new Error('controlled parent clock exceeded bounded progress');
    logical += 5;
    return (lastNow = logical);
  };
  locks.withLock = (dir, name, fn, options = {}) => {
    const late = logical !== undefined;
    const row = { kind: 'lock', name, label: options.label, waitMs: options.waitMs, late, now: lastNow };
    try {
      const result = withLock(dir, name, fn, options);
      if (late && options.label === 'wait-events published read') row.published = result;
      if (late) record(row);
      return result;
    } catch (error) {
      if (late) record({ ...row, error: error.message });
      throw error;
    }
  };
  child.spawnSync = (file, args = [], options = {}) => {
    const env = { ...(options.env || process.env) };
    delete env.NODE_OPTIONS;
    delete env.Z17B_CONTROL;
    const deadline = lastNow + options.timeout + 25;
    const result = spawn(file, args, { ...options, env });
    const sleep = file === process.execPath && args[0] === '-e'
      && /^setTimeout\(\(\)=>\{\}, (\d+)\)$/.exec(args[1] || '');
    if (logical !== undefined && sleep && result.status === 0 && !result.error) logical += Number(sleep[1]);
    if (file === process.execPath && args[0] === path.join(control.scripts, 'state-sync.cjs')
        && result.status === 0 && !result.error && publicationCount++ === 0) {
      const stateFile = path.join(control.graphDir, 'delivery-state.json');
      const metaFile = path.join(control.graphDir, 'delivery-state-meta.json');
      const frontFile = path.join(control.graphDir, 'delivery-front.json');
      const read = file => JSON.parse(fs.readFileSync(file));
      const events = require(path.join(control.scripts, 'wait-events.cjs'));
      const state = read(stateFile), metadata = read(metaFile), front = read(frontFile);
      record({ kind: 'publication', status: result.status, file, args, timeout: options.timeout,
        pollId: options.env.SHIPYARD_CI_POLL_ID,
        deadline, state, metadata, front, childClockControlled: false });
      const mode = control.mode;
      const ci = state[control.ticket].ci_observation;
      if (mode === 'state-bytes') fs.appendFileSync(stateFile, ' ');
      else if (mode === 'projection') {
        metadata.observation_projection.tickets[control.ticket].ci_observation.rows = [];
        fs.writeFileSync(metaFile, JSON.stringify(metadata));
      } else if (mode === 'hash') {
        metadata.binding.state_digest = '0'.repeat(64);
        fs.writeFileSync(metaFile, JSON.stringify(metadata));
      } else if (mode === 'overlay') {
        fs.writeFileSync(frontFile, JSON.stringify({ ...front, controlled_overlay: true }));
      } else if (['repository', 'head', 'poll', 'incomplete', 'unavailable', 'malformed'].includes(mode)) {
        if (mode === 'repository') ci.repository = 'foreign/repository';
        if (mode === 'head') ci.checked_head = 'c'.repeat(40);
        if (mode === 'poll') ci.poll_id = 'controlled-stale-poll';
        if (mode === 'incomplete') ci.complete = false;
        if (mode === 'unavailable') ci.availability = 'unavailable';
        if (mode === 'malformed') ci.schema_version = -1;
        metadata.observation_projection.tickets[control.ticket].ci_observation = ci;
        const bytes = JSON.stringify(state);
        metadata.binding.state_digest = events.digest(bytes);
        metadata.binding.observation_digest = events.digest(metadata.observation_projection);
        fs.writeFileSync(stateFile, bytes);
        fs.writeFileSync(metaFile, JSON.stringify(metadata));
      }
      if (mode === 'contention') {
        held = locks.acquire(locks.lockDirFor(process.cwd()), 'state', { waitMs: 1, label: 'controlled real state holder' });
        if (!held) throw new Error('controlled holder did not acquire state lock');
      }
      logical = deadline - (mode === 'exhausted' ? -25 : control.remaining);
      record({ kind: 'controlled-parent-clock', now: logical, deadline, remaining: deadline - logical });
    }
    return result;
  };
  process.on('exit', () => {
    if (held) held.release();
    record({ kind: 'completion', ticks, publications: publicationCount });
  });
}

function invokeWait(f, scripts, mode = 'healthy', remaining = 250) {
  const trace = path.join(f.root, 'controlled-parent.jsonl');
  const preload = path.join(f.root, 'controlled-parent.cjs');
  const control = path.join(f.root, 'controlled-parent.json');
  fs.writeFileSync(preload, `(${controlledParent.toString()})();\n`);
  fs.writeFileSync(control, JSON.stringify({ entry: path.join(scripts, 'ci-wait.cjs'), scripts,
    graphDir: f.graphDir, ticket: 'T-53-08', mode, remaining, trace }));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(SHIPYARD_|GSD_|CLAUDE_|CODEX_|GH_|GITHUB_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
  Object.assign(env, { PATH: path.join(f.root, 'bin') + path.delimiter + process.env.PATH,
    CI_FIXTURE: f.input, CI_CALLS: path.join(f.root, 'calls.jsonl'), CI_PULL_COUNT: path.join(f.root, 'pull-count'),
    Z17B_CONTROL: control, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
  const before = f.calls().length;
  const result = spawnSync(process.execPath, [path.join(scripts, 'ci-wait.cjs'), '--graph', f.graphDir,
    '--json', '--timeout', '10', '--interval', '1'], {
    cwd: f.root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 8 * 1024 * 1024);
  const records = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  const publication = records.find(r => r.kind === 'publication');
  const clock = records.find(r => r.kind === 'controlled-parent-clock');
  const completed = records.find(r => r.kind === 'completion');
  assert.ok(publication, JSON.stringify(records));
  assert.equal(publication.status, 0);
  assert.equal(publication.file, process.execPath);
  assert.equal(publication.args[0], path.join(scripts, 'state-sync.cjs'));
  assert.ok(publication.timeout > 0 && publication.timeout <= 60000);
  assert.equal(publication.childClockControlled, false);
  assert.equal(completed.publications, 1);
  assert.ok(completed.ticks > 0 && completed.ticks <= 4096);
  assert.equal(clock.deadline, publication.deadline);
  assert.equal(clock.remaining, mode === 'exhausted' ? -25 : remaining);
  return { output: JSON.parse(result.stdout), records, publication,
    calls: f.calls().slice(before), read: records.find(r => r.kind === 'lock' && r.label === 'wait-events published read') };
}
const directCalls = result => result.calls.filter(a => a[0] === 'pr' && a[1] === 'checks');
const rerunCalls = result => result.calls.filter(a => a[0] === 'run' && a[1] === 'rerun');

for (const [label, scripts] of [['source', SCRIPTS], ['genuinely staged', STAGED]]) {
  const setup = setupOnly(scripts);
  const events = require(path.join(scripts, 'wait-events.cjs'));
  const checks = require(path.join(scripts, 'check-state.cjs'));
  test(`${label}: controlled late parent reuses real complete publication through the normal state lock`, { timeout: 180000 }, t => {
    const f = setup.fixture(t);
    setup.pendingBoard(f);
    const previous = events.readPublished({ graphDir: f.graphDir });
    const result = invokeWait(f, scripts);
    assert.equal(directCalls(result).length, 0);
    assert.equal(result.output.settled, setup.TICKET);
    assert.equal(result.read.published.ok, true);
    assert.ok(result.read.waitMs > 0 && result.read.waitMs < 500);
    const p = events.readPublished({ graphDir: f.graphDir });
    assert.equal(p.ok, true, p.reason);
    assert.equal(p.overlay_changed, false);
    assert.deepEqual(result.read.published, p);
    assert.ok(p.metadata.generation > previous.metadata.generation);
    assert.deepEqual(p.metadata, result.publication.metadata);
    const ci = p.ci_observations[setup.TICKET];
    assert.equal(ci.schema_version, 2);
    assert.equal(ci.complete, true);
    assert.equal(ci.poll_id, result.publication.pollId);
    assert.equal(ci.checked_head, setup.HEAD);
    assert.equal(ci.repository, 'acme/demo');
    assert.equal(ci.rows[0].name, 'build');
    assert.equal(ci.rows[0].run_id, '123');
    assert.equal(ci.rows[0].run_attempt, 1);
    assert.deepEqual(result.output.watched[0].checks.rows, ci.rows);
    assert.equal(checks.compatibleCiObservation(ci, { head: setup.HEAD, pr: 108, repo: 'acme/demo', pollId: ci.poll_id }), true);
    assert.equal(p.metadata.binding.state_digest, events.digest(fs.readFileSync(path.join(f.graphDir, 'delivery-state.json'), 'utf8')));
    assert.equal(p.metadata.binding.front_digest, events.digest(fs.readFileSync(path.join(f.graphDir, 'delivery-front.json'), 'utf8')));
    assert.equal(p.metadata.binding.observation_digest, events.digest(p.observation));
    assert.equal(p.metadata.binding.observation_generation, p.metadata.generation);
    assert.equal(result.output.watched[0].wait_event, null);
    assert.equal(result.records.some(r => r.kind === 'lock' && r.late && ['wait-events', 'orchestration-overhead'].includes(r.name)), false);
  });

  for (const superseded of [false, true])
    test(`${label}: late ${superseded ? 'superseded' : 'latest'} cancellation preserves run identity and write reservation`, { timeout: 180000 }, t => {
      const f = setup.fixture(t);
      setup.pendingBoard(f);
      const rows = [setup.run('build', 'cancelled'), ...(superseded
        ? [setup.run('build', 'success', { id: 2, started_at: '2026-10-02T00:00:00Z' })] : [])];
      const data = { checkPages: [{ total_count: rows.length, check_runs: rows }] };
      f.update(data);
      const result = invokeWait(f, scripts);
      assert.equal(directCalls(result).length, 0);
      assert.equal(rerunCalls(result).length, 0);
      const c = result.output.watched[0].checks;
      assert.equal(c.cancelled, superseded ? 0 : 1);
      assert.equal(c.pending, superseded ? 0 : 1);
      assert.equal(checks.isGreen(c), superseded);
      assert.deepEqual(c.rows, result.publication.state[setup.TICKET].ci_observation.rows);
      assert.equal(result.read.published.ok, true);
      if (!superseded) {
        assert.equal(c.cancelled_runs[0].run_id, '123');
        assert.equal(c.rerun.run_id, '123');
        assert.equal(c.rerun.rerun, false);
        assert.match(c.rerun.error, /deadline reached before rerun claim/);
        assert.equal(result.output.timed_out, true);
        const normal = setup.fixture(t);
        setup.pendingBoard(normal);
        normal.update(data);
        const before = normal.calls().length;
        const output = JSON.parse(normal.invoke('ci-wait.cjs', ['--graph', normal.graphDir, '--json', '--timeout', '3', '--interval', '1']));
        assert.equal(output.watched[0].checks.cancelled_runs[0].run_id, '123');
        const reruns = normal.calls().slice(before).filter(a => a[0] === 'run' && a[1] === 'rerun');
        assert.equal(reruns.length, 1);
        assert.equal(reruns[0][2], '123');
      }
    });

  for (const mode of ['contention', 'exhausted'])
    test(`${label}: ${mode} refuses late reuse with bounded logical clock and real state locking`, { timeout: 180000 }, t => {
      const f = setup.fixture(t);
      setup.pendingBoard(f);
      const result = invokeWait(f, scripts, mode);
      assert.equal(result.output.settled, null);
      assert.equal(result.output.timed_out, true);
      assert.equal(result.output.watched[0].checks, null);
      assert.equal(result.output.outage, true);
      if (mode === 'contention') {
        assert.match(result.read.error, /could not acquire the "state" lock/);
        assert.ok(result.read.waitMs > 0 && result.read.waitMs < 500);
        assert.equal(fs.existsSync(path.join(f.graphDir, '.locks/state.lock')), false);
      } else assert.equal(result.read, undefined);
      assert.equal(directCalls(result).length, 0);
    });

  for (const mode of ['state-bytes', 'projection', 'hash', 'overlay', 'repository', 'head', 'poll', 'incomplete', 'unavailable', 'malformed'])
    test(`${label}: controlled ${mode} after real publication refuses reuse and retains fresh direct fallback`, { timeout: 180000 }, t => {
      const f = setup.fixture(t);
      setup.pendingBoard(f);
      f.update({ direct: [{ name: 'controlled-independent-failure', state: 'FAILURE', bucket: 'fail', link: '', startedAt: '', workflow: '' }] });
      const result = invokeWait(f, scripts, mode, 2000);
      assert.equal(directCalls(result).length, 1);
      const c = result.output.watched[0].checks;
      assert.equal(c.failing, 1);
      assert.equal(checks.isGreen(c), false);
      assert.equal(c.rows[0].name, 'controlled-independent-failure');
      assert.equal(result.output.settled, setup.TICKET);
      if (mode === 'overlay') {
        assert.equal(result.read.published.ok, true);
        assert.equal(result.read.published.overlay_changed, true);
      } else if (['poll', 'incomplete'].includes(mode)) {
        assert.equal(result.read.published.ok, true);
      } else assert.equal(result.read.published.ok, false);
    });
}

test('isolated builder preserves tracked package and complete final source/staged inventory', () => {
  assert.deepEqual(inventory(path.join(ROOT, 'plugins/shipyard')), tracked);
  assert.deepEqual(inventory(candidate), tracked);
  for (const file of ['check-state.cjs', 'ci-wait.cjs', 'codex-runtime-host.cjs']) {
    assert.deepEqual(fs.readFileSync(path.join(STAGED, file)), fs.readFileSync(path.join(SCRIPTS, file)));
    assert.equal(fs.statSync(path.join(STAGED, file)).mode & 0o777, fs.statSync(path.join(SCRIPTS, file)).mode & 0o777);
  }
});

test('z17b owns singleton38 after exact37 prefix and preserves a future separate row through the actual selector', t => {
  const selector = require('./shard-files.cjs'), manifest = selector.readManifest();
  const current = selector.appendShard(manifest, selector.unitTasks(selector.unitFiles()));
  assert.equal(hash(JSON.stringify(current.shards.slice(0, 37))), '5bf00ad885a7e3e264b1dcdb8ad32fedb9d7d7d4ccd23928a1d7b4c184bba84c');
  assert.deepEqual(current.shards[37], ['phase53-z17b-ci-wait-published-read.test.cjs']);
  const first38 = [...require('../fixtures/phase53/github-job-attempts.json').parent.shards,
    ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs']];
  assert.deepEqual(current.shards.slice(0, 38), first38);
  const first39 = [...first38, ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  assert.deepEqual(current.shards.slice(0, 39), first39);
  assert.ok(current.shards.length >= 39);
  assert.equal(current.shards.slice(0, 39).length + 3, 42);
  assert.deepEqual(current.shards[38], ['phase53-z17c-native-wait-lifecycle.test.cjs']);
  for (let i = 0; i < current.shards.length; i++)
    assert.deepEqual(selector.selectTaskShard(`${i + 1}/${current.shards.length}`), current.shards[i]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z17b-future-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of selector.unitFiles()) fs.writeFileSync(path.join(dir, file), '');
  const future = 'phase53-z99-future.test.cjs';
  fs.writeFileSync(path.join(dir, future), '');
  const next = selector.appendShard(current, selector.unitTasks(selector.unitFiles(dir)));
  assert.deepEqual(next.shards.slice(0, current.shards.length), current.shards);
  assert.deepEqual(next.shards.at(-1), [future]);
  assert.equal(next.shards.length, current.shards.length + 1);
  assert.equal(next.shards.length + 3, current.shards.length + 4);
  for (let i = 0; i < next.shards.length; i++)
    assert.deepEqual(selector.selectTaskShard(`${i + 1}/${next.shards.length}`, dir, current), next.shards[i]);
});
