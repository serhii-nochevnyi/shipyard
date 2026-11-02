'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { root, scripts, hash, git, signingFixture, ciFixture, assertCurrent, bounded } = require('./phase53-z29x-native-ci-fix-contract.test.cjs');
const host = require(path.join(scripts, 'codex-delivery-host.cjs'));
const boundary = require(path.join(scripts, 'dispatch-boundary.cjs'));
const identities = ['.codex-plugin/plugin.json', 'package-build.json'];
function inventory(directory) {
  const entries = [];
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), relative = prefix + name;
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 }); visit(file, relative + '/'); }
      else { assert.equal(stat.isFile(), true); entries.push({ path: relative, type: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: hash(fs.readFileSync(file)) }); }
    }
  };
  visit(directory, ''); return entries;
}
function verifyPackage(directory) {
  const entries = inventory(directory), crypto = require('node:crypto'), digest = crypto.createHash('sha256');
  for (const entry of entries) if (entry.type === 'file' && !identities.includes(entry.path)) {
    digest.update(entry.path + '\0'); digest.update(fs.readFileSync(path.join(directory, entry.path)));
  }
  const source = digest.digest('hex'), plugin = JSON.parse(fs.readFileSync(path.join(directory, identities[0])));
  const build = JSON.parse(fs.readFileSync(path.join(directory, identities[1])));
  assert.ok(plugin.version.endsWith('+codex.' + source.slice(0, 16)));
  assert.equal(build.version, plugin.version);
  assert.equal(build.digest, crypto.createHash('sha256').update(source).update('\0').update(fs.readFileSync(path.join(directory, identities[0]))).digest('hex'));
  return entries;
}
function verifySourceMirrors(source, destination) {
  for (const entry of inventory(destination)) {
    if (entry.type !== 'file' || !entry.path.startsWith('host/')) continue;
    const original = path.join(source, entry.path.slice(5));
    assert.equal(fs.lstatSync(original).isFile(), true);
    assert.equal(hash(fs.readFileSync(original)), entry.sha256, 'whole mirrored source entry: ' + entry.path);
    if (!entry.path.startsWith('host/scripts/')) assert.equal(fs.statSync(original).mode & 0o777, entry.mode);
  }
}
function packageSource(directory) {
  for (const relative of ['scripts', 'plugins/delivery-pipeline', 'capabilities/delivery-pipeline']) {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.cpSync(path.join(root, relative), path.join(directory, relative), { recursive: true });
  }
  const build = spawnSync(process.execPath, [path.join(directory, 'scripts/package-shipyard-codex.cjs')],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(build.status, 0, build.stderr);
  return path.join(directory, 'plugins/shipyard');
}
function originalOperation(f) {
  const directory = path.join(f.stateRoot, 'ci-originals');
  const operations = fs.readdirSync(directory).map(name => {
    const file = path.join(directory, name); return { file, envelope: JSON.parse(fs.readFileSync(file)) };
  }).filter(({ envelope }) => ['plan_sha256', 'pr', 'evidence_path', 'evidence_sha256']
    .every(key => envelope.payload.selectors[key] === f.request.context[key]));
  assert.equal(operations.length, 1); return operations[0];
}
function coldOriginal(f, installed, expectedError, expectedPushes = 1) {
  f.options.controller.release(f.scope.run_id, 'fixture cold original host handoff');
  const child = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).coldRecovery(JSON.parse(process.argv[2]),process.argv[3]).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{process.stdout.write(JSON.stringify({error:e.code,launches:e.physical_launches,pushes:e.publication_calls}));console.error(e);process.exitCode=1;});',
    path.join(__dirname, 'phase53-z29x-native-ci-fix-contract.test.cjs'), JSON.stringify(f.coldSpec()), path.join(installed, 'host/plugins/delivery-pipeline/scripts')],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, expectedError ? 1 : 0, child.stderr + child.stdout);
  const recovered = JSON.parse(child.stdout);
  if (expectedError) {
    assert.deepEqual(recovered, { error: expectedError, launches: 0, pushes: 0 }); return null;
  }
  assert.equal(recovered.launches, 0); assert.equal(recovered.pushes, expectedPushes);
  f.publish(recovered.result.artifact.commit);
  return recovered.result;
}
if (require.main === module) {
  test('CI candidate association recovers admission and finalization crashes through the original cold operation', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'candidate-crash-package'));
      verifyPackage(installed);
      for (const point of ['admitted', 'finalized', 'signed-result', 'cli', 'candidate-only', 'tampered-candidate', 'tampered-association', 'tampered-coverage']) await t.test(point, bounded, async () => {
        const f = ciFixture(signing), rename = fs.renameSync;
        let interrupted = false;
        fs.renameSync = (source, destination, ...args) => {
          if (!interrupted && point === 'signed-result' && destination.includes('ci-originals')
              && JSON.parse(fs.readFileSync(source)).payload.signed_result) {
            interrupted = true; throw new Error('fixture candidate crash');
          }
          const value = rename(source, destination, ...args);
          if (!interrupted && (((['finalized', 'cli', 'candidate-only'].includes(point) || point.startsWith('tampered-')) && destination.includes(path.sep + 'finalized' + path.sep))
              || (point === 'admitted' && destination.includes('ci-originals')
                && JSON.parse(fs.readFileSync(destination)).payload.candidate_result))) {
            interrupted = true; throw new Error('fixture candidate crash');
          }
          return value;
        };
        try { await assert.rejects(f.run, /fixture candidate crash/); }
        finally { fs.renameSync = rename; }
        assert.equal(interrupted, true);
        const original = originalOperation(f).envelope.payload;
        assert.ok(original.candidate_result.candidate_id);
        assert.equal(original.signed_result, undefined);
        assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        if (point.startsWith('tampered-')) {
          const files = {
            'tampered-candidate': path.join(f.stateRoot, 'candidates', original.candidate_result.candidate_id + '.json'),
            'tampered-association': originalOperation(f).file,
            'tampered-coverage': path.join(process.env.SHIPYARD_COVERAGE_ROOT, 'coverage', encodeURIComponent('fixture/repository'),
              git(f.worktree, 'rev-parse', 'HEAD') + '.json'),
          };
          fs.appendFileSync(files[point], '\nforeign state');
          f.options.controller.release(f.scope.run_id, 'candidate tamper cold handoff');
          const child = spawnSync(process.execPath, ['-e',
            'require(process.argv[1]).coldRecovery(JSON.parse(process.argv[2]),process.argv[3]).then(()=>process.exitCode=2).catch(e=>process.stdout.write(JSON.stringify({launches:e.physical_launches,pushes:e.publication_calls})));',
            path.join(__dirname, 'phase53-z29x-native-ci-fix-contract.test.cjs'), JSON.stringify(f.coldSpec()),
            path.join(installed, 'host/plugins/delivery-pipeline/scripts')],
            { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
          assert.equal(child.status, 0, child.stderr + child.stdout);
          assert.deepEqual(JSON.parse(child.stdout), { launches: 0, pushes: 0 });
          assert.equal(git(f.worktree, 'rev-list', '--count', `${f.originalHead}..HEAD`), '1');
          return;
        }
        let recovered;
        if (point === 'cli') recovered = await f.cliRun();
        else if (point === 'candidate-only') {
          await host.createFinalizationRecoveryHost(f.options).resumeFinalization(original.candidate_result.candidate_id, f.scope);
          recovered = originalOperation(f).envelope.payload.result;
        } else recovered = coldOriginal(f, installed);
        const finished = originalOperation(f).envelope.payload;
        assert.equal(finished.state, 'finished');
        assert.equal(finished.dispatch_id, original.dispatch_id);
        assert.equal(finished.completed.session_id, original.completed.session_id);
        assert.equal(finished.signed_result.artifact.candidate_id, original.candidate_result.candidate_id);
        assert.equal(git(f.worktree, 'rev-list', '--count', `${f.originalHead}..HEAD`), '1');
        assertCurrent(f, recovered);
        assert.deepEqual(coldOriginal(f, installed, undefined, 0), recovered);
      });
    } finally { signing.close(); }
  });
  test('finished signed CI originals return under green, pending and lost successful return with no fresh work', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'finished-original-package')); verifyPackage(installed);
      for (const phase of ['green', 'pending', 'lost-return']) await t.test(phase, bounded, async () => {
        const f = ciFixture(signing), rename = fs.renameSync;
        let lost = false, result;
        if (phase === 'lost-return') fs.renameSync = (source, destination, ...args) => {
          const value = rename(source, destination, ...args);
          if (!lost && destination.includes('ci-originals') && destination.endsWith('.json')
              && JSON.parse(fs.readFileSync(destination)).payload.state === 'finished') {
            lost = true; throw new Error('fixture lost successful original return');
          }
          return value;
        };
        try {
          if (phase === 'lost-return') await assert.rejects(f.run, /lost successful original return/);
          else result = await f.run();
        } finally { fs.renameSync = rename; }
        const retained = originalOperation(f).envelope.payload;
        assert.equal(retained.state, 'finished'); result ||= retained.result;
        f.control.mutateResponse = (endpoint, rows) => {
          if (endpoint.includes('/check-runs?')) Object.assign(rows[0].check_runs[0], {
            status: phase === 'pending' ? 'in_progress' : 'completed', conclusion: phase === 'pending' ? null : 'success' });
        };
        const requests = f.requests.length, head = git(f.worktree, 'rev-parse', 'HEAD');
        const warm = await f.run();
        assert.deepEqual(warm, JSON.parse(JSON.stringify(result))); assert.equal(f.requests.length, requests);
        const recovered = coldOriginal(f, installed, undefined, 0);
        assert.deepEqual(recovered, JSON.parse(JSON.stringify(result)));
        assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), head);
        assert.equal(git(f.worktree, 'rev-list', '--count', `${f.originalHead}..HEAD`), '1');
        assertCurrent(f, recovered);
      });
    } finally { signing.close(); }
  });
  test('finished unsigned CI results acknowledge green and pending checks through the terminal CLI', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const status of ['no-op', 'escalate']) for (const observation of ['green', 'pending', 'invalid'])
        await t.test(`${status}:${observation}`, bounded, async () => {
          const f = ciFixture(signing);
          f.control.source = false; f.output.status = status;
          const result = await f.cliRun();
          const retained = originalOperation(f).envelope.payload;
          assert.equal(retained.state, 'finished'); assert.equal(retained.signed_result, undefined);
          f.control.mutateResponse = (endpoint, rows) => {
            if (endpoint.includes('/check-runs?')) {
              Object.assign(rows[0].check_runs[0], { status: observation === 'pending' ? 'in_progress' : 'completed',
                conclusion: observation === 'pending' ? null : 'success' });
              if (observation === 'invalid') rows[0].check_runs[0].head_sha = '0'.repeat(40);
            }
          };
          if (observation === 'invalid') await assert.rejects(f.cliRun);
          else {
            assert.deepEqual(await f.cliRun(), JSON.parse(JSON.stringify(result)));
            const request = JSON.parse(fs.readFileSync(f.requestFile));
            request.scope.run_id = 'fresh-ack-' + require('node:crypto').randomUUID();
            fs.writeFileSync(f.requestFile, JSON.stringify(request));
            assert.deepEqual(await f.cliRun(), JSON.parse(JSON.stringify(result)));
          }
          assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
          assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
          assert.equal(originalOperation(f).envelope.payload.dispatch_id, retained.dispatch_id);
        });
    } finally { signing.close(); }
  });
  test('signed low and high source transitions admit the authenticated xhigh successor', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing), dispatches = [], heads = [f.originalHead];
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (f.options.controller) {
          f.options.controller.release(f.scope.run_id, 'fixture signed predecessor handoff'); delete f.options.controller;
        }
        if (attempt > 1) {
          const failureFile = path.join(signing.directory, 'successor-' + require('node:crypto').randomUUID() + '.log');
          fs.writeFileSync(failureFile, f.failureBytes, { mode: 0o600 });
          const request = require(path.join(scripts, 'deliver-dispatch.cjs')).build(['ci-fix', f.scope.ticket,
            '--runtime', 'codex', '--pr', '501', '--failure-file', failureFile], { cwd: f.worktree, graphDir: f.graphDir });
          Object.assign(f.scope, request.scope); Object.assign(f.request, request);
          fs.writeFileSync(f.requestFile, JSON.stringify(request));
        }
        f.control.runAttempt = attempt;
        f.control.mutateNative = () => fs.chmodSync(path.join(f.worktree, 'src/owned.txt'), attempt === 2 ? 0o755 : 0o644);
        const result = await f.run();
        assert.equal(result.receipt.applied_effort, ['low', 'high', 'xhigh'][attempt - 1]);
        const original = originalOperation(f).envelope.payload;
        assert.equal(original.predecessor_dispatch_id, dispatches.at(-1) || null);
        assert.equal(git(f.worktree, 'show', '-s', '--format=%P', result.artifact.commit), heads.at(-1));
        dispatches.push(result.receipt.dispatch_id); heads.push(result.artifact.commit);
        assertCurrent(f, result);
      }
      assert.equal(new Set(dispatches).size, 3); assert.equal(new Set(heads).size, 4);
      assert.equal(f.launches, 3); assert.equal(f.pushes, 3);
    } finally { signing.close(); }
  });
  test('finished CI originals refuse changed signed head, receipt, coverage, graph, signer, publication and source without replay', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'finished-refusal-package'));
      for (const mutation of ['head', 'receipt', 'coverage', 'graph', 'signer', 'publication', 'source', 'HOST']) await t.test(mutation, bounded, async () => {
        const f = ciFixture(signing), result = await f.run(), op = originalOperation(f).envelope.payload;
        const artifact = result.artifact, candidateFile = path.join(f.stateRoot, 'candidates', artifact.candidate_id + '.json');
        const candidate = JSON.parse(fs.readFileSync(candidateFile)).payload;
        const files = {
          receipt: path.join(op.receipt_store, 'record-' + hash(op.dispatch_id) + '.json'),
          coverage: path.join(process.env.SHIPYARD_COVERAGE_ROOT, 'coverage', encodeURIComponent('fixture/repository'), artifact.commit + '.json'),
          graph: path.join(f.graphDir, 'tickets.json'),
          publication: path.join(f.stateRoot, 'repair-publications', artifact.candidate_id + '.json'),
          source: path.join(f.worktree, 'src/owned.txt'),
          HOST: path.join(f.stateRoot, 'verification', candidate.verification.evidence_digest + '.json'),
        };
        if (mutation === 'head') f.publish(f.originalHead);
        else if (mutation === 'signer') git(f.worktree, 'config', 'user.signingkey', '0'.repeat(40));
        else fs.appendFileSync(files[mutation], '\nforeign state');
        f.options.controller.release(f.scope.run_id, 'finished original refusal handoff');
        const child = spawnSync(process.execPath, ['-e',
          'require(process.argv[1]).coldRecovery(JSON.parse(process.argv[2]),process.argv[3]).then(()=>process.exitCode=2).catch(e=>{process.stdout.write(JSON.stringify({launches:e.physical_launches,pushes:e.publication_calls}));});',
          path.join(__dirname, 'phase53-z29x-native-ci-fix-contract.test.cjs'), JSON.stringify(f.coldSpec()), path.join(installed, 'host/plugins/delivery-pipeline/scripts')],
          { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr + child.stdout);
        assert.deepEqual(JSON.parse(child.stdout), { launches: 0, pushes: 0 });
        assert.equal(f.launches, 1); assert.equal(f.pushes, 1); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), artifact.commit);
      });
    } finally { signing.close(); }
  });
  test('public review repair preserves complete prepublication operational history without predecessor or effort credit', bounded, async t => {
    const signing = signingFixture();
    try {
      const { createDeliveryFixture } = require('./helpers/phase53-delivery-fixture.cjs');
      const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');
      for (const variant of ['current', 'prepublication', 'both', 'foreign-pr', 'foreign-negative', 'attempt', 'fix_round', 'unknown-role',
        'missing-reason', 'empty-reason', 'malformed-ts', 'foreign-by', 'unsigned-native', 'extra-field']) await t.test(variant, bounded, async () => {
        const context = createDeliveryFixture({ temporary: signing.directory, signer: signing.signer });
        const valid = ['current', 'prepublication', 'both'].includes(variant);
        let journal, bytes, launches = 0, completed = 0;
        const preparedContext = { ...context, fixture(...args) {
          const f = context.fixture(...args);
          const row = { ts: '2026-11-01T22:33:28.625Z', event: 'escalation', ticket: f.scope.ticket, pr: null,
            reason: 'Environment blocked: original operation parked before publication', by: 'escalation-record' };
          if (variant === 'current') row.pr = 501;
          if (variant === 'foreign-pr') row.pr = 502;
          if (variant === 'foreign-negative') row.pr = -1;
          if (['attempt', 'fix_round'].includes(variant)) row.event = variant;
          if (variant === 'unknown-role') row.role = 'unknown-repair-role';
          if (variant === 'missing-reason') delete row.reason;
          if (variant === 'empty-reason') row.reason = ' ';
          if (variant === 'malformed-ts') row.ts = '2026-11-01';
          if (variant === 'foreign-by') row.by = 'native-agent';
          if (variant === 'unsigned-native') Object.assign(row, { role: 'review-fix', native_status: 'completed' });
          if (variant === 'extra-field') row.model = 'gpt-6.1-sol';
          journal = path.join(f.graphDir, 'delivery-log.jsonl');
          bytes = Buffer.from([row, ...(variant === 'both' ? [{ ...row, pr: 501 }] : [])].map(JSON.stringify).join('\n') + '\n');
          fs.writeFileSync(journal, bytes); return f;
        }, createCodexDeliveryHost(options) {
          const originalSpawn = options.spawn;
          const actual = context.createCodexDeliveryHost({ ...options, spawn(...args) { launches++; return originalSpawn(...args); } });
          return { ...actual, async run(request) {
            const result = await actual.run(request); completed++;
            assert.equal(result.receipt.applied_effort, 'low');
            assert.equal(result.resolution.signals.signatureState, 'first');
            assert.equal(result.resolution.prior_applied, undefined);
            assert.deepEqual(fs.readFileSync(journal), bytes);
            return result;
          } };
        }, clean(f) {
          assert.deepEqual(fs.readFileSync(journal), bytes); context.clean(f);
        } };
        const run = () => context.withGraphDirEnv(undefined, () => createOriginalFixerFixture(preparedContext)('no-op'));
        if (valid) { await run(); assert.equal(launches, 1); assert.equal(completed, 1); }
        else { await assert.rejects(run, { code: 'REPAIR_PREDECESSOR_INVALID' }); assert.equal(launches, 0); assert.equal(completed, 0); }
      });
    } finally { signing.close(); }
  });
  test('CI independently refuses foreign selectors, physical failure substitutions and incompatible checked jobs before launch', bounded, async t => {
    const signing = signingFixture();
    try {
      const cases = [
        ['wrong plan', f => { f.request.context.plan_sha256 = '0'.repeat(64); }],
        ['wrong PR', f => { f.request.context.pr = 502; }],
        ['caller rung', f => { f.request.signals = { signatureState: 'repeat' }; }],
        ['caller prompt', f => { f.request.context.prompt = 'Forged authority'; }],
        ['same length', f => fs.writeFileSync(f.failureFile, Buffer.alloc(f.failureBytes.length, 120))],
        ['growth', f => fs.appendFileSync(f.failureFile, 'x')],
        ['truncation', f => fs.truncateSync(f.failureFile, 1)],
        ['empty', f => fs.truncateSync(f.failureFile, 0)],
        ['missing', f => fs.unlinkSync(f.failureFile)],
        ['directory', f => { fs.unlinkSync(f.failureFile); fs.mkdirSync(f.failureFile); }],
        ['symlink', f => { fs.unlinkSync(f.failureFile); fs.symlinkSync(f.plan, f.failureFile); }],
        ['overflow', f => fs.writeFileSync(f.failureFile, Buffer.alloc(8 * 1024 * 1024 + 1))],
        ['foreign head', f => { f.options.getPullRequest = () => ({ number: 501, state: 'OPEN', headRefOid: '0'.repeat(40) }); }],
        ['closed PR', f => { const live = f.options.getPullRequest; f.options.getPullRequest = () => ({ ...live(), state: 'CLOSED' }); }],
        ['foreign remote checked head', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.endsWith('/pulls/501')) value.head.sha = '0'.repeat(40); }; }],
        ['foreign run head', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/actions/runs/')) value.head_sha = '0'.repeat(40); }; }],
        ['unavailable job', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/actions/runs/')) value.workflow_id = null; }; }],
        ['pending check', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/check-runs?')) value[0].check_runs[0].status = 'in_progress'; }; }],
        ['cancelled check', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/check-runs?')) value[0].check_runs[0].conclusion = 'cancelled'; }; }],
        ['empty checks', f => { f.control.mutateResponse = (endpoint, value) => { if (endpoint.includes('/check-runs?')) { value[0].total_count = 0; value[0].check_runs = []; } }; }],
      ];
      for (const [name, mutate] of cases) await t.test(name, bounded, async () => {
        const f = ciFixture(signing); mutate(f);
        await assert.rejects(() => host.createCodexDeliveryHost(f.options).run({ role: 'ci-fix', context: f.request.context, signals: f.request.signals }));
        assert.equal(f.launches, 0); assert.equal(f.pushes, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
      });
      const f = ciFixture(signing), prepared = host.prepareCiRepair(f.options, f.scope, f.request.context);
      for (const mutation of ['bytes', 'mode', 'attempt', 'job']) {
        const mode = fs.statSync(f.failureFile).mode & 0o777;
        if (mutation === 'bytes') fs.writeFileSync(f.failureFile, Buffer.alloc(f.failureBytes.length, 120));
        if (mutation === 'mode') fs.chmodSync(f.failureFile, 0o644);
        if (mutation === 'attempt') f.control.runAttempt++;
        if (mutation === 'job') f.control.jobId = '99';
        assert.throws(() => host.recheckRepair(prepared, f.options));
        fs.writeFileSync(f.failureFile, f.failureBytes); fs.chmodSync(f.failureFile, mode);
        f.control.runAttempt = 1; f.control.jobId = '43';
        host.recheckRepair(prepared, f.options);
      }
      for (const handle of [{}, Object.freeze(Object.create(null)), JSON.parse(JSON.stringify(originalOperation(f).envelope.payload))])
        assert.throws(() => host.validateOriginalCiOperation(handle, 'recover', { dispatch_id: 'copied', ticket: 'T-53-31', runtime: 'codex', role: 'ci-fix' }), { code: 'CI_ORIGINAL_INVALID' });
    } finally { signing.close(); }
  });
  test('original CI record/index/finalize recovery retains one native session and reaches signed current consumption', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const phase of ['native-completed', 'record', 'index', 'finalized-index', 'acknowledged', 'ack']) await t.test(phase, bounded, async () => {
        const f = ciFixture(signing), originalRename = fs.renameSync, originalLink = fs.linkSync;
        let injected = false;
        const inject = destination => {
          const name = path.basename(destination);
          const target = phase === 'record' ? name.startsWith('record-') : phase === 'index' ? name.startsWith('latest-')
            : phase === 'finalized-index' ? name.startsWith('latest-') && fs.existsSync(destination) : false;
          if (!injected && target) { injected = true; throw new Error('original fixture interruption at ' + phase); }
        };
        fs.linkSync = (source, destination, ...args) => { inject(destination); return originalLink(source, destination, ...args); };
        fs.renameSync = (source, destination, ...args) => {
          inject(destination);
          const result = originalRename(source, destination, ...args);
          if (!injected && destination.includes('ci-originals') && destination.endsWith('.json')) {
            const operation = JSON.parse(fs.readFileSync(destination)).payload;
            if ((phase === 'native-completed' && operation.completed && operation.output)
                || (phase === 'acknowledged' && operation.state === 'acknowledged')) {
              injected = true; throw new Error('original fixture interruption at ' + phase);
            }
          }
          return result;
        };
        try {
          if (phase === 'ack') {
            f.control.failPush = true;
            await assert.rejects(f.run, { code: 'REPAIR_PUBLICATION_PENDING' });
          } else await assert.rejects(f.run);
        } finally { fs.renameSync = originalRename; fs.linkSync = originalLink; }
        const before = originalOperation(f).envelope.payload;
        assert.equal(f.launches, 1); assert.ok(before.completed.session_id);
        if (phase === 'native-completed') {
          assert.equal(injected, true);
          const recorder = boundary.createDurableRecorder(before.receipt_store);
          assert.equal(recorder.getOriginalDispatch(before.dispatch_id).record, undefined);
          assert.equal(recorder.getVerifiedRecord(before.dispatch_id), null);
        }
        if (phase === 'ack') {
          await assert.rejects(f.run, { code: 'REPAIR_PUBLICATION_PENDING' }); assert.equal(f.pushes, 1);
          f.publish(git(f.worktree, 'rev-parse', 'HEAD'));
        }
        let result;
        if (phase !== 'ack') {
          const installed = packageSource(path.join(signing.directory, 'cold-original-package')); verifyPackage(installed);
          result = coldOriginal(f, installed);
          assert.equal(f.pushes, 0);
        } else { result = await f.run(); assert.equal(f.pushes, 1); }
        assert.equal(f.launches, 1);
        assert.equal(result.receipt.dispatch_id, before.dispatch_id);
        assert.equal(result.receipt.runtime_evidence.session_id, before.completed.session_id);
        assertCurrent(f, result);
        const retained = boundary.createDurableRecorder(before.receipt_store).getVerifiedRecord(before.dispatch_id);
        assert.equal(retained.receipt.receipt_type, 'adr-014.application');
        assert.equal(retained.receipt.policy_hash, before.resolution.policy_hash);
        assert.equal(retained.receipt.agent_file_digest, before.native_custody.agent_file_digest);
        assert.ok(retained.trace.some(row => row.stage === 'receipt' && row.status === 'passed'));
        assert.equal(originalOperation(f).envelope.payload.state, 'finished');
      });
    } finally { signing.close(); }
  });
  test('completed operation authentication refuses changed native, policy and subject bytes before cold recovery', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing), link = fs.linkSync;
      fs.linkSync = (source, destination, ...args) => {
        if (path.basename(destination).startsWith('record-')) throw new Error('fixture before original record');
        return link(source, destination, ...args);
      };
      try { await assert.rejects(f.run); } finally { fs.linkSync = link; }
      const { file, envelope } = originalOperation(f), bytes = fs.readFileSync(file);
      assert.ok(envelope.payload.completed.runtime_evidence.native_session_evidence.sha256);
      assert.equal(envelope.payload.completed.session_id, envelope.payload.completed.runtime_evidence.session_id);
      for (const mutate of [
        value => { value.completed.last_agent_message = 'foreign completion'; },
        value => { value.completed.runtime_evidence.session_id = 'foreign session'; },
        value => { value.resolution.effort = 'xhigh'; },
        value => { value.preparation.commit.ticket = 'T-53-30'; },
        value => { value.dispatch_id = 'copied-original'; },
      ]) {
        const changed = structuredClone(envelope); mutate(changed.payload);
        fs.writeFileSync(file, JSON.stringify(changed));
        await assert.rejects(f.run, { code: 'STATE_RECORD_INVALID' });
        assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        fs.writeFileSync(file, bytes);
      }
      const installed = packageSource(path.join(signing.directory, 'authenticated-original-package'));
      const result = coldOriginal(f, installed);
      assert.equal(result.receipt.dispatch_id, envelope.payload.dispatch_id);
      assert.equal(result.receipt.runtime_evidence.session_id, envelope.payload.completed.session_id);
      assert.equal(f.launches, 1); assertCurrent(f, result);
    } finally { signing.close(); }
  });
  test('original record, index and rollback authentication failures remain intact and cannot be overwritten by recovery', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing), rename = fs.renameSync;
      let interrupted = false;
      fs.renameSync = (source, destination, ...args) => {
        const result = rename(source, destination, ...args);
        if (!interrupted && path.basename(destination).startsWith('latest-')) {
          interrupted = true; throw new Error('fixture after original provisional index');
        }
        return result;
      };
      try { await assert.rejects(f.run); } finally { fs.renameSync = rename; }
      assert.equal(interrupted, true);
      const original = originalOperation(f).envelope.payload;
      for (const prefix of ['record-', 'latest-', 'rollback-history-']) {
        const file = path.join(original.receipt_store, fs.readdirSync(original.receipt_store).find(name => name.startsWith(prefix)));
        const bytes = fs.readFileSync(file), changed = JSON.parse(bytes);
        changed.payload.dispatch_id = 'foreign-record';
        const foreign = Buffer.from(JSON.stringify(changed)); fs.writeFileSync(file, foreign);
        await assert.rejects(f.run, { code: 'RECORD_FAILED' });
        assert.deepEqual(fs.readFileSync(file), foreign); assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        fs.writeFileSync(file, bytes);
      }
      const result = await f.run(); assert.equal(result.receipt.dispatch_id, original.dispatch_id);
      assert.equal(result.receipt.runtime_evidence.session_id, original.completed.session_id);
      assert.equal(f.launches, 1); assert.equal(f.pushes, 1); assertCurrent(f, result);
    } finally { signing.close(); }
  });
  test('cold high and xhigh originals retain their exact predecessor fence across completion and record transactions', bounded, async t => {
    const signing = signingFixture();
    try {
      const installed = packageSource(path.join(signing.directory, 'cold-policy-package')); verifyPackage(installed);
      for (const rung of [2, 3]) for (const phase of ['native-completed', 'foreign-fence', 'marker', 'retained', 'index', 'consumed']) await t.test(`${rung}:${phase}`, bounded, async () => {
        const f = ciFixture(signing);
        f.control.source = false; f.output.status = 'no-op';
        for (let attempt = 1; attempt < rung; attempt++) {
          if (f.options.controller) {
            f.options.controller.release(f.scope.run_id, 'fixture completed predecessor handoff'); delete f.options.controller;
          }
          f.scope.run_id = 'fixture-predecessor-' + require('node:crypto').randomUUID();
          f.control.runAttempt = attempt;
          const result = await f.run(); assert.equal(result.receipt.applied_effort, ['low', 'high'][attempt - 1]);
        }
        f.options.controller.release(f.scope.run_id, 'fixture new original policy rung'); delete f.options.controller;
        f.scope.run_id = 'fixture-original-' + require('node:crypto').randomUUID();
        f.control.runAttempt = rung; f.control.source = true; f.output.status = 'fixed';
        const rename = fs.renameSync, link = fs.linkSync;
        let interrupted = false;
        const stop = destination => {
          if (interrupted || !destination.endsWith('.json')) return;
          const name = path.basename(destination), value = JSON.parse(fs.readFileSync(destination)).payload;
          const hit = ['native-completed', 'foreign-fence'].includes(phase) ? destination.includes('ci-originals') && value?.completed && value.output
            : phase === 'marker' ? name.startsWith('repair-commit-')
              : phase === 'retained' ? name.startsWith('reservation-') && value?.original_record
                : phase === 'index' ? name.startsWith('latest-') : name.startsWith('consumed-');
          if (hit) { interrupted = true; throw new Error('fixture original predecessor interruption at ' + phase); }
        };
        fs.renameSync = (source, destination, ...args) => { const result = rename(source, destination, ...args); stop(destination); return result; };
        fs.linkSync = (source, destination, ...args) => { const result = link(source, destination, ...args); stop(destination); return result; };
        try { await assert.rejects(f.run); } finally { fs.renameSync = rename; fs.linkSync = link; }
        assert.equal(interrupted, true); assert.equal(f.launches, rung); assert.equal(f.pushes, 0);
        const before = originalOperation(f).envelope.payload;
        assert.ok(before.predecessor_dispatch_id); assert.equal(before.resolution.prior_applied.dispatch_id, before.predecessor_dispatch_id);
        if (['native-completed', 'foreign-fence'].includes(phase)) {
          const claim = path.join(before.receipt_store, 'claim-' + hash(before.predecessor_dispatch_id) + '.json');
          const retained = JSON.parse(fs.readFileSync(claim)); retained.lease_expires_at = '2000-01-01T00:00:00.000Z';
          fs.writeFileSync(claim, JSON.stringify(retained));
        }
        if (phase === 'foreign-fence') {
          const recorder = boundary.createDurableRecorder(before.receipt_store);
          const claim = recorder.claim(before.predecessor_dispatch_id, 'foreign-' + require('node:crypto').randomUUID());
          assert.equal(claim.claimed, true);
          const retained = inventory(before.receipt_store);
          coldOriginal(f, installed, 'RECORD_FAILED');
          assert.deepEqual(inventory(before.receipt_store), retained);
          assert.equal(f.launches, rung); assert.equal(f.pushes, 0); return;
        }
        const result = coldOriginal(f, installed);
        assert.equal(result.receipt.dispatch_id, before.dispatch_id);
        assert.equal(result.receipt.runtime_evidence.session_id, before.completed.session_id);
        assert.equal(result.receipt.applied_effort, rung === 2 ? 'high' : 'xhigh');
        const recorder = boundary.createDurableRecorder(before.receipt_store), record = recorder.getVerifiedRecord(before.dispatch_id);
        assert.equal(record.predecessor_dispatch_id, before.predecessor_dispatch_id);
        assert.equal(recorder.getLatestReceipt('codex', 'ci-fix').dispatch_id, before.dispatch_id);
        const consumed = JSON.parse(fs.readFileSync(path.join(before.receipt_store, 'consumed-' + hash(before.predecessor_dispatch_id) + '.json'))).payload;
        assert.equal(consumed.consumer_id, before.dispatch_id);
        const reservation = JSON.parse(fs.readFileSync(path.join(before.receipt_store, 'reservation-' + hash(before.dispatch_id) + '.json'))).payload;
        assert.equal(consumed.claim_token, reservation.original_subject.claim.claim_token);
        assert.equal(consumed.claim_generation, reservation.original_subject.claim.generation);
        assert.equal(f.launches, rung); assertCurrent(f, result);
      });
    } finally { signing.close(); }
  });
  test('late failure, scope and native-result changes retain the original completion and refuse signing or publication', bounded, async t => {
    const signing = signingFixture();
    try {
      for (const mutation of ['failure', 'plan', 'graph', 'native-final']) await t.test(mutation, bounded, async () => {
        const f = ciFixture(signing), graphFile = path.join(f.graphDir, 'tickets.json');
        const planBytes = fs.readFileSync(f.plan), graphBytes = fs.readFileSync(graphFile);
        f.control.mutateNative = (rows, cli) => {
          if (mutation === 'failure') fs.appendFileSync(f.failureFile, 'late bytes');
          if (mutation === 'plan') fs.appendFileSync(f.plan, '\nlate plan');
          if (mutation === 'graph') fs.appendFileSync(graphFile, '\n');
          if (mutation === 'native-final') rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text = 'foreign original result';
        };
        await assert.rejects(f.run); assert.equal(f.launches, 1); assert.equal(f.pushes, 0);
        assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.originalHead);
        fs.writeFileSync(f.failureFile, f.failureBytes); fs.writeFileSync(f.plan, planBytes); fs.writeFileSync(graphFile, graphBytes);
        if (mutation !== 'native-final') {
          f.control.mutateNative = null;
          const retained = originalOperation(f).envelope.payload; assert.ok(retained.completed.session_id);
          const result = await f.run(); assert.equal(f.launches, 1); assert.equal(f.pushes, 1);
          assert.equal(result.receipt.runtime_evidence.session_id, retained.completed.session_id); assertCurrent(f, result);
        }
      });
    } finally { signing.close(); }
  });
  test('CI uses genuine low/high/xhigh predecessors and refuses the exhausted ceiling without relaunch', bounded, async () => {
    const signing = signingFixture();
    try {
      const f = ciFixture(signing); f.control.source = false; f.output.status = 'no-op';
      for (let attempt = 1; attempt <= 3; attempt++) {
        f.control.runAttempt = attempt;
        const result = await f.run(); assert.equal(result.receipt.role, 'ci-fix');
        assert.equal(result.receipt.applied_effort, ['low', 'high', 'xhigh'][attempt - 1]);
        const original = originalOperation(f).envelope.payload;
        assert.equal(original.resolution.prior_applied?.dispatch_id || null, attempt === 1 ? null : original.predecessor_dispatch_id);
      }
      f.control.runAttempt = 4; await assert.rejects(f.run, { code: 'REPAIR_POLICY_EXHAUSTED' });
      assert.equal(f.launches, 3); assert.equal(f.pushes, 0);
      assert.deepEqual(f.selections.map(item => item.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol']);
      f.failureBytes[0] ^= 1;
      const progressed = path.join(signing.directory, 'new-current-progress.log'); fs.writeFileSync(progressed, f.failureBytes, { mode: 0o600 });
      f.request.context.evidence_path = progressed; f.request.context.evidence_sha256 = hash(f.failureBytes);
      const reset = await f.run(); assert.equal(reset.receipt.applied_effort, 'low'); assert.equal(f.launches, 4);
      const directory = path.join(f.stateRoot, 'ci-originals');
      const op = fs.readdirSync(directory).map(name => JSON.parse(fs.readFileSync(path.join(directory, name))).payload)
        .find(value => value.dispatch_id === reset.receipt.dispatch_id);
      assert.equal(op.predecessor_dispatch_id, null); assert.equal(op.resolution.signals.signatureState, 'first');
      const recorder = boundary.createDurableRecorder(op.receipt_store), before = JSON.stringify(recorder.getVerifiedRecord(op.dispatch_id));
      for (const forged of [{}, { ...op }, JSON.parse(JSON.stringify(op))]) {
        assert.throws(() => boundary.createDispatchBoundary({ recorder, originalCiOperation: forged })
          .reconcileOriginal(op.dispatch_id, { ticket: f.scope.ticket }), { code: 'CI_ORIGINAL_INVALID' });
        assert.equal(JSON.stringify(recorder.getVerifiedRecord(op.dispatch_id)), before);
      }
    } finally { signing.close(); }
  });
  test('whole supported package has complete independent inventory, two content identities and separate physical tamper refusals', bounded, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-package-')));
    try {
      const staged = packageSource(path.join(directory, 'source')), entries = verifyPackage(staged);
      verifySourceMirrors(path.join(directory, 'source'), staged);
      assert.deepEqual(entries, inventory(path.join(root, 'plugins/shipyard')));
      for (const relative of ['host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs', 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs',
        'host/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs', 'host/plugins/delivery-pipeline/scripts/base-merge.cjs', ...identities]) {
        const file = path.join(staged, relative), original = fs.readFileSync(file);
        fs.appendFileSync(file, 'tamper'); assert.throws(() => verifyPackage(staged)); fs.writeFileSync(file, original); verifyPackage(staged);
      }
      const canonical = path.join(directory, 'source/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
      const bytes = fs.readFileSync(canonical); fs.appendFileSync(canonical, '\nvoid "canonical mutation";\n');
      assert.throws(() => verifySourceMirrors(path.join(directory, 'source'), staged));
      fs.writeFileSync(canonical, bytes); verifySourceMirrors(path.join(directory, 'source'), staged);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('actual z29x/y/z append once after first51 and preserve first50 and dynamic future denominators', bounded, () => {
    const shards = require('./shard-files.cjs'), frozen = shards.readManifest();
    const names = ['phase53-z29x-native-ci-fix-contract.test.cjs', 'phase53-z29y-native-ci-fix-recovery.test.cjs', 'phase53-z29z-generated-base-merge.test.cjs'];
    const prerequisites = ['phase53-z29a-fixer-original-custody.test.cjs', 'phase53-z29b-fixer-source-history.test.cjs',
      'phase53-z29c-historical-direct.test.cjs', 'phase53-z29d-historical-admitted.test.cjs', 'phase53-z29e-historical-pending.test.cjs',
      'phase53-z29f-historical-action-repeat.test.cjs', 'phase53-z29g-historical-action-covered.test.cjs',
      'phase53-z29h-publication-unsent-recovery.test.cjs', 'phase53-z29i-recorded-integration-compatibility.test.cjs',
      'phase53-z29t-role-architecture-archives.test.cjs', 'phase53-z29u-role-containment.test.cjs',
      'phase53-z29v-role-code-review.test.cjs', 'phase53-z29w-role-integration.test.cjs'];
    const tasks = shards.unitTasks(shards.unitFiles().filter(name => !prerequisites.includes(name)));
    const delivered = shards.appendShard(frozen, tasks.filter(task => !names.includes(task)));
    assert.equal(delivered.shards.length, 51);
    assert.equal(hash(JSON.stringify(delivered.shards.slice(0, 50))), 'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
    const next = shards.appendShard(delivered, tasks); assert.equal(next.shards.length, 54);
    assert.deepEqual(next.shards.slice(0, 51), delivered.shards); assert.deepEqual(next.shards.slice(51), names.map(name => [name]));
    assert.deepEqual(shards.appendShard(next, tasks), next); assert.deepEqual(next.shards.slice(0, 16), frozen.shards.slice(0, 16));
    for (const name of names) assert.ok(name > 'phase53-z29-semantic-final-catalog-duplication.test.cjs' && name < 'phase53-z30-semantic-material-retention.test.cjs');
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-shards-')));
    try {
      for (const name of shards.unitFiles().filter(name => !prerequisites.includes(name))) fs.writeFileSync(path.join(directory, name), '');
      fs.writeFileSync(path.join(directory, 'phase53-z99-future.test.cjs'), '');
      const future = shards.appendShard(next, shards.unitTasks(shards.unitFiles(directory)));
      assert.equal(future.shards.length, next.shards.length + 1);
      assert.deepEqual(future.shards.slice(0, next.shards.length), next.shards);
      assert.deepEqual(shards.selectTaskShard(`${future.shards.length}/${future.shards.length}`, directory, next), ['phase53-z99-future.test.cjs']);
      assert.throws(() => shards.selectTaskShard(`${next.shards.length}/${next.shards.length}`, directory, next));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('complete physical discovery retains first58 and first60 prefixes and current64 to67 plus every future selector', bounded, () => {
    const shards = require('./shard-files.cjs'), frozen = shards.readManifest();
    const baseline = require('./phase53-z29g-historical-action-covered.test.cjs').original.shards;
    const files = shards.unitFiles(), tasks = shards.unitTasks(files);
    const seven = ['phase53-z29a-fixer-original-custody.test.cjs', 'phase53-z29b-fixer-source-history.test.cjs',
      'phase53-z29c-historical-direct.test.cjs', 'phase53-z29d-historical-admitted.test.cjs', 'phase53-z29e-historical-pending.test.cjs',
      'phase53-z29f-historical-action-repeat.test.cjs', 'phase53-z29g-historical-action-covered.test.cjs'];
    const two = ['phase53-z29h-publication-unsent-recovery.test.cjs', 'phase53-z29i-recorded-integration-compatibility.test.cjs'];
    const four = ['phase53-z29t-role-architecture-archives.test.cjs', 'phase53-z29u-role-containment.test.cjs',
      'phase53-z29v-role-code-review.test.cjs', 'phase53-z29w-role-integration.test.cjs'];
    const three = ['phase53-z29x-native-ci-fix-contract.test.cjs', 'phase53-z29y-native-ci-fix-recovery.test.cjs', 'phase53-z29z-generated-base-merge.test.cjs'];
    const before = shards.appendShard(frozen, tasks.filter(task => !three.includes(task)));
    assert.equal(before.shards.length, 64); assert.equal(before.shards.length + 3, 67);
    assert.deepEqual(before.shards.slice(0, 51), baseline);
    assert.deepEqual(before.shards.slice(51, 58), seven.map(file => [file]));
    assert.deepEqual(before.shards.slice(58, 60), two.map(file => [file]));
    assert.deepEqual(before.shards.slice(60), four.map(file => [file]));
    const actual = shards.appendShard(frozen, tasks);
    assert.equal(actual.shards.length, 67); assert.equal(actual.shards.length + 3, 70);
    assert.deepEqual(actual.shards.slice(0, 64), before.shards);
    assert.deepEqual(actual.shards.slice(64), three.map(file => [file]));
    assert.deepEqual(actual.shards.slice(0, 16), frozen.shards.slice(0, 16));
    assert.equal(hash(JSON.stringify(actual.shards.slice(0, 50))), 'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
    assert.deepEqual([...actual.shards.flat()].sort(), tasks); assert.equal(new Set(actual.shards.flat()).size, tasks.length);
    for (let index = 0; index < actual.shards.length; index++)
      assert.deepEqual(shards.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't31-full-prefix-')));
    try {
      for (const name of files) fs.writeFileSync(path.join(directory, name), '');
      const future = ['phase53-z30-semantic-material-retention.test.cjs', 'phase53-z30b-semantic-material-retention.test.cjs',
        'phase53-z30c-semantic-material-retention.test.cjs', 'phase53-z30d-semantic-material-retention.test.cjs',
        'phase53-z30e-semantic-material-retention.test.cjs', 'phase53-z30f-semantic-material-retention.test.cjs'];
      for (const name of future) fs.writeFileSync(path.join(directory, name), '');
      const discovered = shards.unitTasks(shards.unitFiles(directory)), next = shards.appendShard(actual, discovered);
      assert.equal(next.shards.length, actual.shards.length + future.length); assert.equal(next.shards.length, 73);
      assert.equal(next.shards.length + 3, 76); assert.deepEqual(next.shards.slice(0, 67), actual.shards);
      assert.deepEqual(next.shards.slice(67), future.map(file => [file]));
      assert.deepEqual([...next.shards.flat()].sort(), discovered); assert.equal(new Set(next.shards.flat()).size, discovered.length);
      for (let index = 0; index < next.shards.length; index++)
        assert.deepEqual(shards.selectTaskShard(`${index + 1}/${next.shards.length}`, directory, actual), next.shards[index]);
      assert.throws(() => shards.selectTaskShard(`1/${actual.shards.length}`, directory, actual));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

}
module.exports = { inventory, verifyPackage, verifySourceMirrors, packageSource, originalOperation };
