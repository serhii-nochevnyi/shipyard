'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const scripts = path.join(root, 'plugins/delivery-pipeline/scripts');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = require(path.join(scripts, 'model-policy-internal.cjs')).stableStringify;
const policy = require(path.join(scripts, 'model-policy.cjs'));
const boundary = require(path.join(scripts, 'dispatch-boundary.cjs'));
const host = require(path.join(scripts, 'codex-delivery-host.cjs'));
const artifacts = require(path.join(scripts, 'role-artifact.cjs'));
const coverage = require(path.join(scripts, 'conveyor-coverage.cjs'));
const builder = require(path.join(scripts, 'deliver-dispatch.cjs'));
const bounded = { timeout: 180000, concurrency: 2 };
function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 180000,
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function historicalCiScripts(directory) {
  fs.cpSync(scripts, directory, { recursive: true });
  for (const file of ['codex-delivery-host.cjs', 'dispatch-boundary.cjs']) fs.writeFileSync(path.join(directory, file),
    execFileSync('git', ['-C', root, 'show', '17a0ebbae24e35d86f1e41778a6c36fc61c78407:plugins/delivery-pipeline/scripts/' + file],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  return directory;
}
function signingFixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-')));
  const saved = Object.fromEntries(['HOME', 'GNUPGHOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'SHIPYARD_COVERAGE_ROOT'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: directory, GNUPGHOME: path.join(directory, 'gpg'),
    GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SHIPYARD_COVERAGE_ROOT: path.join(directory, 'coverage') });
  fs.mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
  execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
    'Fixture <fixture@example.test>', 'ed25519', 'sign', '0'], { stdio: 'pipe', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const signer = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], { encoding: 'utf8', stdio: 'pipe', timeout: 180000 })
    .split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
  return { directory, signer, close() {
    const stopped = spawnSync('gpgconf', ['--homedir', process.env.GNUPGHOME, '--kill', 'gpg-agent'], { timeout: 5000, stdio: 'pipe' });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(stopped.status, 0, String(stopped.stderr));
  } };
}
function ciFixture(signing, { declaredRepo = 'fixture/repository', producerScripts = scripts } = {}) {
  const deliveryHost = require(path.join(producerScripts, 'codex-delivery-host.cjs'));
  const worktree = path.join(signing.directory, crypto.randomUUID()), project = path.join(signing.directory, crypto.randomUUID());
  process.env.SHIPYARD_COVERAGE_ROOT = path.join(signing.directory, 'coverage-' + hash(worktree));
  const graphDir = path.join(project, '.planning/graph'), plan = path.join(project, '.planning/PLAN.md');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true }); fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(path.join(worktree, 'plugins/delivery-pipeline/.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'), '{"name":"shipyard"}');
  fs.writeFileSync(path.join(worktree, 'src/owned.txt'), 'original\n');
  fs.writeFileSync(path.join(worktree, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('src/owned.txt','utf8'),'fixed\\n');\n");
  git(worktree, 'init', '-q', '-b', 'main');
  for (const [key, value] of Object.entries({ 'user.name': 'Fixture', 'user.email': 'fixture@example.test',
    'user.signingkey': signing.signer, 'commit.gpgsign': 'false' })) git(worktree, 'config', key, value);
  git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'original'); git(worktree, 'switch', '-c', 'ticket/T-53-31');
  const scope = { run_id: 'fixture-' + crypto.randomUUID(), ticket: 'T-53-31', phase: 53, worktree, runtime: 'codex', provider: 'openai' };
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: { 'T-53-31': {
    phase: 53, branch: 'ticket/T-53-31', pr_base: 'main', plan: '.planning/PLAN.md', files: ['src/owned.txt'], repo: declaredRepo,
  } } }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify({ 'T-53-31': { pr: 501, base: 'main', branch: 'ticket/T-53-31' } }));
  fs.writeFileSync(plan, '# Approved\n\n## Verification commands\n\n- `node check.cjs`\n');
  const verificationAllowList = [{ argv: ['node', 'check.cjs'], profile: 'host', timeout_s: 600 }];
  fs.writeFileSync(path.join(project, '.planning/config.json'), JSON.stringify({ delivery_pipeline: { verification_commands: { default: verificationAllowList } } }));
  const agentDir = path.join(signing.directory, 'agents-' + crypto.randomUUID()); fs.mkdirSync(agentDir);
  const generator = require(path.join(root, 'scripts/gen-codex-shipyard.cjs'));
  const first = policy.resolveDispatch({ runtime: 'codex', role: 'ci-fix' });
  const manifest = { policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION, policy_hash: policy.POLICY_HASH, agent_files: [], agent_digests: {} };
  const variants = generator.codexStaticVariants().filter(variant => variant.role === 'ci-fix');
  for (const { effort, file, rung } of variants) {
    const content = ['# shipyard-policy-id = "' + policy.POLICY.id + '"', '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
      '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"', '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "ci-fix"',
      '# shipyard-policy-rung = "' + rung + '"', 'name = "' + file.replace('.toml', '') + '"', 'model = "' + first.model + '"',
      'model_reasoning_effort = "' + effort + '"', 'sandbox_mode = "workspace-write"', "developer_instructions = '''", 'Repair actual CI within the canonical PLAN.', "'''", ''].join('\n');
    fs.writeFileSync(path.join(agentDir, file), content); manifest.agent_files.push(file); manifest.agent_digests[file] = hash(content);
  }
  assert.ok(generator);
  const agentManifest = path.join(agentDir, '.shipyard-manifest.json'); fs.writeFileSync(agentManifest, JSON.stringify(manifest));
  const failureFile = path.join(signing.directory, 'failure-' + crypto.randomUUID() + '.log'), failureBytes = Buffer.from('Original complete failing check output\n');
  fs.writeFileSync(failureFile, failureBytes, { mode: 0o600 });
  const originalHead = git(worktree, 'rev-parse', 'HEAD'), base = git(worktree, 'rev-parse', 'main');
  let publishedHead = originalHead, launches = 0, pushes = 0;
  const requests = [], selections = [], responses = {};
  const control = { failPush: false, source: true, role: 'ci-fix', runAttempt: 1, jobId: '43', mutateNative: null, mutateResponse: null };
  const live = () => ({ number: 501, state: 'OPEN', headRefName: 'ticket/T-53-31', headRefOid: publishedHead, baseRefName: 'main', baseRefOid: base });
  const transport = (program, args, options) => {
    requests.push({ program, args });
    if (program === 'git' && args[0] === 'push') { pushes++; if (control.failPush) throw new Error('Original push outcome unknown'); publishedHead = git(worktree, 'rev-parse', 'HEAD'); return ''; }
    assert.equal(program, 'gh');
    if (args[0] === 'repo') return JSON.stringify({ owner: { login: 'fixture' }, name: 'repository', nameWithOwner: 'fixture/repository' });
    assert.equal(args[0], 'api', 'CI must never perform review or thread actions');
    const endpoint = args[1]; let value;
    if (endpoint.endsWith('/pulls/501')) value = { number: 501, state: 'open', head: { sha: publishedHead, repo: { full_name: 'fixture/repository' } }, base: { repo: { full_name: 'fixture/repository' } } };
    else if (endpoint.includes('/check-runs?')) value = [{ total_count: 1, check_runs: [{ id: 41, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: publishedHead,
      app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 47 }, started_at: '2026-11-01T00:00:00Z',
      details_url: `https://github.com/fixture/repository/actions/runs/42/attempts/${control.runAttempt}/job/${control.jobId}` }] }];
    else if (endpoint.includes('/status?')) value = [{ sha: publishedHead, total_count: 0, statuses: [] }];
    else if (endpoint.includes('/actions/runs/42')) value = { id: 42, head_sha: publishedHead, head_repository: { full_name: 'fixture/repository' },
      repository: { full_name: 'fixture/repository' }, check_suite_id: 47, workflow_id: 44, run_number: 1,
      run_attempt: control.runAttempt, name: 'CI', event: 'pull_request' };
    else if (endpoint.endsWith(`/actions/jobs/${control.jobId}/logs`)) return failureBytes;
    else throw new Error('Unexpected physical fixture request: ' + args.join(' '));
    control.mutateResponse?.(endpoint, value); return JSON.stringify(value);
  };
  const output = { schema: 'shipyard.repair-result.v1', id: scope.ticket, pr: 501, status: 'fixed', pushed: false,
    notes: 'Complete original fixture result.', hypothesis: 'The current failure requires the declared source correction.' };
  const options = { scope, graphDir, storageRoot: path.join(signing.directory, 'host-state'), agentDir, agentManifest,
    capabilities: { supportedModels: [first.model], supportedEfforts: ['low', 'high', 'xhigh'] },
    getPullRequest: live, execFileSync(program, args, options) {
      const value = transport(program, args, options);
      if (program === 'gh') responses[JSON.stringify(args)] = Buffer.from(value).toString('base64');
      return value;
    }, verificationAllowList,
    env: { CODEX_HOME: path.join(signing.directory, 'native') },
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: { supportedModels: [first.model], supportedEfforts: ['low', 'high', 'xhigh'] } },
    hostVerificationRunner: { run(spec) {
      const result = require(path.join(scripts, 'command-runner.cjs')).runBounded(spec.executable, spec.argv, { cwd: spec.cwd, timeoutMs: spec.timeoutMs, env: {} });
      return { id: spec.id, status: result.status, signal: result.signal, error_code: result.errorCode, timed_out: result.timedOut,
        stdout_sha256: hash(result.stdout), stderr_sha256: hash(result.stderr), backend: { kind: 'test-host', path: process.execPath, digest: hash('host') }, profile_sha256: hash('profile') };
    } },
    spawn(executable, args, spawnOptions) {
      launches++;
      const session = crypto.randomUUID(), turn = crypto.randomUUID();
      const effort = JSON.parse(args.find(value => value.startsWith('model_reasoning_effort=')).split('=')[1]);
      const applied = { model: args[args.indexOf('--model') + 1], effort };
      selections.push(applied);
      const file = variants.find(variant => variant.effort === effort).file.replace('ci-fix', control.role);
      if (control.source) fs.writeFileSync(path.join(worktree, 'src/owned.txt'), 'fixed\n');
      fs.writeFileSync(path.join(worktree, '.shipyard-repair-evidence.md'), 'Original physical fixture producer evidence.\n');
      const captured = name => fs.readFileSync(path.join(root, 'tests/fixtures/captured', name), 'utf8').trim().split('\n').map(JSON.parse);
      const original = captured('codex-agent-stream-parent.jsonl');
      const nativeMessage = (role, text, phase) => {
        const row = structuredClone(original.find(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === role));
        row.payload.content = [{ ...row.payload.content[0], text }]; row.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
        if (phase) row.payload.phase = phase; return row;
      };
      const final = JSON.stringify(output), user = nativeMessage('user', '');
      const rows = [original.find(row => row.type === 'session_meta'), original.find(row => row.type === 'turn_context'),
        original.find(row => row.payload?.type === 'task_started'), nativeMessage('developer', require(path.join(scripts, 'codex-runtime-host.cjs')).generatedInstructions(fs.readFileSync(path.join(agentDir, file), 'utf8'))),
        user, nativeMessage('assistant', final, 'final_answer'), original.find(row => row.payload?.type === 'task_complete')];
      for (const row of rows) {
        if (row.type === 'session_meta') Object.assign(row.payload, { id: session, session_id: session, cwd: worktree, runtime_workspace_roots: [worktree] });
        if (row.type === 'turn_context') {
          Object.assign(row.payload, { model: applied.model, effort, cwd: worktree, turn_id: turn }); row.payload.sandbox_policy = { type: 'workspace-write' };
          if (row.payload.collaboration_mode?.settings) Object.assign(row.payload.collaboration_mode.settings, { model: applied.model, reasoning_effort: effort });
        }
        if (row.payload?.type === 'task_started') Object.assign(row.payload, { turn_id: turn, root_turn_id: turn });
        if (row.payload?.type === 'task_complete') Object.assign(row.payload, { turn_id: turn, last_agent_message: final });
      }
      const cli = captured('codex-agent-stream-exec.jsonl');
      for (const row of cli) {
        if (row.type === 'thread.started') row.thread_id = session;
        if (row.item?.type === 'agent_message') row.item.text = final;
      }
      const child = new EventEmitter(); child.pid = 45678; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { write(prompt) { user.payload.content = [{ type: 'input_text', text: String(prompt).trim() }]; }, end() {
        process.nextTick(() => {
          const date = new Date(), directory = path.join(spawnOptions.env.CODEX_HOME, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
          fs.mkdirSync(directory, { recursive: true }); control.mutateNative?.(rows, cli);
          fs.writeFileSync(path.join(directory, session + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
          child.stdout.emit('data', Buffer.from(cli.map(JSON.stringify).join('\n') + '\n')); child.emit('close', 0, null);
        });
      } }; return child;
    },
  };
  const request = builder.build(['ci-fix', scope.ticket, '--runtime', 'codex', '--pr', '501', '--failure-file', failureFile], { cwd: worktree, graphDir });
  Object.assign(scope, request.scope);
  const requestFile = path.join(signing.directory, 'request-' + crypto.randomUUID() + '.json'); fs.writeFileSync(requestFile, JSON.stringify(request));
  return { worktree, graphDir, plan, scope, options, request, requestFile, failureFile, failureBytes, originalHead, base, control, output,
    get launches() { return launches; }, get pushes() { return pushes; }, selections, requests,
    async run() {
      deliveryHost.prepareCiRepair(options, scope, request.context);
      if (!options.controller) fixtureController(options, producerScripts);
      return deliveryHost.createCodexDeliveryHost(options).run({ role: request.role, context: request.context });
    },
    cliRun() { return deliveryHost.runCli(['--args-file', requestFile], { write() {} }, options); },
    coldSpec() { return { options: JSON.parse(JSON.stringify(options)), request, responses, live: live(), output }; },
    publish(head) { publishedHead = head; },
    stateRoot: path.join(options.storageRoot, 'finalization', hash(worktree)),
  };
}
function assertCurrent(f, result, consumerScripts = scripts) {
  const input = { role: 'ci-fix', ticket: f.scope.ticket, pr: 501, worktreePath: f.worktree, base: 'main', branch: 'ticket/T-53-31',
    planPath: '.planning/PLAN.md', boundaryStore: result.repair.envelope ? result.repair.manifest?.boundary_store : undefined,
    dispatchId: result.receipt.dispatch_id, artifactPath: result.repair.artifact_ref, artifactDigest: result.repair.artifact_digest,
    historical: Boolean(result.artifact) };
  const files = fs.readdirSync(path.join(f.stateRoot, 'ci-repair-attempts')).map(name => path.join(f.stateRoot, 'ci-repair-attempts', name));
  const attempt = files.map(file => JSON.parse(fs.readFileSync(file)).payload).find(value => value.dispatch_id === result.receipt.dispatch_id);
  input.boundaryStore = attempt.receipt_store;
  const current = require(path.join(consumerScripts, 'role-artifact.cjs')).read(input);
  assert.equal(current.role, 'ci-fix'); assert.equal(current.findings.hypothesis, f.output.hypothesis);
  if (result.artifact) {
    const covered = require(path.join(consumerScripts, 'conveyor-coverage.cjs')).verify({ worktree: f.worktree, repo: 'fixture/repository', commit: result.artifact.commit });
    assert.equal(covered.covered, true, covered.reason); assert.equal(covered.record.kind, 'fixer');
    assert.equal(covered.record.dispatch_id, result.receipt.dispatch_id);
  }
  return input;
}
function fixtureController(options, consumerScripts = scripts) {
  const directory = path.join(options.storageRoot, 'finalization', hash(options.scope.worktree), 'ci-originals');
  const operations = fs.readdirSync(directory).map(name => JSON.parse(fs.readFileSync(path.join(directory, name))).payload)
    .filter(operation => operation.scope.run_id === options.scope.run_id);
  assert.equal(operations.length, 1);
  const operation = operations[0];
  const controller = require(path.join(consumerScripts, 'run-controller.cjs')).createRunController({
    storeDir: path.join(options.storageRoot, 'fixture-controller', hash(options.scope.run_id)) });
  const selected = operation.resolution || policy.resolveDispatch({ runtime: 'codex', role: 'ci-fix', dispatch_id: operation.dispatch_id });
  const persisted = controller.store.get(options.scope.run_id)?.run;
  if (persisted) {
    assert.equal(persisted.run_id, operation.scope.run_id);
    assert.equal(persisted.dispatch.dispatch_id, operation.dispatch_id);
  }
  controller.begin(persisted || require(path.join(consumerScripts, 'run-scope.cjs')).createRunScope({ ...options.scope,
    repository_id: 'git-common:' + hash(git(options.scope.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    owner_id: controller.owner_id, dispatch: { dispatch_id: operation.dispatch_id, role: 'ci-fix',
      model: selected.model, effort: selected.effort, policy_version: selected.policy_version, policy_hash: selected.policy_hash } }));
  controller.assertOwner(options.scope.run_id);
  if (persisted) for (const field of ['repository', 'phase', 'ticket', 'worktree', 'runtime', 'dispatch'])
    assert.deepEqual(controller.store.get(options.scope.run_id).run[field], persisted[field]);
  options.controller = controller;
}
async function coldRecovery(spec, consumerScripts = scripts) {
  const cp = require('node:child_process');
  let launches = 0, pushes = 0, live = spec.live;
  const options = { ...spec.options, getPullRequest() { return live; },
    spawn() { launches++; throw new Error('Original completion must not relaunch'); },
    execFileSync(program, args, options) {
      if (program === 'git' && args[0] === 'push') { pushes++; live = { ...live, headRefOid: git(spec.options.scope.worktree, 'rev-parse', 'HEAD') }; return ''; }
      assert.equal(program, 'gh');
      const encoded = spec.responses[JSON.stringify(args)]; assert.ok(encoded, 'cold fixture admits only original controlled remote queries');
      const bytes = Buffer.from(encoded, 'base64'); return options.encoding === null ? bytes : bytes.toString('utf8');
    },
    hostVerificationRunner: { run(command) {
      const result = require(path.join(consumerScripts, 'command-runner.cjs')).runBounded(command.executable, command.argv,
        { cwd: command.cwd, timeoutMs: command.timeoutMs, env: {} });
      return { id: command.id, status: result.status, signal: result.signal, error_code: result.errorCode, timed_out: result.timedOut,
        stdout_sha256: hash(result.stdout), stderr_sha256: hash(result.stderr), backend: { kind: 'test-host', path: process.execPath, digest: hash('host') }, profile_sha256: hash('profile') };
    } },
  };
  delete options.host; delete options.controller;
  let result;
  try {
    fixtureController(options, consumerScripts);
    result = await require(path.join(consumerScripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options)
      .run({ role: spec.request.role, context: spec.request.context });
  } catch (error) { error.physical_launches = launches; error.publication_calls = pushes; throw error; }
  finally { options.controller?.release(options.scope.run_id); }
  assertCurrent({ scope: options.scope, worktree: options.scope.worktree, output: spec.output,
    stateRoot: path.join(options.storageRoot, 'finalization', hash(options.scope.worktree)) }, result, consumerScripts);
  assert.equal(launches, 0); return { result, launches, pushes };
}
if (require.main === module) {
  test('new default CI originals retain canonical repository identity through shared default and origin coverage readers', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing, { declaredRepo: null });
      git(f.worktree, 'remote', 'add', 'origin', 'git@github.com:fixture/repository.git');
      const result = await f.run();
      const repository = coverage.repositoryIdentity(f.worktree);
      for (const repo of [undefined, repository, 'fixture/repository']) {
        const checked = coverage.verify({ commit: result.artifact.commit, repo, worktree: f.worktree });
        assert.equal(checked.covered, true, checked.reason);
        assert.equal(checked.record.repo, repository);
        assert.equal(checked.record.repository_id, repository);
        assert.equal(checked.record.dispatch_id, result.receipt.dispatch_id);
        assert.deepEqual(coverage.chain({ repo, worktreeOrCheckout: f.worktree, base: f.originalHead,
          head: result.artifact.commit }), { covered: true, links: ['fixer'] });
      }
      const original = fs.readdirSync(path.join(f.stateRoot, 'ci-originals')).map(file =>
        JSON.parse(fs.readFileSync(path.join(f.stateRoot, 'ci-originals', file))).payload)[0];
      assert.equal(original.preparation.repo, null);
      assert.equal(original.preparation.repair.feedback.repository, 'fixture/repository');
      assert.equal((await f.run()).receipt.dispatch_id, result.receipt.dispatch_id);
      assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
      assert.equal(coverage.verify({ commit: result.artifact.commit, repo: 'foreign/repository', worktree: f.worktree }).covered, false);
    } finally { signing.close(); }
  });
  test('genuine historical remote CI coverage admits the following default review source transition without rewriting custody', bounded, async () => {
    const signing = signingFixture();
    try {
      const producerScripts = historicalCiScripts(path.join(signing.directory, 'historical-ci-scripts'));
      const producer = require(path.join(producerScripts, 'codex-delivery-host.cjs'));
      const f = ciFixture(signing, { declaredRepo: null, producerScripts });
      git(f.worktree, 'remote', 'add', 'origin', 'https://github.com/fixture/repository.git');
      const manifest = JSON.parse(fs.readFileSync(f.options.agentManifest));
      const ciAgent = 'shipyard-ci-fix.toml', reviewAgent = 'shipyard-review-fix.toml';
      const content = fs.readFileSync(path.join(f.options.agentDir, ciAgent), 'utf8').replaceAll('ci-fix', 'review-fix');
      fs.writeFileSync(path.join(f.options.agentDir, reviewAgent), content);
      manifest.agent_files.push(reviewAgent); manifest.agent_digests[reviewAgent] = hash(content);
      fs.writeFileSync(f.options.agentManifest, JSON.stringify(manifest));
      const actor = { __typename: 'User', id: 'original-host-user', login: 'delivery-host' }, replies = [];
      const transport = f.options.execFileSync;
      f.options.execFileSync = (program, args, options) => {
        if (program === 'gh' && args[0] === 'pr') return JSON.stringify({ id: 'pr-body-501' });
        const query = args.find(arg => arg.startsWith('query='));
        if (program !== 'gh' || !query) return transport(program, args, options);
        const value = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
        let data;
        if (query.includes('viewer{id login}')) data = { viewer: actor };
        else if (query.includes('addComment(input:')) {
          const comment = { id: 'original-host-reply', body: value('body'), author: actor }; replies.push(comment);
          data = { addComment: { commentEdge: { node: comment } } };
        } else if (query.includes('{id body title}')) data = { repository: { pullRequest: {
          id: 'pr-body-501', body: 'Original full PR finding', title: 'Original PR' } } };
        else {
          const field = query.includes('reviewThreads(') ? 'reviewThreads' : query.includes('reviews(') ? 'reviews' : 'comments';
          data = { repository: { pullRequest: { [field]: { nodes: field === 'comments' ? replies : [],
            pageInfo: { hasNextPage: false, endCursor: null } } } } };
        }
        return JSON.stringify({ data });
      };
      const reviewDirectory = path.join(f.worktree, '.shipyard-role-artifacts', 'review-inputs');
      fs.mkdirSync(reviewDirectory, { recursive: true });
      const reviewFile = path.join(reviewDirectory, 'original-review.md'); fs.writeFileSync(reviewFile, 'Complete original review.');
      const review = builder.build(['review-fix', f.scope.ticket, '--runtime', 'codex', '--pr', '501', '--review-file', reviewFile],
        { cwd: f.worktree, graphDir: f.graphDir });
      f.control.role = 'review-fix'; f.control.source = false; f.output.status = 'no-op';
      f.output.review_dispositions = [{ id: 'pr-body-501', action: 'reply', reply: 'Retain original reviewed finding.',
        evidence: { command: 'inspect original', result: 'Complete original evidence inspected.' } }];
      const first = await producer.createCodexDeliveryHost(f.options).run({ role: review.role, context: review.context });
      assert.equal(first.receipt.role, 'review-fix'); assert.equal(replies.length, 1);
      const actionsDirectory = path.join(f.stateRoot, 'repair-actions');
      const actions = fs.readdirSync(actionsDirectory).map(name => ({ file: path.join(actionsDirectory, name),
        bytes: fs.readFileSync(path.join(actionsDirectory, name)) }));
      delete f.output.review_dispositions; f.control.role = 'ci-fix'; f.control.source = true; f.output.status = 'fixed';
      const result = await f.run();
      const commit = result.artifact.commit, repository = coverage.repositoryIdentity(f.worktree);
      const coverageFile = path.join(process.env.SHIPYARD_COVERAGE_ROOT, 'coverage', encodeURIComponent('fixture/repository'), commit + '.json');
      const bytes = fs.readFileSync(coverageFile);
      for (const repo of [undefined, repository, 'fixture/repository']) {
        const checked = coverage.verify({ worktree: f.worktree, commit, repo });
        assert.equal(checked.covered, true, checked.reason); assert.equal(checked.record.repo, 'fixture/repository');
        assert.equal(checked.record.ticket, f.scope.ticket); assert.equal(checked.record.dispatch_id, result.receipt.dispatch_id);
        assert.equal(checked.record.receipt_digest, hash(stable(result.receipt)));
        assert.deepEqual(checked.record.parents, [f.originalHead]); assert.equal(checked.record.tree, result.artifact.tree);
        assert.deepEqual(coverage.chain({ repo, worktreeOrCheckout: f.worktree, base: f.originalHead, head: commit }),
          { covered: true, links: ['fixer'] });
      }
      f.options.controller.release(f.scope.run_id, 'fixture following review'); delete f.options.controller;
      const prepared = host.prepareRepair(f.options, f.scope, review.context);
      assert.equal(prepared.repo, null);
      assert.equal(prepared.repair.actionable_feedback.coverage.length, 1);
      const transition = host.repairCoverageTransition(prepared.repair.actionable_feedback.coverage[0],
        prepared.repair.actionable_feedback);
      assert.equal(transition.historical, true); assert.equal(transition.semantic_credit, false);
      assert.equal(transition.source_transition.from, f.originalHead); assert.equal(transition.source_transition.to, commit);
      assert.equal(f.launches, 2); assert.equal(f.pushes, 1); assert.equal(replies.length, 1);
      assert.deepEqual(fs.readFileSync(coverageFile), bytes);
      for (const action of actions) assert.deepEqual(fs.readFileSync(action.file), action.bytes);
    } finally { signing.close(); }
  });
  test('builder and CLI bind real CI through original recorder, signed fixer and independent current reader', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing);
      const parsed = host.readRequestFile(f.requestFile); assert.equal(parsed.launch.role, 'ci-fix'); assert.equal(parsed.graphDir, f.graphDir);
      assert.equal(f.request.context.evidence_sha256, hash(f.failureBytes)); assert.equal(f.request.context.prompt, undefined);
      const result = await f.cliRun();
      assert.equal(f.launches, 1); assert.equal(f.pushes, 1); assert.deepEqual(f.selections, [{ model: 'gpt-6.1-sol', effort: 'low' }]);
      assert.equal(result.receipt.role, 'ci-fix'); assert.equal(result.repair_result.review_dispositions, undefined);
      assert.equal(result.artifact.status, 'committed'); assert.equal(result.actions.status, 'not-applicable');
      assert.equal(result.publication.status, 'confirmed');
      assert.equal(result.publication.transition.from, f.originalHead);
      assert.equal(result.publication.transition.to, result.artifact.commit);
      assert.equal(f.requests.some(row => row.args.some(arg =>
        arg.includes(`/commits/${result.artifact.commit}/check-runs?`))), false);
      assert.equal(git(f.worktree, 'show', '-s', '--format=%P', 'HEAD'), f.originalHead);
      git(f.worktree, 'verify-commit', result.artifact.commit);
      const checked = coverage.verify({ commit: result.artifact.commit, repo: 'fixture/repository', worktree: f.worktree });
      assert.equal(checked.covered, true, checked.reason); assert.equal(checked.record.kind, 'fixer');
      const input = assertCurrent(f, result);
      const cold = spawnSync(process.execPath, ['-e', 'const a=require(process.argv[1]); const r=a.read(JSON.parse(process.argv[2])); if(r.role!=="ci-fix")process.exit(1);', path.join(scripts, 'role-artifact.cjs'), JSON.stringify(input)],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(cold.status, 0, cold.stderr);
      const original = boundary.createDurableRecorder(input.boundaryStore).getVerifiedRecord(result.receipt.dispatch_id);
      assert.equal(original.receipt.runtime_evidence.session_id, result.receipt.runtime_evidence.session_id);
      assert.equal(original.resolution.signals.signatureState, 'first');
      assert.equal(f.requests.some(row => row.args.some(arg => /graphql|reviewThreads|addComment|resolveReview/.test(arg))), false);
    } finally { signing.close(); }
  });
}
module.exports = { root, scripts, hash, stable, git, historicalCiScripts, signingFixture, ciFixture, assertCurrent, coldRecovery, fixtureController, bounded };
