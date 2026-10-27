'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const cases = [];
function test(title, run) { cases.push({ title, run }); }
const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner;
loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
const historicalFixtures = new Map();
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test(title, ...arguments_) {
      if (['second runtime producer retains complete inline full review and cannot borrow Codex authority',
        'second runtime adapter fixture seals a fresh full current judgment without a provider process'].includes(title))
        historicalFixtures.set(title, arguments_.at(-1));
    } } : originalLoad.call(this, name, ...args);
  };
  loaded._compile(fs.readFileSync(owner, 'utf8') + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, ordinaryPartitionCaller, supportedPartitionCaller, template, serialize, commit, write };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, ordinaryPartitionCaller, supportedPartitionCaller,
  template, serialize, commit, write } = loaded.exports;
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const runtime = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
const host = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
const contract = 'shipyard.semantic-review.v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/captured/boundaries/claude-stream.json')));
const records = fs.readFileSync(path.resolve(__dirname, '../..', registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'))), 'utf8')
  .trim().split('\n').map(JSON.parse).filter(row => !row.shipyard_fixture);

function fastPullRequestFixture(f, options) {
  const prs = Object.values(f.rows).flatMap(row => options.listPullRequests({ branch: row.branch }));
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const lists = prs.map(pr => '      ' + quote(pr.headRefName) + ") printf '%s' " + quote(JSON.stringify([pr])) + ' ;;').join('\n');
  const views = prs.map(pr => '    ' + quote(pr.number) + ") printf '%s' " + quote(JSON.stringify(pr)) + ' ;;').join('\n');
  fs.writeFileSync(path.join(f.root, 'bin/gh'), `#!/bin/sh
case "$1:$2" in
  pr:list)
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--head' ] && [ "$#" -ge 2 ]; then
        case "$2" in
${lists}
          *) printf '[]' ;;
        esac
        exit 0
      fi
      shift
    done
    exit 2 ;;
  pr:view)
    case "$3" in
${views}
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
}

function nativeFixture(f, role, controls = {}) {
  const fixture = publicPartitionFixture(f, 'claude');
  fastPullRequestFixture(f, fixture.options);
  const options = { ...fixture.options, refreshGit: false, getPullRequest: input => input.pr === f.pr.number ? { ...f.pr } : fixture.options.getPullRequest(input) };
  delete options.integrationCapacity;
  const launches = [], completed = [], pending = [];
  let recorder, timer;
  options.createRuntimeHost = input => {
    const session = controls.reuseFinalSession && launches.length === 2 ? launches[0].session : crypto.randomUUID();
    const native = runtime.createClaudeRuntimeHost({ ...input, uuid: () => session,
      startEvidenceFile: path.join(input.transcriptDir, 'session-start.json'),
      sessionTranscriptRoot: path.join(f.root, 'semantic-native'),
      probe: { status: 'available', executable: 'claude-fixture', runtime_version: registry.cli_version,
        capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
      spawn(_file, args) {
        const child = new EventEmitter(); child.pid = process.pid;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        let framed = '';
        child.stdin = { write(raw) { framed += raw; }, end() { process.nextTick(() => {
          try {
            assert.ok(framed.endsWith('\n'));
            const user = JSON.parse(framed.slice(0, -1)), prompt = user.message.content;
            const payload = JSON.parse(prompt.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\s*([\s\S]*?)\s*<\/AUTHENTICATED_SEMANTIC_REVIEW>/)[1]);
            if (payload.input_transport === 'host-files') {
              for (const source of payload.material) source.content = fs.readFileSync(path.resolve(f.worktree, source.read_path), 'utf8');
              payload.originals = payload.originals.map(original => {
                const original_text = fs.readFileSync(path.resolve(f.worktree, original.read_path), 'utf8');
                return { reference: original.reference, native: original.native, original_text, result: JSON.parse(original_text) };
              });
            }
            const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
            assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
            const sandbox = JSON.parse(args[args.indexOf('--settings') + 1]).sandbox.filesystem;
            assert.deepEqual(sandbox.allowWrite, []);
            assert.ok(sandbox.denyWrite.includes(f.worktree));
            assert.equal(schema.properties.runtime.const, 'claude');
            assert.equal(schema.properties.role.const, role);
            assert.equal(schema.properties.stage.const, payload.stage);
            const launch = { payload, prompt, session, schema }; launches.push(launch);
            if (payload.stage === 'final') for (const item of payload.originals) {
              assert.deepEqual(authority.readSemanticOriginal({ worktreePath: f.worktree,
                snapshot_sha256: payload.snapshot_sha256, assignment_id: item.reference.assignment_id }), item);
            }
            controls.onLaunch?.(launch, launches);
            const finish = () => {
              try {
                const identity = payload.reviewed_identity;
                const result = { schema: contract, review_contract: contract, role, stage: payload.stage,
                  runtime: 'claude', subject: payload.subject, snapshot_sha256: payload.snapshot_sha256,
                  assignment_id: payload.assignment?.id || null, binding_sha256: payload.binding_sha256,
                  reviewed_identity: identity, completeness: 'complete', outcome: 'passed', blocking_count: 0,
                  findings: [], conclusions: ['Read actual provider/consumer contracts and governing obligations.'],
                  limitations: [], required_context: [], unread: [],
                  coverage: payload.assignment?.primary_obligation_ids || payload.obligation_ids,
                  seams: payload.seams.map(seam => ({ id: seam.id, disposition: 'resolved', rationale: 'Read both actual source endpoints.' })),
                  originals: payload.originals?.map(item => item.reference) || [],
                  evidence_markdown: 'Complete native Claude report with INFO and boundary reasoning.\n' };
                if (payload.stage === 'final') Object.assign(result, { phase: identity.phase,
                  head: identity.head, head_tree: identity.head_tree, base: identity.base_ref,
                  base_tree: role === 'arch-review' ? identity.merge_base_tree : identity.base_tree,
                  ticket_set: identity.ticket_set, ticket_set_digest: identity.ticket_set_digest,
                  summary: 'Independent current judgment.', ...(role === 'arch-review' ? {
                    id: payload.subject, pr: identity.pr, repository: identity.repository,
                    base_commit: identity.base, merge_base: identity.merge_base, verdict: 'conform' } : {}) });
                controls.result?.(result, payload);
                const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
                const init = template(records, row => row.type === 'system' && row.subtype === 'init');
                Object.assign(init, { session_id: session, model, cwd: f.worktree });
                const assistant = template(records, row => row.type === 'assistant');
                Object.assign(assistant, { session_id: session, sessionId: session, effort });
                assistant.message.model = model === 'fable' ? 'claude-fable-5' : model;
                assistant.message.content = [{ type: 'tool_use', id: 'structured-' + session, name: 'StructuredOutput', input: result }];
                delete assistant.message.usage;
                const final = template(records, row => row.type === 'result');
                Object.assign(final, { session_id: session, subtype: 'success', is_error: false,
                  structured_output: result, result: JSON.stringify(result) });
                delete final.modelUsage;
                const tool = structuredClone(assistant);
                tool.message.content = [{ type: 'tool_use', id: 'source-read-' + session, name: 'Read', input: { file_path: 'src/provider.cjs' } }];
                const rows = [{ ...user, sessionId: session }, tool, { type: 'user', sessionId: session,
                  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'source-read-' + session,
                    content: payload.material.find(source => source.content.includes('exports.value'))?.content || 'Complete inline governing source.' }] } }, assistant];
                controls.native?.(rows, payload, launch);
                const nativePath = path.join(f.root, 'semantic-native/project', session + '.jsonl');
                fs.mkdirSync(path.dirname(nativePath), { recursive: true });
                fs.writeFileSync(nativePath, serialize(rows));
                const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
                const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
                capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
                  transcript_path: nativePath, cwd: f.worktree }, {
                  evidenceFile: hookArgs[hookArgs.indexOf('--evidence-file') + 1], expectedSession: session });
                controls.terminal?.(final, payload);
                Object.assign(launch, { result, nativePath, originalText: JSON.stringify(result) });
                completed.push(payload.assignment?.id || 'final');
                child.stdout.emit('data', Buffer.from(serialize([init, assistant, final])));
                child.emit('close', 0, null);
              } catch (error) { child.emit('error', error); }
            };
            if (payload.stage === 'worker') {
              pending.push(finish);
              if (pending.length === 1) timer = setTimeout(() => child.emit('error', new Error('two physical workers did not overlap')), 5000);
              if (pending.length === 2) {
                clearTimeout(timer);
                assert.equal(completed.length, 0);
                pending[1](); pending[0]();
              }
            } else finish();
          } catch (error) { child.emit('error', error); }
        }); } };
        return child;
      } });
    recorder = native.recorder;
    return native;
  };
  return { options, launches, completed, get recorder() { return recorder; } };
}

async function ordinary(f, role, prepared) {
  if (role === 'integrator') return ordinaryPartitionCaller(f, 'claude', prepared.options);
  return host.createClaudeRoleHost(prepared.options).run({ schema: host.REQUEST_SCHEMA,
    role, worktree: f.worktree, phase: f.phase, pr: f.pr.number });
}
function current(f, role) {
  const file = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const gateFile = require.resolve('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs');
  const cached = require.cache[file], cachedGate = require.cache[gateFile];
  delete require.cache[file]; delete require.cache[gateFile];
  try {
    const input = { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
      head: f.pr.headRefOid, baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid, headBranch: f.pr.headRefName };
    const api = require(file), gate = require(gateFile).verifyCurrentReviews({ ...input, getPullRequest: () => ({ ...f.pr }) });
    const verdict = role === 'integrator' ? api.currentIntegrationVerdict(input) : api.currentArchitectureVerdict(input);
    if (role === 'integrator') assert.deepEqual(gate.integration, verdict);
    else { assert.equal(gate.architecture.ready, !!verdict); if (verdict) assert.deepEqual(gate.architecture.verdict, verdict); }
    return verdict;
  } finally { require.cache[file] = cached; if (cachedGate) require.cache[gateFile] = cachedGate; else delete require.cache[gateFile]; }
}

for (const role of ['integrator', 'arch-review']) {
  test('ordinary Claude ' + role + ' overlaps originals and reaches cold current and real gate', async () => {
    await publicIntegrationFixture(async f => {
      const prepared = nativeFixture(f, role);
      const result = await ordinary(f, role, prepared);
      assert.equal(result.result.review_contract, contract);
      assert.equal(result.role, role);
      assert.equal(current(f, role)?.authenticated, true);
      assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
      const workers = prepared.launches.slice(0, 2), final = prepared.launches.at(-1);
      assert.deepEqual(prepared.completed, [workers[1].payload.assignment.id, workers[0].payload.assignment.id, 'final']);
      assert.equal(final.payload.originals.length, 2);
      for (const original of final.payload.originals) {
        const launch = workers.find(item => item.payload.assignment.id === original.reference.assignment_id);
        assert.deepEqual(original.result, launch.result);
        assert.equal(original.original_text, launch.originalText);
        assert.equal(original.native.observation.status, 'unknown');
        assert.equal(original.native.reads.completed.length, 1);
        assert.deepEqual(original.native.reads.incomplete, []);
        const receipt = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id).receipt;
        assert.equal(receipt.runtime, 'claude'); assert.equal(receipt.role, role);
        const manifest = JSON.parse(fs.readFileSync(path.join(f.worktree, original.reference.artifact_ref)));
        assert.equal(manifest.runtime, 'claude');
        assert.deepEqual(original.native.output_pin, receipt.transcript);
        for (const pin of [original.native.native_pin, original.native.output_pin]) {
          const raw = fs.readFileSync(pin.path); assert.equal(raw.length, pin.bytes); assert.equal(hash(raw), pin.sha256);
        }
      }
      assert.ok(final.payload.material.some(source => source.content.includes('diff --git')));
    });
  });

  for (const terminalCarrier of ['structured', 'text']) for (const nativeCarrier of ['input', 'text'])
    test('Claude ' + role + ' authenticates native ' + nativeCarrier + ' and terminal ' + terminalCarrier + ' carriers', async () => {
      await publicIntegrationFixture(async f => {
        const prepared = nativeFixture(f, role, { terminal(final) {
          if (terminalCarrier === 'structured') delete final.result;
          else delete final.structured_output;
        }, native(rows) {
          if (nativeCarrier === 'text') rows.at(-1).message.content = [{ type: 'text',
            text: JSON.stringify(rows.at(-1).message.content[0].input) }];
        } });
        const result = await ordinary(f, role, prepared);
        assert.equal(result.result.review_contract, contract);
        assert.ok(current(f, role));
      });
    });

  test('Claude ' + role + ' reconciles a recorded semantic final without another native session', async () => {
    await publicIntegrationFixture(async f => {
      const prepared = nativeFixture(f, role);
      const first = await ordinary(f, role, prepared);
      const pins = prepared.launches.at(-1).payload.originals.map(item => item.native);
      const finalPin = first.receipt.transcript, finalBytes = fs.readFileSync(finalPin.path);
      assert.equal(first.receipt.runtime_evidence, undefined);
      assert.equal(first.receipt.selection_evidence.session_id, prepared.launches.at(-1).session);
      const second = await ordinary(f, role, prepared);
      assert.equal(second.dispatch_id, first.dispatch_id);
      assert.equal(prepared.launches.length, 3);
      assert.deepEqual(second.receipt, first.receipt);
      assert.deepEqual(fs.readFileSync(finalPin.path), finalBytes);
      assert.equal(hash(finalBytes), finalPin.sha256);
      for (const item of pins) for (const pin of [item.native_pin, item.output_pin])
        assert.equal(hash(fs.readFileSync(pin.path)), pin.sha256);
      assert.ok(current(f, role));
      const nativePin = { ...first.receipt.selection_evidence.transcript,
        path: path.join(path.dirname(finalPin.path), 'projects', first.receipt.selection_evidence.transcript.path) };
      for (const pin of [finalPin, nativePin]) {
        const saved = fs.readFileSync(pin.path);
        assert.equal(hash(saved), pin.sha256);
        try {
          fs.appendFileSync(pin.path, '\n');
          await assert.rejects(ordinary(f, role, prepared), /changed|pin|size|differ/i);
        } finally { fs.writeFileSync(pin.path, saved); }
        assert.equal(prepared.launches.length, 3);
      }
      if (role === 'integrator') {
        const mirror = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
        const saved = fs.readFileSync(mirror);
        try {
          fs.appendFileSync(mirror, 'unrecorded evidence');
          await assert.rejects(ordinary(f, role, prepared), /changed|pin|size/i);
        } finally { fs.writeFileSync(mirror, saved); }
        assert.equal(prepared.launches.length, 3);
      }
      assert.ok(current(f, role));
    });
  });

  test('Claude ' + role + ' retains complete INFO and blocked original without completion credit', async () => {
    await publicIntegrationFixture(async f => {
      const prepared = nativeFixture(f, role, { result(result, payload) {
        if (payload.stage === 'worker') Object.assign(result, { completeness: 'blocked', outcome: 'human-review-required',
          required_context: ['Actual missing contract context'], findings: [{ id: 'info', type: 'informational', blocking: false,
            summary: 'Retain every original INFO detail.', evidence: 'src/provider.cjs:1; actual contract context is unavailable.' }],
          evidence_markdown: 'Unabridged blocked report.\n'.repeat(100) });
      } });
      await assert.rejects(ordinary(f, role, prepared), /incomplete|completion credit/i);
      const final = prepared.launches.at(-1).payload;
      assert.equal(final.stage, 'final');
      for (const item of final.originals) {
        const launch = prepared.launches.find(launch => launch.payload.assignment?.id === item.reference.assignment_id);
        assert.deepEqual(item.result, launch.result);
        assert.equal(item.original_text, launch.originalText);
        assert.ok(item.result.findings[0].summary.includes('INFO') && item.result.findings[0].evidence
          && item.result.required_context.length && item.result.evidence_markdown.length > 2000);
      }
      assert.equal(current(f, role), null);
    });
  });

  for (const mutation of ['runtime', 'session', 'model', 'effort', 'input', 'answer', 'final-session', 'membership', 'binding', 'reference', 'generation', 'terminal'])
    test('Claude ' + role + ' refuses foreign ' + mutation + ' evidence', async () => {
      await publicIntegrationFixture(async f => {
        const prepared = nativeFixture(f, role, {
          terminal(final) {
            if (mutation === 'terminal') final.result = JSON.stringify({ ...final.structured_output, evidence_markdown: 'Foreign terminal bytes' });
          },
          result(result, payload) {
            if (mutation === 'runtime') result.runtime = 'codex';
            if (mutation === 'generation') result.review_contract = 'shipyard.integration-review.v3';
            if (mutation === 'binding') result.binding_sha256 = '0'.repeat(64);
            if (mutation === 'reference' && payload.stage === 'final') result.originals[0] = { ...result.originals[0], dispatch_id: 'foreign-dispatch' };
            if (mutation === 'membership' && payload.stage === 'final') result.ticket_set = result.ticket_set.slice(1);
          },
          native(rows, payload) {
            if (mutation === 'session') rows[1].sessionId = crypto.randomUUID();
            if (mutation === 'model') rows[1].message.model = 'claude-foreign-model';
            if (mutation === 'effort') rows[1].effort = 'low';
            if (mutation === 'input') rows[0].message.content += '\nforeign native reference';
            if (mutation === 'answer') rows.at(-1).message.content[0].input = { ...rows.at(-1).message.content[0].input, evidence_markdown: 'Foreign report' };
            if (mutation === 'final-session' && payload.stage === 'final') rows.at(-1).sessionId = prepared.launches[0].session;
          },
        });
        await assert.rejects(ordinary(f, role, prepared));
        assert.equal(current(f, role), null);
      });
    });

  test('Claude ' + role + ' refuses a final reusing a worker native session', async () => {
    await publicIntegrationFixture(async f => {
      const prepared = nativeFixture(f, role, { reuseFinalSession: true });
      await assert.rejects(ordinary(f, role, prepared), /distinct|session/i);
      assert.equal(current(f, role), null);
    });
  });

  for (const failure of ['missing-output', 'failed-read', 'truncated-read', 'compaction', 'resource-stop'])
    test('Claude ' + role + ' retains explicit ' + failure + ' without granting completion', async () => {
      await publicIntegrationFixture(async f => {
        const prepared = nativeFixture(f, role, { native(rows, payload) {
          if (payload.stage !== 'worker') return;
          if (failure === 'missing-output') rows.splice(2, 1);
          if (failure === 'failed-read') rows[2].message.content[0].is_error = true;
          if (failure === 'truncated-read') rows[2].message.content[0].truncated = true;
          if (failure === 'compaction') rows.splice(1, 0, { type: 'system', subtype: 'compact_boundary' });
          if (failure === 'resource-stop') rows.at(-1).message.stop_reason = 'max_tokens';
        } });
        await assert.rejects(ordinary(f, role, prepared), /incomplete|completion/i);
        const originals = prepared.launches.at(-1).payload.originals;
        assert.equal(originals.length, 2);
        assert.ok(originals.every(item => item.native.resource_failure || item.native.reads.incomplete.length));
        assert.equal(current(f, role), null);
      });
    });

  for (const drift of ['source', 'base', 'criteria', 'membership', 'native', 'output']) test('current Claude ' + role + ' refuses ' + drift + ' drift', async () => {
    await publicIntegrationFixture(async f => {
      const prepared = nativeFixture(f, role);
      await ordinary(f, role, prepared);
      assert.ok(current(f, role));
      if (drift === 'source') { write(f.worktree, 'src/provider.cjs', 'exports.value = 9;\n'); commit(f, 'source drift'); }
      else if (drift === 'base') f.pr.baseRefOid = f.head;
      else {
        const report = prepared.launches.at(-1).payload.originals[0];
        const file = drift === 'native' ? report.native.native_pin.path : drift === 'output' ? report.native.output_pin.path
          : drift === 'membership' ? path.join(f.graphDir, 'tickets.json')
          : path.join(f.worktree, '.planning/architecture/ADR-014-original.md');
        const original = fs.readFileSync(file);
        try { fs.appendFileSync(file, '\n'); assert.equal(current(f, role), null); }
        finally { fs.writeFileSync(file, original); }
        return;
      }
      assert.equal(current(f, role), null);
    });
  });
}

test('ordinary requests select semantic review and manual v3 cannot create a new scheduler', async () => {
  await publicIntegrationFixture(async f => {
    for (const role of ['integrator', 'arch-review']) {
      const ordinary = { schema: host.REQUEST_SCHEMA, role, worktree: f.worktree,
        phase: f.phase, ...(role === 'arch-review' ? { pr: f.pr.number } : {}) };
      assert.equal(host.parseRequest(ordinary).review_contract, contract);
      const historical = role === 'integrator' ? 'shipyard.integration-review.v1' : 'shipyard.focused-architecture-review.v1';
      assert.equal(host.parseRequest({ ...ordinary, review_contract: historical }).review_contract, historical);
      assert.throws(() => host.parseRequest({ ...ordinary, partitions: {} }), /not permitted/);
      assert.throws(() => host.parseRequest({ ...ordinary, model: 'claude-opus-5-5' }), /not permitted/);
    }
    await assert.rejects(host.createClaudeRoleHost().run({ schema: host.REQUEST_SCHEMA, role: 'integrator',
      worktree: f.worktree, phase: f.phase, review_contract: 'shipyard.integration-review.v3' }), /historical|reserved/i);
  });
});

for (const [title, run] of historicalFixtures) test('historical Claude compatibility: ' + title, run);
test('both original Claude compatibility fixtures remain registered', () => assert.equal(historicalFixtures.size, 2));

test('historical Claude v3 completes recorded native work under its original contract', async () => {
  await publicIntegrationFixture(async f => {
    const fixture = publicPartitionFixture(f, 'claude', { observed: true });
    fastPullRequestFixture(f, fixture.options);
    const options = fixture.options, recorder = fixture.recorder;
    const original = host.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49',
      review_contract: 'shipyard.integration-review.v3' });
    const referencePath = require('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs').REFERENCE_PATHS.integrator;
    const reference = fs.readFileSync(referencePath);
    const scope = { worktree: f.worktree, ticket: original.ticket, phase: 49, run_id: 'original-v3' };
    const review = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs').prepareIntegrationLineage(scope, original, {
      ...options, nativeRuntime: 'claude', dispatchId: scope.run_id, storageRoot: path.join(f.root, 'original-v3-input'),
      generatedInstructionBytes: reference.length, instructionBinding: { agent_file: path.basename(referencePath),
        agent_path: referencePath, agent_sha256: hash(reference), installed_files: [],
        policy_hash: require('../../plugins/delivery-pipeline/scripts/model-policy.cjs').POLICY_HASH } });
    const partitions = authority.prepareIntegrationPartitions({ review });
    const capacityHost = authority.createIntegrationCapacityHost({ partitions, runtime: 'claude', recorder });
    const { createClaudeDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
    const { createDispatchBoundary } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const { createRunScope } = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
    const executeOriginal = async stage => {
      await authority.admitIntegrationCapacity({ prepared: stage, host: capacityHost });
      const directory = path.join(f.root, stage.dispatch_id);
      const native = options.createRuntimeHost({ scope: createRunScope({ run_id: stage.dispatch_id,
        repository_id: original.canonical.commonPath, phase: 49, ticket: original.rows[0].id,
        worktree: f.worktree, runtime: 'claude', owner_id: 'original-owner',
        dispatch: { runtime: 'claude', role: 'integrator', dispatch_id: stage.dispatch_id } }),
        recorder, recorderDir: recorder.storeDir, transcriptDir: path.join(directory, 'transcripts') });
      let completed;
      const adapter = createClaudeDispatchAdapter({ capabilities: native.capabilities, host: { async launch(selection) {
        completed = await native.agent(stage.input, { model: selection.model, effort: selection.effort,
          schema: host.integrationStageSchema(stage), readOnly: true });
        return native.applicationEvidence({ result: completed });
      } } });
      const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder, cwd: f.worktree });
      authority.assertIntegrationAdmission({ prepared: stage, launch: stage, host: capacityHost });
      await boundary.dispatch({ runtime: 'claude', role: 'integrator', signals: original.signals, dispatch_id: stage.dispatch_id }, {
        ticket: original.ticket, role: 'integrator', phase: original.phase, worktreePath: f.worktree,
        sourceRevision: f.head, contextPacket: original.packet });
      return completed.output;
    };
    for (const unit of partitions.plan.units) {
      const stage = authority.prepareIntegrationUnit({ partitions, unit_id: unit.unit_id,
        dispatch_id: 'integration-unit-' + partitions.plan.plan_sha256 + '-' + unit.unit_id });
      const result = await executeOriginal(stage);
      authority.sealIntegrationUnit({ prepared: stage, recorder, dispatchId: stage.dispatch_id, result });
    }
    const final = authority.prepareIntegrationAggregate({ partitions, dispatch_id: 'integration-final-' + partitions.plan.plan_sha256 });
    const originalResult = await executeOriginal(final);
    const receipt = recorder.getVerifiedRecord(final.dispatch_id).receipt;
    const streamBefore = fs.readFileSync(receipt.transcript.path);
    assert.equal(receipt.runtime_evidence, undefined);
    assert.equal(hash(streamBefore), receipt.transcript.sha256);
    const result = await supportedPartitionCaller(f, 'claude', { ...options,
      integrationCapacity: { plan_sha256: partitions.plan.plan_sha256, recorder },
      createRuntimeHost() { assert.fail('historical reconciliation cannot schedule native sessions'); } });
    assert.equal(result.result.review_contract, 'shipyard.integration-review.v3');
    assert.equal(result.dispatch.dispatch_id, final.dispatch_id);
    assert.equal(current(f, 'integrator')?.contract, 'shipyard.integration-review.v3');
    assert.equal(result.result.input_sha256, originalResult.input_sha256);
    assert.deepEqual(fs.readFileSync(receipt.transcript.path), streamBefore);
    assert.throws(() => host.semanticStageSchema(final), /semantic|payload/i);
  });
});

if (isMainThread) {
  registerTest('atomic receipt replacement preserves a concurrently reused descriptor', () => {
    const boundary = require.resolve('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const loadedBoundary = new Module(boundary, module);
    loadedBoundary.filename = boundary;
    loadedBoundary.paths = Module._nodeModulePaths(path.dirname(boundary));
    loadedBoundary._compile(fs.readFileSync(boundary, 'utf8') + '\nmodule.exports = { atomicReplaceJson };', boundary);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-descriptor-'));
    const target = path.join(directory, 'receipt.json'), decoy = path.join(directory, 'other-worker.txt');
    fs.writeFileSync(decoy, 'other worker owns this descriptor');
    const open = fs.openSync, close = fs.closeSync;
    let owned, reused;
    fs.openSync = function(file, ...args) {
      const fd = open.call(fs, file, ...args);
      if (String(file).startsWith(target + '.')) owned = fd;
      return fd;
    };
    fs.closeSync = function(fd) {
      if (fd === owned && reused === undefined) {
        close.call(fs, fd);
        reused = open.call(fs, decoy, 'r');
        assert.equal(reused, owned, 'the released descriptor is reused before receipt publication finishes');
        return;
      }
      return close.call(fs, fd);
    };
    try {
      loadedBoundary.exports.atomicReplaceJson(target, { complete: true });
      assert.equal(fs.readFileSync(reused, 'utf8'), 'other worker owns this descriptor');
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { complete: true });
    } finally {
      fs.openSync = open; fs.closeSync = close;
      if (reused !== undefined) { try { close.call(fs, reused); } catch {} }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  // @invariant: Four isolated workers bound fixture concurrency; each owns its environment, HOME and module cache.
  describe('Claude semantic review and original-contract compatibility', { concurrency: 4 }, () => {
    for (const [index, entry] of cases.entries()) registerTest(entry.title, async () => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-review-case-')));
      try {
        await new Promise((resolve, reject) => {
          const env = { ...process.env, HOME: home };
          delete env.NODE_TEST_CONTEXT;
          const worker = new Worker(__filename, { workerData: index, env });
          let completed = false, failure;
          worker.once('message', message => { completed = message?.completed === true; });
          worker.once('error', error => { failure = error; });
          worker.once('exit', code => {
            if (failure) reject(failure);
            else if (code !== 0 || !completed)
              reject(new Error(entry.title + ' worker exited without completing assertions: ' + code));
            else resolve();
          });
        });
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  });
} else {
  Promise.resolve().then(() => {
    assert.ok(Number.isSafeInteger(workerData) && cases[workerData], 'worker requires a registered dynamic case');
    return cases[workerData].run();
  }).then(() => parentPort.postMessage({ completed: true })).catch(error => {
    setImmediate(() => { throw error; });
  });
}
