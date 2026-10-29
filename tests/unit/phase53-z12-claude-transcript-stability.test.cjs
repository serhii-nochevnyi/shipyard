'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SESSION = '11111111-1111-4111-8111-111111111111';
const MODEL = 'claude-opus-5-5';
const EFFORT = 'low';
const ROLE = 'gsd-plan-checker';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const cases = new Map();

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stability-files-')));
  const projects = path.join(root, 'native/projects');
  const nativeFile = path.join(projects, 'project', SESSION + '.jsonl');
  const captured = fs.readFileSync(path.join(ROOT, 'tests/fixtures/captured/claude-stream-executor.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse).filter(row => !row.shipyard_fixture);
  const init = structuredClone(captured.find(row => row.type === 'system' && row.subtype === 'init'));
  Object.assign(init, { session_id: SESSION, cwd: root, model: MODEL });
  const assistant = structuredClone(captured.find(row => row.type === 'assistant'));
  Object.assign(assistant, { session_id: SESSION, sessionId: SESSION, effort: EFFORT });
  assistant.message.model = MODEL;
  const final = structuredClone(captured.find(row => row.type === 'result'));
  Object.assign(final, { session_id: SESSION, subtype: 'success', is_error: false });
  assistant.agentSetting = ROLE;
  const rows = [{ type: 'agent-setting', sessionId: SESSION, agentSetting: ROLE }, assistant];
  const stream = serialize([init, assistant, final]);
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.writeFileSync(nativeFile, serialize(rows));
  const agentRoot = path.join(root, 'agents');
  fs.mkdirSync(agentRoot);
  fs.writeFileSync(path.join(agentRoot, ROLE + '.md'),
    `---\nname: ${ROLE}\ndescription: Check the scoped plan\ntools: Bash, Read, Glob, Grep\n---\nRead the scoped plan.\n`);
  return { root, projects, nativeFile, agentRoot, rows, stream, output: final.structured_output,
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

function clock(deadline, poll, wake, onWake = () => {}) {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleeps,
    sleep(ms) {
      assert.ok(time < deadline, 'no sleep starts at or beyond the original deadline');
      assert.equal(ms, Math.min(poll, deadline - time), 'caller poll and deadline remain unchanged');
      sleeps.push(ms);
      assert.ok(sleeps.length <= deadline / poll + 1, 'polling is bounded');
      time = wake ? wake(sleeps.length, time, ms) : time + ms;
      onWake(time, sleeps.length);
      return Promise.resolve();
    },
  };
}

function launch(f, timer, useHost = false, extra = {}) {
  const runtime = require(f.runtimeFile || '../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
  const options = {
    scope: { run_id: 'stability', ticket: 'T-53-12', phase: 53, worktree: f.root },
    sessionTranscriptRoot: f.projects,
    gsdAgentRoot: f.agentRoot,
    transcriptDir: null,
    uuid: () => SESSION,
    now: timer.now,
    sleep: timer.sleep,
    spawn(_executable, args) {
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
      const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
      capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: SESSION,
        transcript_path: f.nativeFile, cwd: f.root, ...(f.typed ? { agent_type: ROLE } : {}) }, {
        evidenceFile: hookArgs[hookArgs.indexOf('--evidence-file') + 1], expectedSession: SESSION,
        ...(f.typed ? { expectedAgent: ROLE } : {}) });
      const child = new EventEmitter();
      Object.assign(child, { pid: 5312, stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { write() {}, end() {} } });
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(f.stream));
        child.emit('close', 0, null);
      });
      return child;
    },
    ...extra,
  };
  const selection = { model: MODEL, effort: EFFORT, ...(f.typed ? { gsd_role: ROLE } : {}) };
  if (!useHost) return runtime.createClaudeCliLauncher(options)('Read the scoped fixture', selection);
  const host = runtime.createClaudeRuntimeHost({ ...options, recorder: { record() {} },
    probe: { status: 'available', executable: 'claude-fixture', runtime_version: '2.1.283', capabilities: {} } });
  const resultPromise = f.typed ? host.typedGsdCallback('Read the scoped fixture', selection, ROLE)
    : host.agent('Read the scoped fixture', selection);
  return resultPromise.then(result => {
    assert.equal(host.applicationEvidence({ result }), result.applicationEvidence);
    assert.throws(() => host.applicationEvidence({ result: { ...result } }), { code: 'RUNTIME_EVIDENCE_MISSING' });
    return result;
  });
}

function assertCompleted(f, result, file = f.nativeFile) {
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, f.output);
  const evidence = result.applicationEvidence;
  assert.equal(evidence.session_id, SESSION);
  assert.equal(evidence.observed_model, MODEL);
  assert.equal(evidence.observed_effort, EFFORT);
  assert.equal(evidence.selection_evidence.source, 'claude-session-assistant-transcript');
  assert.deepEqual(evidence.selection_evidence.transcript, {
    path: 'project/' + SESSION + '.jsonl', bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)),
  });
}

function savedLaunch(f) {
  const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
  const transcript = path.join(f.root, 'saved/stream.jsonl');
  const evidence = path.join(f.root, 'saved/session-start.json');
  const native = path.join(path.dirname(transcript), 'projects/project', SESSION + '.jsonl');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.copyFileSync(f.nativeFile, native);
  fs.writeFileSync(transcript, f.stream);
  capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: SESSION,
    transcript_path: f.nativeFile, cwd: f.root, agent_type: ROLE }, {
    evidenceFile: evidence, expectedSession: SESSION, expectedAgent: ROLE });
  return { native, evidence, input: { session_id: SESSION, start_evidence_file: evidence,
    transcript_path: transcript, saved_native_transcript: native, original_projects_root: f.projects,
    model: MODEL, effort: EFFORT, gsd_role: ROLE, worktree: f.root } };
}

async function verifySaved(saved, timer) {
  const { verifyCompletedClaudeLaunch } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const originalNow = Date.now;
  const originalTimeout = global.setTimeout;
  Date.now = timer.now;
  global.setTimeout = (callback, ms, ...args) => {
    timer.sleep(ms).then(() => callback(...args));
    return 1;
  };
  try {
    const verified = await verifyCompletedClaudeLaunch(saved.input);
    return { ...verified.result, applicationEvidence: verified.applicationEvidence };
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalTimeout;
    assert.equal(Date.now, originalNow);
    assert.equal(global.setTimeout, originalTimeout);
  }
}

cases.set('launch accepts original complete evidence at a 6000 ms wake', async () => {
  const f = fixture();
  try {
    const timer = clock(5000, 100, () => 6000);
    assertCompleted(f, await launch(f, timer));
    assert.deepEqual(timer.sleeps, [100]);
    assert.equal(timer.now(), 6000);
  } finally { f.close(); }
});

cases.set('runtime host accepts the same session and output at regular 100 ms cadence', async () => {
  const f = fixture();
  try {
    const timer = clock(5000, 100);
    assertCompleted(f, await launch(f, timer, true));
    assert.deepEqual(timer.sleeps, [100, 100]);
    assert.equal(timer.now(), 200);
  } finally { f.close(); }
});

cases.set('launch waits for a new transcript through a physical parent alias', async () => {
  const f = fixture();
  try {
    f.typed = true;
    const complete = fs.readFileSync(f.nativeFile);
    fs.unlinkSync(f.nativeFile);
    const alias = path.join(f.root, 'native-alias');
    fs.symlinkSync(path.join(f.root, 'native'), alias, 'dir');
    f.projects = path.join(alias, 'projects');
    f.nativeFile = path.join(f.projects, 'project', SESSION + '.jsonl');
    const timer = clock(5000, 100, undefined, (_time, count) => {
      if (count === 1) fs.writeFileSync(f.nativeFile, complete);
    });
    const result = await launch(f, timer);
    assertCompleted(f, result);
    assert.notEqual(f.nativeFile, fs.realpathSync(f.nativeFile));
    assert.deepEqual(timer.sleeps, [100, 100, 100]);
    assert.equal(result.applicationEvidence.gsd_agent_evidence.session_start_agent_type, ROLE);
  } finally { f.close(); }
});

for (const mode of ['launch', 'saved launch']) {
  const savedMode = mode === 'saved launch';
  const deadline = savedMode ? 200 : 5000;
  const poll = savedMode ? 1 : 100;
  const delayed = savedMode ? 250 : 6000;
  function prepare() {
    const f = fixture();
    f.typed = true;
    const saved = savedMode ? savedLaunch(f) : null;
    const file = savedMode ? saved.native : f.nativeFile;
    return { f, saved, file, run: timer => savedMode ? verifySaved(saved, timer) : launch(f, timer) };
  }

  for (const [label, wake, expectedSleeps] of [
    ['regular cadence', undefined, [poll, poll]],
    ['one elapsed stable interval', () => 2 * poll, [poll]],
    ['exact original deadline', () => deadline, [poll]],
    ['overslept original deadline', () => delayed, [poll]],
  ]) cases.set(`${mode} accepts typed original evidence at ${label}`, async () => {
    const { f, file, run } = prepare();
    try {
      const timer = clock(deadline, poll, wake);
      const result = await run(timer);
      assertCompleted(f, result, file);
      assert.deepEqual(timer.sleeps, expectedSleeps);
      assert.equal(result.applicationEvidence.gsd_agent_evidence.transcript_agent_setting, ROLE);
      assert.equal(result.applicationEvidence.gsd_agent_evidence.session_start_agent_type, ROLE);
    } finally { f.close(); }
  });

  cases.set(`${mode} does not turn two early wakeups into elapsed stability`, async () => {
    const { f, file, run } = prepare();
    try {
      const timer = clock(deadline, poll, count => count < 3 ? 0 : 2 * poll);
      assertCompleted(f, await run(timer), file);
      assert.deepEqual(timer.sleeps, [poll, poll, poll]);
    } finally { f.close(); }
  });

  cases.set(`${mode} uses one remaining budget when the clock reaches the deadline`, async () => {
    const { f, file, run } = prepare();
    const originalRead = fs.readFileSync;
    let observed = false, time = 0;
    const sleeps = [];
    const timer = {
      now() {
        if (observed) time = time < deadline - 1 ? deadline - 1 : deadline;
        return time;
      },
      sleep(ms) {
        assert.ok(time < deadline, 'no sleep starts at or beyond the original deadline');
        assert.equal(ms, deadline - time, 'the remaining millisecond is the entire wait budget');
        sleeps.push(ms);
        time = deadline;
        return Promise.resolve();
      },
    };
    try {
      fs.readFileSync = function(target, ...args) {
        const bytes = originalRead.call(fs, target, ...args);
        if (target === file) observed = true;
        return bytes;
      };
      assertCompleted(f, await run(timer), file);
      assert.deepEqual(sleeps, [1]);
      assert.equal(time, deadline);
    } finally { fs.readFileSync = originalRead; f.close(); }
  });

  for (const terminal of [deadline, delayed]) {
    for (const initial of ['complete', 'absent', 'partial'])
      cases.set(`${mode} refuses ${initial} evidence changed at ${terminal} ms`, async () => {
        const { f, file, run } = prepare();
        try {
          const complete = fs.readFileSync(file);
          if (initial === 'absent') fs.unlinkSync(file);
          if (initial === 'partial') fs.writeFileSync(file, complete.subarray(0, complete.length - 1));
          const timer = clock(deadline, poll, () => terminal, () => {
            fs.writeFileSync(file, initial === 'complete' ? Buffer.concat([complete, Buffer.from('\n')]) : complete);
          });
          await assert.rejects(run(timer), { code: 'RUNTIME_EVIDENCE_MISSING' });
          assert.deepEqual(timer.sleeps, [poll]);
          assert.equal(timer.now(), terminal);
        } finally { f.close(); }
      });
  }

  for (const failure of ['absent', 'partial', 'missing-newline', 'invalid-json', 'foreign-session',
    'foreign-model', 'foreign-effort', 'foreign-role', 'missing-model', 'missing-effort', 'missing-role', 'oversized'])
    cases.set(`${mode} refuses stable ${failure} evidence after a delayed wake`, async () => {
      const { f, file, run } = prepare();
      try {
        let expected = 'RUNTIME_EVIDENCE_MISSING';
        let details;
        const rows = structuredClone(f.rows);
        if (failure === 'absent') fs.unlinkSync(file);
        else if (failure === 'partial') fs.writeFileSync(file, '{"type":"assistant"');
        else if (failure === 'missing-newline') fs.writeFileSync(file, serialize(rows).trimEnd());
        else if (failure === 'invalid-json') {
          fs.writeFileSync(file, '{invalid}\n');
          expected = 'RUNTIME_EVIDENCE_INVALID';
        } else if (failure === 'oversized') {
          fs.truncateSync(file, 50 * 1024 * 1024 + 1);
          expected = 'RUNTIME_EVIDENCE_INVALID';
        } else {
          if (failure === 'foreign-session') for (const row of rows) row.sessionId = '22222222-2222-4222-8222-222222222222';
          if (failure === 'foreign-model') {
            rows[1].message.model = 'claude-opus-5';
            details = { expected: MODEL, observed: 'claude-opus-5' };
          }
          if (failure === 'foreign-effort') {
            rows[1].effort = 'high';
            details = { expected: EFFORT, observed: 'high' };
          }
          if (failure === 'foreign-role') {
            rows[0].agentSetting = 'gsd-planner';
            details = { expected: ROLE, observed: 'gsd-planner' };
          }
          if (details) expected = 'RUNTIME_EVIDENCE_MISMATCH';
          if (failure === 'missing-model') delete rows[1].message.model;
          if (failure === 'missing-effort') delete rows[1].effort;
          if (failure === 'missing-role') rows.shift();
          fs.writeFileSync(file, serialize(rows));
        }
        const timer = clock(deadline, poll, () => delayed);
        await assert.rejects(run(timer), error => {
          assert.equal(error.code, expected);
          if (details) assert.deepEqual(error.details, details);
          return true;
        });
        assert.deepEqual(timer.sleeps, failure === 'oversized' ? [] : [poll]);
      } finally { f.close(); }
    });

  for (const mutation of ['disappears', 'file-replaced', 'file-symlink', 'project-symlink', 'same-stat-different-bytes'])
    cases.set(`${mode} refuses original evidence that ${mutation} at the terminal wake`, async () => {
      const { f, file, run } = prepare();
      const originalStat = fs.statSync;
      try {
        const initialStat = fs.statSync(file);
        const timer = clock(deadline, poll, () => delayed, () => {
          if (mutation === 'disappears') fs.unlinkSync(file);
          if (mutation === 'file-replaced') {
            const replacement = file + '.replacement';
            fs.copyFileSync(file, replacement);
            fs.utimesSync(replacement, initialStat.atime, initialStat.mtime);
            fs.renameSync(replacement, file);
          }
          if (mutation === 'file-symlink') {
            fs.renameSync(file, file + '.original');
            fs.symlinkSync(file + '.original', file);
          }
          if (mutation === 'project-symlink') {
            const project = path.dirname(file);
            fs.renameSync(project, project + '.original');
            fs.symlinkSync(project + '.original', project);
          }
          if (mutation === 'same-stat-different-bytes') {
            const raw = fs.readFileSync(file, 'utf8');
            assert.ok(raw.includes('OK'));
            fs.writeFileSync(file, raw.replace('OK', 'NO'));
            fs.statSync = function(target, ...args) {
              return target === file ? initialStat : originalStat.call(fs, target, ...args);
            };
          }
        });
        await assert.rejects(run(timer), { code: mutation.endsWith('symlink')
          ? 'RUNTIME_EVIDENCE_INVALID' : 'RUNTIME_EVIDENCE_MISSING' });
        assert.deepEqual(timer.sleeps, [poll]);
      } finally { fs.statSync = originalStat; f.close(); }
    });

  for (const race of ['size', 'mtime', 'inode', 'symlink', 'byte-length', 'read-enoent', 'read-denied', 'stat-denied'])
    cases.set(`${mode} refuses a terminal read/stat race: ${race}`, async () => {
      const { f, file, run } = prepare();
      const originalRead = fs.readFileSync, originalStat = fs.statSync;
      try {
        const timer = clock(deadline, poll, () => delayed);
        fs.readFileSync = function(target, ...args) {
          if (target !== file || timer.now() < deadline) return originalRead.call(fs, target, ...args);
          if (race === 'read-enoent' || race === 'read-denied')
            throw Object.assign(new Error('injected physical read refusal'), { code: race === 'read-enoent' ? 'ENOENT' : 'EACCES' });
          const bytes = originalRead.call(fs, target, ...args);
          if (race === 'size') fs.appendFileSync(file, '\n');
          if (race === 'mtime') {
            const stat = originalStat.call(fs, file);
            fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 1000));
          }
          if (race === 'inode') {
            fs.writeFileSync(file + '.replacement', bytes);
            fs.renameSync(file + '.replacement', file);
          }
          if (race === 'symlink') {
            fs.renameSync(file, file + '.original');
            fs.symlinkSync(file + '.original', file);
          }
          return race === 'byte-length' ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
        };
        if (race === 'stat-denied') fs.statSync = function(target, ...args) {
          if (target === file && timer.now() >= deadline)
            throw Object.assign(new Error('injected physical stat refusal'), { code: 'EACCES' });
          return originalStat.call(fs, target, ...args);
        };
        await assert.rejects(run(timer), { code: race.endsWith('denied') || race === 'symlink'
          ? 'RUNTIME_EVIDENCE_INVALID' : 'RUNTIME_EVIDENCE_MISSING' });
        assert.deepEqual(timer.sleeps, [poll]);
      } finally { fs.readFileSync = originalRead; fs.statSync = originalStat; f.close(); }
    });

  cases.set(`${mode} resets elapsed stability after a missing observation`, async () => {
    const { f, file, run } = prepare();
    const originalStat = fs.statSync;
    try {
      const timer = clock(deadline, poll, count => count === 1 ? poll : delayed);
      fs.statSync = function(target, ...args) {
        if (target === file && timer.now() === poll)
          throw Object.assign(new Error('transcript temporarily absent'), { code: 'ENOENT' });
        return originalStat.call(fs, target, ...args);
      };
      await assert.rejects(run(timer), { code: 'RUNTIME_EVIDENCE_MISSING' });
      assert.deepEqual(timer.sleeps, [poll, poll]);
    } finally { fs.statSync = originalStat; f.close(); }
  });
}

cases.set('launcher retains caller polling choices and never sleeps at a zero deadline', async () => {
  const f = fixture();
  try {
    const custom = clock(5000, 17);
    assertCompleted(f, await launch(f, custom, false, { transcriptPollMs: 17 }));
    assert.deepEqual(custom.sleeps, [17, 17]);
    const zero = clock(0, 100);
    await assert.rejects(launch(f, zero, false, { transcriptTimeoutMs: 0 }), { code: 'RUNTIME_EVIDENCE_MISSING' });
    assert.deepEqual(zero.sleeps, []);
  } finally { f.close(); }
});

cases.set('saved launch retains final-stream and exact-reference refusals after native stability', async () => {
  const f = fixture();
  try {
    const saved = savedLaunch(f);
    for (const failure of ['stream-newline', 'stream-final', 'saved-reference', 'start-session', 'start-role']) {
      const stream = fs.readFileSync(saved.input.transcript_path);
      const start = fs.readFileSync(saved.evidence);
      const originalReference = saved.input.saved_native_transcript;
      try {
        if (failure === 'stream-newline') fs.writeFileSync(saved.input.transcript_path, stream.subarray(0, stream.length - 1));
        if (failure === 'stream-final') fs.writeFileSync(saved.input.transcript_path,
          serialize(stream.toString('utf8').trim().split('\n').map(JSON.parse).slice(0, -1)));
        if (failure === 'saved-reference') saved.input.saved_native_transcript += '.foreign';
        if (failure.startsWith('start-')) {
          const value = JSON.parse(start);
          if (failure === 'start-session') value.session_id = '22222222-2222-4222-8222-222222222222';
          else value.agent_type = 'gsd-planner';
          fs.writeFileSync(saved.evidence, JSON.stringify(value));
        }
        const timer = clock(200, 1, () => 250);
        await assert.rejects(verifySaved(saved, timer), {
          code: failure.startsWith('stream-') ? 'RUNTIME_EVIDENCE_MISSING' : 'RUNTIME_EVIDENCE_MISMATCH',
        });
        assert.deepEqual(timer.sleeps, failure.startsWith('stream-') ? [1] : []);
      } finally {
        fs.writeFileSync(saved.input.transcript_path, stream);
        fs.writeFileSync(saved.evidence, start);
        saved.input.saved_native_transcript = originalReference;
      }
    }
  } finally { f.close(); }
});

cases.set('a genuine isolated builder reproduces the complete package and a cold runtime consumer', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stability-build-')));
  const f = fixture();
  try {
    const built = path.join(directory, 'package');
    const builder = spawnSync(process.execPath, [path.join(ROOT, 'scripts/package-shipyard-codex.cjs'), built], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(builder.error, undefined, String(builder.error));
    assert.equal(builder.status, 0, builder.stderr || builder.stdout);
    assert.ok(Buffer.byteLength(builder.stdout) + Buffer.byteLength(builder.stderr) <= 8 * 1024 * 1024);
    function inventory(root, relative = '') {
      return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
          const file = path.join(relative, entry.name);
          const stat = fs.lstatSync(path.join(root, file));
          assert.equal(stat.isSymbolicLink(), false, file);
          const row = { file, mode: stat.mode & 0o777, kind: entry.isDirectory() ? 'directory' : 'file' };
          return entry.isDirectory() ? [row, ...inventory(root, file)]
            : [{ ...row, sha256: hash(fs.readFileSync(path.join(root, file))) }];
        });
    }
    const shipped = path.join(ROOT, 'plugins/shipyard');
    assert.deepEqual(inventory(built), inventory(shipped), 'all package bytes, paths and modes derive from the builder');
    for (const relative of ['.codex-plugin/plugin.json', 'package-build.json'])
      assert.deepEqual(fs.readFileSync(path.join(built, relative)), fs.readFileSync(path.join(shipped, relative)));
    const runtime = 'host/plugins/delivery-pipeline/scripts/claude-runtime-host.cjs';
    const canonical = path.join(ROOT, 'plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
    f.runtimeFile = path.join(built, runtime);
    assert.deepEqual(fs.readFileSync(f.runtimeFile), fs.readFileSync(canonical));
    assert.equal(fs.statSync(f.runtimeFile).mode & 0o777, fs.statSync(canonical).mode & 0o777);
    const manifest = JSON.parse(fs.readFileSync(path.join(built, '.codex-plugin/plugin.json')));
    const identity = JSON.parse(fs.readFileSync(path.join(built, 'package-build.json')));
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/delivery-pipeline/.claude-plugin/plugin.json')));
    assert.equal(identity.version, manifest.version);
    assert.ok(identity.version.startsWith(source.version + '+codex.'));
    assert.match(identity.digest, /^[a-f0-9]{64}$/);
    assert.equal(require.cache[f.runtimeFile], undefined, 'the built runtime is a cold consumer');
    f.typed = true;
    const timer = clock(5000, 100, () => 6000);
    assertCompleted(f, await launch(f, timer, true));
    assert.deepEqual(timer.sleeps, [100]);
  } finally { f.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

if (process.argv[2] === '--isolated-case') {
  Promise.resolve().then(() => {
    assert.ok(cases.has(process.argv[3]), 'isolated process requires a registered case');
    return cases.get(process.argv[3])();
  }).then(() => process.stdout.write(JSON.stringify({ completed: true }) + '\n')).catch(error => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
} else {
  const { test } = require('node:test');
  for (const [title] of cases) test(title, () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stability-home-')));
    try {
      const { fixtureEnvironment } = require('../smoke/phase53-review-acceptance.cjs');
      const child = spawnSync(process.execPath, [__filename, '--isolated-case', title], {
        env: fixtureEnvironment(home), encoding: 'utf8', timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(child.error, undefined, String(child.error));
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.ok(Buffer.byteLength(child.stdout) + Buffer.byteLength(child.stderr) <= 8 * 1024 * 1024);
      assert.deepEqual(JSON.parse(child.stdout.trim()), { completed: true }, 'isolated process completed all assertions');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}
