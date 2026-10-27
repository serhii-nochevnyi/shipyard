'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner;
loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
  };
  loaded._compile(fs.readFileSync(owner, 'utf8') + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller: ordinaryPartitionCaller, currentPartitionConsumer, template, parent, cli, serialize, commit, write };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller,
  currentPartitionConsumer, template, parent, cli, serialize, commit, write } = loaded.exports;
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const contract = 'shipyard.semantic-review.v1';

function semanticFixture(f, controls = {}) {
  const prepared = publicPartitionFixture(f, 'codex');
  const { options, recorder } = prepared;
  delete options.integrationCapacity;
  const launches = [], completed = [];
  const pending = [];
  let barrierTimer;
  options.spawn = (_executable, runtimeArgs) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = process.pid;
    let input = '';
    child.stdin = { write(raw) { input += raw; }, end() { process.nextTick(() => {
      try {
        input = input.replace(/\n$/, '');
        const payload = JSON.parse(input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\s*([\s\S]*?)\s*<\/AUTHENTICATED_SEMANTIC_REVIEW>/)[1]);
        if (payload.input_transport === 'host-files') {
          for (const source of payload.material) source.content = fs.readFileSync(path.resolve(f.worktree, source.read_path), 'utf8');
          payload.originals = payload.originals.map(original => {
            const original_text = fs.readFileSync(path.resolve(f.worktree, original.read_path), 'utf8');
            return { reference: original.reference, native: original.native, original_text, result: JSON.parse(original_text) };
          });
        }
        const launch = { input, payload, runtime_args: runtimeArgs }; launches.push(launch);
        if (payload.stage === 'final') {
          assert.equal(payload.originals.length, 2);
          for (const item of payload.originals) {
            const retained = authority.readSemanticOriginal({ worktreePath: f.worktree,
              snapshot_sha256: payload.snapshot_sha256, assignment_id: item.reference.assignment_id });
            assert.deepEqual(retained, item, 'final starts only after complete originals are durably authenticated');
          }
        }
        controls.onLaunch?.(launch, launches);
        const finish = () => {
          try {
            const identity = payload.reviewed_identity;
            const result = { schema: contract, review_contract: contract, role: 'integrator', stage: payload.stage,
              runtime: 'codex', subject: payload.subject, snapshot_sha256: payload.snapshot_sha256,
              assignment_id: payload.assignment?.id || null, binding_sha256: payload.binding_sha256, reviewed_identity: identity,
              completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [], limitations: [],
              required_context: [], unread: [], conclusions: ['Evaluated actual provider and consumer behavior.'],
              coverage: payload.assignment?.primary_obligation_ids || payload.obligation_ids,
              seams: payload.seams.map(seam => ({ id: seam.id, disposition: 'resolved', rationale: 'Read both actual endpoints.' })),
              originals: payload.originals?.map(item => item.reference) || [],
              evidence_markdown: 'Complete original evidence, including INFO and seam reasoning.' };
            if (payload.stage === 'final') Object.assign(result, { phase: identity.phase,
              head: identity.head, head_tree: identity.head_tree, base: identity.base_ref,
              base_tree: identity.base_tree, ticket_set: identity.ticket_set,
              ticket_set_digest: identity.ticket_set_digest, summary: 'Independent integration judgment.' });
            controls.result?.(result, payload);
            const session = controls.session?.(payload) || crypto.randomUUID();
            const agentPath = path.join(options.agentDir, JSON.parse(fs.readFileSync(options.agentManifest)).agent_files[0]);
            const agentText = fs.readFileSync(agentPath, 'utf8');
            const text = JSON.stringify(result);
            launch.result = result; launch.text = text; launch.session = session;
            const meta = template(parent, row => row.type === 'session_meta');
            Object.assign(meta.payload, { id: session, session_id: session, cwd: f.worktree, runtime_workspace_roots: [f.worktree] });
            const context = template(parent, row => row.type === 'turn_context');
            const model = /^model = "(.+)"$/m.exec(agentText)[1];
            const effort = /^model_reasoning_effort = "(.+)"$/m.exec(agentText)[1];
            Object.assign(context.payload, { model, effort, cwd: f.worktree, workspace_roots: [f.worktree] });
            context.payload.sandbox_policy.type = 'read-only';
            Object.assign(context.payload.collaboration_mode.settings, { model, reasoning_effort: effort });
            const start = template(parent, row => row.payload?.type === 'task_started');
            const turn = start.payload.turn_id; context.payload.turn_id = turn;
            const developer = template(parent, row => row.payload?.role === 'developer');
            developer.payload.content = [{ type: 'input_text', text: runtime.generatedInstructions(agentText) }];
            const user = template(parent, row => row.payload?.role === 'user');
            user.payload.content = [{ type: 'input_text', text: input }];
            const final = template(parent, row => row.payload?.phase === 'final_answer');
            final.payload.content.forEach(block => { block.text = text; });
            final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
            const complete = template(parent, row => row.payload?.type === 'task_complete');
            Object.assign(complete.payload, { turn_id: turn, last_agent_message: text });
            const rows = [meta, context, start, developer, user,
              template(parent, row => row.payload?.type === 'token_count'), final, complete];
            controls.native?.(rows, payload);
            const now = new Date(), directory = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
              String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
            fs.mkdirSync(directory, { recursive: true });
            launch.nativePath = path.join(directory, session + '.jsonl');
            fs.writeFileSync(launch.nativePath, serialize(rows));
            const stream = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
              .map(type => template(cli, row => row.type === type));
            stream[0].thread_id = session; stream[2].item.text = text;
            completed.push(payload.assignment?.id || 'final');
            child.stdout.emit('data', Buffer.from(serialize(stream))); child.emit('close', 0);
          } catch (error) { child.emit('error', error); }
        };
        if (payload.stage === 'worker' && controls.barrier !== false) {
          pending.push(finish);
          if (pending.length === 1) barrierTimer = setTimeout(() => {
            child.emit('error', new Error('both semantic workers did not reach the physical launch barrier'));
          }, 5000);
          if (pending.length === 2) {
            clearTimeout(barrierTimer);
            assert.equal(completed.length, 0, 'both physical workers must be in flight');
            pending[1](); pending[0]();
          }
        } else finish();
      } catch (error) { child.emit('error', error); }
    }); } };
    return child;
  };
  return { options, recorder, launches, completed, controls };
}

function coldCurrent(f) {
  const artifactPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const gatePath = require.resolve('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs');
  const artifactModule = require.cache[artifactPath], gateModule = require.cache[gatePath];
  delete require.cache[artifactPath]; delete require.cache[gatePath];
  try {
    const input = { worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName };
    const current = require(artifactPath).currentIntegrationVerdict(input);
    const gate = require(gatePath).verifyCurrentReviews({ ...input, pr: f.pr.number, getPullRequest: () => ({ ...f.pr }) });
    assert.deepEqual(gate.integration, current);
    assert.equal(gate.architecture.ready, false);
    return current;
  } finally {
    require.cache[artifactPath] = artifactModule;
    if (gateModule) require.cache[gatePath] = gateModule; else delete require.cache[gatePath];
  }
}

function captureOriginals(f, prepared) {
  const workers = prepared.launches.filter(item => item.payload.stage === 'worker');
  return workers.map(launch => {
    const original = authority.readSemanticOriginal({ worktreePath: f.worktree,
      snapshot_sha256: launch.payload.snapshot_sha256, assignment_id: launch.payload.assignment.id });
    assert.equal(original.result.evidence_markdown, launch.result.evidence_markdown);
    assert.equal(original.original_text, launch.text, 'original JSON bytes survive projection');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.worktree, original.reference.artifact_ref)));
    assert.equal(fs.readFileSync(path.join(f.worktree, manifest.files.findings.path), 'utf8'), launch.text + '\n');
    assert.equal(fs.readFileSync(path.join(f.worktree, manifest.files.evidence.path), 'utf8'), launch.result.evidence_markdown);
    for (const pin of [original.native.native_pin, original.native.output_pin]) {
      const raw = fs.readFileSync(pin.path);
      assert.equal(raw.length, pin.bytes); assert.equal(hash(raw), pin.sha256);
    }
    assert.equal(original.reference.dispatch_id, prepared.recorder.getVerifiedRecord(original.reference.dispatch_id).dispatch_id);
    return original;
  });
}

test('ordinary Codex caller runs simultaneous semantic assignments and reaches cold current gate', async () => {
  await publicIntegrationFixture(async f => {
    write(f.worktree, 'src/identical-a.cjs', 'exports.alias = true;\n');
    write(f.worktree, 'src/identical-b.cjs', 'exports.alias = true;\n');
    commit(f, 'fixture: preserve exact-byte product aliases');
    const prepared = semanticFixture(f);
    const completed = await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(completed.result.review_contract, contract);
    assert.deepEqual(prepared.completed, ['consumer-acceptance', 'producer-contract', 'final']);
    const originals = captureOriginals(f, prepared);
    const primary = prepared.launches.filter(item => item.payload.stage === 'worker')
      .flatMap(item => item.payload.assignment.primary_obligation_ids);
    assert.equal(new Set(primary).size, primary.length);
    assert.deepEqual([...primary].sort(), [...prepared.launches.at(-1).payload.obligation_ids].sort());
    assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
    assert.equal(coldCurrent(f)?.contract, contract);
    assert.equal(currentPartitionConsumer(f)?.contract, contract);
    const material = prepared.launches.at(-1).payload.material;
    const aliases = material.find(source => source.content === 'exports.alias = true;\n');
    assert.ok(aliases);
    assert.ok(aliases.aliases.some(alias => alias.path === 'src/identical-a.cjs'));
    assert.ok(aliases.aliases.some(alias => alias.path === 'src/identical-b.cjs'));
    for (const source of material) {
      assert.equal(source.bytes, Buffer.byteLength(source.content));
      assert.equal(source.sha256, hash(source.content));
    }
    const supports = prepared.launches.filter(item => item.payload.stage === 'worker').map(item => item.payload.assignment.support_obligation_ids);
    assert.ok(supports.every(ids => ids.length));
    assert.ok(supports[0].some(id => supports[1].includes(id)), 'governing support reads overlap without primary credit');

    assert.deepEqual(prepared.launches.at(-1).payload.originals.map(item => item.original_text), originals.map(item => item.original_text));
    for (const launch of prepared.launches) {
      const original = fs.readFileSync(launch.nativePath);
      fs.appendFileSync(launch.nativePath, '\n');
      assert.equal(currentPartitionConsumer(f), null);
      fs.writeFileSync(launch.nativePath, original);
    }
    assert.equal(currentPartitionConsumer(f)?.authenticated, true);
  });
});

for (const status of ['INFO', 'blocked', 'incomplete']) test('retains complete ' + status + ' original without completion credit', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f, { result(result, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
      result.findings = [{ id: 'INFO-1', type: 'informational', blocking: false, summary: 'Complete INFO retained', evidence: 'src/provider.cjs:1', ticket: null }];
      if (status !== 'INFO') {
        result.completeness = status === 'incomplete' ? 'incomplete' : 'blocked';
        result.required_context = ['Actual consumer context unavailable']; result.unread = result.coverage;
      }
    } });
    if (status === 'INFO') await supportedPartitionCaller(f, 'codex', prepared.options);
    else await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), error => error.code === 'SEMANTIC_REVIEW_INCOMPLETE');
    const originals = captureOriginals(f, prepared);
    assert.equal(originals[0].result.findings[0].id, 'INFO-1');
    if (status !== 'INFO') assert.equal(currentPartitionConsumer(f), null);
  });
});

test('cold restart reuses authentic originals and unknown final is never silently retried', async () => {
  await publicIntegrationFixture(async f => {
    let stop = true;
    const prepared = semanticFixture(f, { onLaunch(launch) {
      if (stop && launch.payload.stage === 'final') throw new Error('transport lost final');
    } });
    await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), /transport lost final/);
    const originals = captureOriginals(f, prepared), launches = prepared.launches.length;
    stop = false;
    await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), error => error.code === 'SEMANTIC_REVIEW_UNKNOWN');
    assert.equal(prepared.launches.length, launches);
    assert.deepEqual(captureOriginals(f, prepared), originals);
  });
});

function stopBeforeFinal(prepared, f) {
  const run = prepared.options.execFileSync;
  let interrupted = false;
  prepared.options.execFileSync = (file, args, options) => {
    if (!interrupted && file === 'git' && args.includes('diff') && args.includes('--name-only')
        && prepared.completed.length === 2 && authority.authenticatedArchivePins(f.worktree).length === 6) {
      interrupted = true;
      throw new Error('stop before final reservation');
    }
    return run(file, args, options);
  };
  return () => {
    prepared.options.execFileSync = run;
    assert.equal(interrupted, true);
  };
}

test('compatible restart after retained originals launches only the independent final', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f);
    const restore = stopBeforeFinal(prepared, f);
    try { await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), /stop before final reservation/); }
    finally { restore(); }
    const originals = captureOriginals(f, prepared);
    await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(prepared.launches.filter(item => item.payload.stage === 'worker').length, 2);
    assert.deepEqual(captureOriginals(f, prepared), originals);
    assert.equal(coldCurrent(f)?.authenticated, true);
  });
});

test('restart reconciles authentic recorder output when original publication was interrupted', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f);
    const restore = stopBeforeFinal(prepared, f);
    try { await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), /stop before final reservation/); }
    finally { restore(); }
    const originals = captureOriginals(f, prepared);
    const directory = authority.archiveAuthorityDirectory(f.worktree);
    const entries = fs.readdirSync(directory).filter(name => name.startsWith('integration-semantic-original-'));
    assert.equal(entries.length, 2);
    fs.unlinkSync(path.join(directory, entries[0]));
    await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(prepared.launches.filter(item => item.payload.stage === 'worker').length, 2);
    assert.deepEqual(captureOriginals(f, prepared), originals);
    assert.equal(currentPartitionConsumer(f)?.authenticated, true);
  });
});

for (const field of ['source', 'base', 'membership', 'criteria', 'instructions']) test('cold current refuses moved ' + field, async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f);
    await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.ok(currentPartitionConsumer(f));
    if (field === 'source') require('node:child_process').execFileSync('git', ['-C', f.worktree, 'update-ref', 'HEAD', f.base]);
    if (field === 'base') require('node:child_process').execFileSync('git', ['-C', f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head]);
    const file = field === 'membership' ? path.join(f.graphDir, 'tickets.json')
      : field === 'criteria' ? path.join(f.worktree, f.rows['T-49-01'].plan)
      : field === 'instructions' ? path.join(prepared.options.agentDir, JSON.parse(fs.readFileSync(prepared.options.agentManifest)).agent_files[0]) : null;
    if (file) fs.appendFileSync(file, '\n');
    assert.equal(currentPartitionConsumer(f), null);
  });
});

for (const mutation of ['worker-as-final', 'reused-session', 'unread', 'truncation', 'window-overflow']) test('refuses ' + mutation + ' authority', async () => {
  await publicIntegrationFixture(async f => {
    let session;
    const prepared = semanticFixture(f, {
      session(payload) { if (mutation !== 'reused-session') return; session ||= crypto.randomUUID(); return session; },
      result(result, payload) {
        if (payload.stage !== 'final') return;
        if (mutation === 'worker-as-final') result.stage = 'worker';
        if (mutation === 'unread') result.unread = [payload.obligation_ids[0]];
      },
      native(rows, payload) {
        if (payload.stage !== 'final') return;
        if (mutation === 'truncation') rows.splice(-2, 0, { type: 'event_msg', payload: { type: 'input_truncated' } });
        if (mutation === 'window-overflow') rows.find(row => row.payload?.type === 'token_count').payload.info.model_context_window = 1;
      }
    });
    await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options));
    assert.equal(currentPartitionConsumer(f), null);
  });
});

for (const finalOutcome of ['needs-fix', 'passed']) test('independent final evaluates actual producer/consumer mismatch: ' + finalOutcome, async () => {
  await publicIntegrationFixture(async f => {
    write(f.worktree, 'src/consumer.cjs', "module.exports = require('./provider.cjs').make();\n");
    commit(f, 'fixture: producer exports value while consumer calls make');
    const prepared = semanticFixture(f, { result(result, payload) {
      assert.ok(payload.material.some(source => source.content.includes('exports.value = 1')));
      assert.ok(payload.material.some(source => source.content.includes('.make()')));
      assert.ok(payload.seams.some(seam => seam.producer === 'src/provider.cjs' && seam.consumer === 'src/consumer.cjs'));
      if (payload.stage === 'worker') {
        result.outcome = 'needs-fix'; result.blocking_count = 1;
        result.findings = [{ id: 'SEAM-1', type: 'violation', blocking: true,
          summary: 'Consumer calls make but producer exports only value', evidence: 'src/consumer.cjs:1; src/provider.cjs:1', ticket: null }];
        result.seams.forEach(seam => { seam.disposition = 'unresolved'; });
        return;
      }
      assert.equal(payload.originals.length, 2);
      assert.ok(payload.originals.every(item => item.result.findings[0].id === 'SEAM-1'));
      if (finalOutcome === 'needs-fix') {
        result.outcome = 'needs-fix'; result.blocking_count = 1;
        result.findings = [{ id: 'FINAL-1', type: 'violation', blocking: true,
          summary: 'Independent final confirms producer/consumer mismatch', evidence: 'src/consumer.cjs:1; src/provider.cjs:1', ticket: null }];
        result.seams.forEach(seam => { seam.disposition = 'unresolved'; });
      }
    } });
    if (finalOutcome === 'passed') await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), /unresolved original findings/);
    else assert.equal((await supportedPartitionCaller(f, 'codex', prepared.options)).result.outcome, 'needs-fix');
    assert.equal(currentPartitionConsumer(f), null);
    captureOriginals(f, prepared);
  });
});

for (const mutation of ['duplicate-primary', 'missing-primary']) test('refuses ' + mutation + ' original completion', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f, { result(result, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
      if (mutation === 'duplicate-primary') result.coverage.push(result.coverage[0]);
      else result.coverage.pop();
    } });
    await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), /primary ownership/);
    assert.equal(currentPartitionConsumer(f), null);
  });
});

function ordinaryRead(rows, command, output, call = 'ordinary-source-read') {
  const invocation = template(parent, row => row.payload?.type === 'function_call');
  Object.assign(invocation.payload, { name: 'exec_command', call_id: call,
    arguments: JSON.stringify({ cmd: command, max_output_tokens: 5000 }) });
  delete invocation.payload.namespace;
  const response = template(parent, row => row.payload?.type === 'function_call_output');
  Object.assign(response.payload, { call_id: call, output: JSON.stringify(output) });
  const turn = rows.find(row => row.payload?.type === 'task_started').payload.turn_id;
  for (const row of [invocation, response]) row.payload.internal_chat_message_metadata_passthrough = { turn_id: turn };
  rows.splice(-3, 0, invocation, response);
}

test('ordinary source/diff and auxiliary metadata reads succeed without ordered range choreography', async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f, { native(rows) {
      ordinaryRead(rows, 'git status --short', { exit_code: 0, output: '' }, 'metadata');
      ordinaryRead(rows, 'cat src/provider.cjs src/consumer.cjs', {
        exit_code: 0, output: fs.readFileSync(path.join(f.worktree, 'src/provider.cjs'), 'utf8')
          + fs.readFileSync(path.join(f.worktree, 'src/consumer.cjs'), 'utf8') });
      ordinaryRead(rows, 'git diff ' + f.base + ' ' + f.head + ' -- src', { exit_code: 0,
        output: require('node:child_process').execFileSync('git', ['-C', f.worktree, 'diff', f.base, f.head, '--', 'src'], { encoding: 'utf8' }) }, 'diff');
    } });
    await supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(currentPartitionConsumer(f)?.authenticated, true);
    assert.equal(captureOriginals(f, prepared)[0].native.reads.completed.length, 3);
  });
});

for (const failure of ['failed', 'unfinished', 'truncated', 'missing-usage']) test('retains original resource outcome without passing final: ' + failure, async () => {
  await publicIntegrationFixture(async f => {
    const prepared = semanticFixture(f, { native(rows, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
      if (failure === 'missing-usage') rows.splice(rows.findIndex(row => row.payload?.type === 'token_count'), 1);
      else ordinaryRead(rows, 'cat src/missing.cjs', failure === 'failed' ? { exit_code: 1, output: 'No such file' }
        : failure === 'unfinished' ? { session_id: 123, output: '' }
          : { exit_code: 0, truncated: true, output: 'Only a prefix' });
    }, result(result, payload) {
      if (payload.stage !== 'worker' || payload.assignment.id !== 'producer-contract') return;
      result.completeness = 'blocked'; result.required_context = ['Unresolved native resource outcome'];
    } });
    await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), error => error.code === 'SEMANTIC_REVIEW_INCOMPLETE');
    const original = captureOriginals(f, prepared)[0];
    if (failure === 'missing-usage') {
      assert.equal(original.native.accounting.status, 'unknown');
      assert.equal(original.native.resource_failure, null);
    }
    else assert.equal(original.native.reads.incomplete.length, 1);
    assert.equal(currentPartitionConsumer(f), null);
  });
});

function waitFixture(output) {
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/codex-agent-parent-0.155.1.jsonl'), 'utf8');
  const rows = fixture.trim().split('\n').map(JSON.parse);
  const wait = rows.find(row => row.payload?.name === 'wait_agent');
  assert.ok(wait);
  rows.find(row => row.payload?.type === 'function_call_output' && row.payload.call_id === wait.payload.call_id).payload.output = output;
  return { raw: serialize(rows), id: rows.find(row => row.type === 'session_meta').payload.id };
}

test('interrupted wait recognizes only exact native text and still requires child completion', () => {
  const exact = 'Wait interrupted by new input.';
  const captured = waitFixture(exact);
  const spawn = JSON.parse(captured.raw.split('\n').filter(Boolean).map(JSON.parse).find(row => row.payload?.name === 'spawn_agent').payload.arguments);
  const parse = raw => runtime.parseNativeParentSpawn(raw, captured.id, spawn.agent_type, spawn.model, spawn.reasoning_effort);
  assert.equal(parse(captured.raw).interrupted, true);
  const spawnEvidence = parse(captured.raw);
  const childRaw = fs.readFileSync(path.join(__dirname, '../fixtures/codex-agent-child-0.155.1.jsonl'), 'utf8');
  const rows = childRaw.trim().split('\n').map(JSON.parse);
  const meta = rows.find(row => row.type === 'session_meta').payload;
  const instructions = rows.find(row => row.payload?.role === 'developer').payload.content[0].text;
  const agent = { instructions, instructions_sha256: hash(instructions), file: '/fixture/agent.toml', sha256: hash(instructions) };
  const parseChild = (raw, parentId = captured.id, role = spawn.agent_type, model = spawn.model, evidence = spawnEvidence) =>
    runtime.parseNativeChildTranscript(raw, meta.id, parentId, role, model, spawn.reasoning_effort, agent, evidence);
  assert.equal(parseChild(childRaw).session_id, meta.id);
  const completion = rows.find(row => row.payload?.type === 'task_complete');
  assert.throws(() => parseChild(''));
  assert.throws(() => parseChild(serialize(rows.filter(row => row !== completion))));
  assert.throws(() => parseChild(serialize([...rows, completion])));
  assert.throws(() => parseChild(childRaw, 'foreign-parent'));
  assert.throws(() => parseChild(childRaw, captured.id, 'gsd-planner'));
  assert.throws(() => parseChild(childRaw, captured.id, spawn.agent_type, 'foreign-model'));
  assert.throws(() => parseChild(childRaw, captured.id, spawn.agent_type, spawn.model, { ...spawnEvidence, task_path: '/root/foreign' }));
  const changed = structuredClone(rows);
  changed.find(row => row.payload?.role === 'developer').payload.content[0].text += 'changed';
  assert.throws(() => parseChild(serialize(changed)));
  for (const near of [exact.slice(0, -1), ' ' + exact, exact + '\n', 'wait interrupted by new input.'])
    assert.throws(() => parse(waitFixture(near).raw));
});
