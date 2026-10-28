'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test: runTest, done, assert } = require('./assert-harness.cjs');
const integratorCallerOnly = process.argv.includes('--integrator-caller-only');
if (process.argv.slice(2).some(value => value !== '--integrator-caller-only') || process.argv.slice(2).length > 1)
  throw new Error('Unknown integrator caller selection');
let integratorCallerSelected = 0;
function test(name, callback) {
  const selected = name === 'both supported integrator callers select v3 before legacy full-inline formatting';
  if (integratorCallerOnly && !selected) return;
  if (selected) integratorCallerSelected++;
  return runTest(name, callback);
}

const repositoryRoot = path.resolve(__dirname, '../..');
const deliverPath = path.join(repositoryRoot, 'plugins/delivery-pipeline/commands/deliver.md');
const scriptPath = path.join(repositoryRoot, 'plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
const dispatcher = require(scriptPath);
const deliver = fs.readFileSync(deliverPath, 'utf8');

suite('deliver request builders: command contract');

test('deliver.md uses the build subcommand for all three roles', () => {
  for (const role of ['arch-review', 'ci-fix', 'review-fix']) {
    assert.ok(deliver.includes(`deliver-dispatch.cjs build ${role}`), `${role} builder command is missing`);
  }
});

test('the referenced script and build subcommand resolve', () => {
  assert.ok(fs.existsSync(scriptPath));
  assert.equal(typeof dispatcher.build, 'function');
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /command === 'build'/);
});

test('these role instructions no longer hand-build boundary requests', () => {
  const ciStart = deliver.indexOf('first | progress | repeat | repeat_exhausted — build the role request');
  const reviewStart = deliver.indexOf('b. reviewers.cjs feedback <pr>');
  const archStart = deliver.indexOf('c. arch-review agent — host-bound judgment');
  const archEnd = deliver.indexOf('the same step runs the degenerate-green detector', archStart);
  assert.ok(ciStart >= 0 && reviewStart > ciStart && archStart > reviewStart && archEnd > archStart);

  const ci = deliver.slice(ciStart, reviewStart);
  const review = deliver.slice(reviewStart, archStart);
  const arch = deliver.slice(archStart, archEnd);
  for (const [role, section] of [['ci-fix', ci], ['review-fix', review], ['arch-review', arch]]) {
    assert.ok(section.includes(`deliver-dispatch.cjs build ${role}`), `${role} section does not use its builder`);
    assert.ok(!section.includes('boundary.dispatch('), `${role} section still hand-builds a boundary request`);
  }
});

const step5 = deliver.slice(deliver.indexOf('## Step 5'), deliver.indexOf('## Rules'));
const pipelineDocs = fs.readFileSync(path.join(repositoryRoot, 'docs/gsd_multilevel_delivery_pipeline.md'), 'utf8');
const phaseBuilderArgv = source => [...source.replace(/\\\n\s*/g, ' ').matchAll(
  /^\s*node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/deliver-dispatch\.cjs build ((?:code-review|arch-review) <phase-directory>[^\n]*)/gm
)].map(([, argv]) => argv.replace(/\s+\[--repo owner\/name\]$/, '').trim().split(/\s+/));

test('every documented phase review builder explicitly selects the canonical project graph', () => {
  for (const [source, roles] of [[deliver, ['arch-review', 'code-review', 'arch-review']],
    [pipelineDocs, ['code-review', 'arch-review']]]) {
    const commands = phaseBuilderArgv(source);
    assert.deepStrictEqual(commands.map(argv => argv[0]), roles);
    for (const argv of commands) assert.deepStrictEqual(argv, [argv[0], '<phase-directory>', '--phase', '<N>',
      '--pr', '<integration-pr>', '--runtime', '<codex|claude>', '--graph', '<project-root>/.planning/graph']);
  }
  assert.match(deliver.replace(/\\\n\s*/g, ' '),
    /deliver-dispatch\.cjs build arch-review <T>\s+--runtime <r> --pr <N> --graph <project-root>\/\.planning\/graph/);
});

test('phase finale orders publication, prelaunch gate, integrator, architecture review and ready', () => {
  let previous = -1;
  for (const token of ['phase-code-review.cjs status', 'build code-review', 'phase-code-review.cjs publish',
    'phase-code-review.cjs gate', "role: 'integrator'", 'build arch-review', 'gh pr ready']) {
    const index = step5.indexOf(token);
    assert.ok(index > previous, `${token} must follow the prior finale step`); previous = index;
  }
  assert.match(step5, /unmatched[\s\S]*stop in both modes/);
  assert.ok(step5.indexOf('status --porcelain --untracked-files=all') < step5.indexOf('build code-review'));
  assert.ok(deliver.includes('deliver-dispatch.cjs build code-review'));
  assert.match(deliver.slice(0, deliver.indexOf('## Principle')), /delivery_pipeline.code_review[\s\S]*report/);
  assert.ok(!/gsd-code-review[^\n]*--fix/.test(deliver));
  assert.ok(!deliver.includes('builder exits 2'));
});

test('review roles use the prepared-context CLI and preserve the integrator in-process route', () => {
  assert.match(step5, /codex-delivery-host.cjs --args-file/);
  assert.match(step5, /mode-0600/);
  assert.match(step5, /mktemp -d/);
  assert.match(step5, /outside every worktree/);
  assert.match(step5, /createClaudeRoleHost\(options\).run\(request\)/);
  assert.match(step5, /options.graphDir/);
  assert.strictEqual((step5.match(/createCodexDeliveryHost\(\{/g) || []).length, 1);
  assert.match(step5, /createCodexDeliveryHost\(\{[\s\S]*?role: 'integrator'/);
});

test('both supported integrator callers select v3 before legacy full-inline formatting', () => {
  const start = step5.indexOf('**Fresh final integration contract.**');
  const end = step5.indexOf('**Legacy full-input compatibility.', start);
  assert.ok(start >= 0 && end > start);
  const integration = step5.slice(start, end);
  const caller = integration.match(/```javascript\n([\s\S]*?)\n\s*```/)[1];
  assert.match(caller, /const current = prepareNativeIntegratorContext\(options, \{\s*worktree, phase: String\(phase\), review_contract: 'shipyard\.integration-review\.v3' \}\)/);
  assert.ok(!caller.includes('prepareIntegratorContext'));
  assert.strictEqual((caller.match(/review_contract: 'shipyard\.integration-review\.v3'/g) || []).length, 3);
  assert.match(caller, /scope: \{[\s\S]*run_id, worktree, repository: current.canonical.commonPath,[\s\S]*phase: current.phaseNumber, ticket: phaseSubject/);
  assert.match(caller, /schema: 'shipyard.claude-role-request.v1',[\s\S]*role: 'integrator', worktree, phase: String\(phase\)/);
  for (const field of ['dispatch_id', 'stage', 'unit_id', 'index', 'receipt', 'model', 'capacity', 'input_budget'])
    assert.ok(!new RegExp('\\b' + field + '\\s*:').test(caller), `caller must not serialize ${field} authority`);
  assert.match(integration, /Omit `options\.integrationCapacity` entirely for this production observed\s+default on both runtimes/);
  assert.match(integration, /Supplied strict capacity resources retain their original exact\/certified/);
  assert.match(integration, /Malformed supplied resources refuse rather than fall back to observed mode/);
  assert.match(integration, /original receipt-pinned CLI\/session/);
  assert.match(integration, /actual per-request usage/);
  assert.match(integration, /overflow, compaction,[\s\S]*truncation and incomplete answers produce HOLD/);
  assert.match(integration, /same-plan completed-unit reuse/);
  assert.match(integration, /separate.*Codex.*Claude/s);
  assert.match(integration, /R8 INCOMPLETE/);
  assert.match(integration, /human.*merge/s);
});

test('restore runs after live evidence reads and before every integrator outcome branch', () => {
  const restore = step5.indexOf('Restore the epic worktree (every integrator outcome)');
  assert.ok(restore > step5.indexOf("role: 'integrator'"));
  assert.ok(restore > step5.indexOf('gsd-sync.cjs'));
  assert.ok(restore < step5.indexOf('build arch-review'));
  assert.ok(restore < step5.indexOf('fix tickets as new plans in the same phase'));
  const body = step5.slice(restore, step5.indexOf('fix tickets as new plans in the same phase'));
  for (const outcome of ['passed', 'needs-fix', 'human-review-required']) assert.ok(body.includes(outcome));
  assert.match(body, /role-artifact.cjs prepare[\s\S]*?--role integrator/);
  assert.match(body, /status --porcelain --untracked-files=all/);
  assert.match(body, /checkout -- .planning\/phases/);
  assert.match(body, /seal or validate refusal/);
});

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { statusIgnoringScratch } = require('../../plugins/delivery-pipeline/scripts/conveyor-scratch.cjs');
const { prepareRoleArtifact } = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const phase = '52-review';
const integration = `.planning/phases/${phase}/INTEGRATION.md`;
const archived = '.shipyard-role-artifacts/sealed/INTEGRATION.md';
function integrationRepo(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'integration-restore-')));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  try {
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'commit.gpgsign', 'false']);
    write('source.txt', 'one commit'); git(['add', 'source.txt']); git(['commit', '--quiet', '-m', 'base']);
    run({ root, git, write, status: forJudge => statusIgnoringScratch(root, { untracked: 'all', forJudge }).entries,
      clear: () => prepareRoleArtifact({ worktreePath: root, role: 'integrator', phase }) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('documented review argv selects project hold policy over a linked epic report checkout', () => {
  integrationRepo(({ root, git, write }) => {
    const previousGraph = process.env.SHIPYARD_GRAPH_DIR, previousHomedir = os.homedir;
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-builder-linked-')));
    const linked = path.join(directory, 'epic'), graphDir = path.join(root, '.planning/graph');
    const branch = `epic/${phase}`, base = git(['rev-parse', 'HEAD']);
    const flow = require('../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
    const config = mode => JSON.stringify({ git: { base_branch: 'main' }, delivery_pipeline: { code_review: mode } });
    try {
      delete process.env.SHIPYARD_GRAPH_DIR;
      os.homedir = () => directory;
      write('.planning/config.json', config('report'));
      write('.planning/graph/tickets.json', JSON.stringify({
        epics: { '052': { branch, phaseDir: phase, repos: [null], jira: null } },
        tickets: { 'T-52-01': { phase: 52, phaseDir: phase, epic: branch, repo: null,
          branch: 'ticket/T-52-01-demo', plan: `.planning/phases/${phase}/52-01-PLAN.md` } },
      }));
      write('.planning/graph/delivery-state.json', JSON.stringify({ tickets: {
        'T-52-01': { status: 'merged', pr: 1, head_sha: base, merge_sha: base },
      } }));
      git(['add', '.planning']); git(['commit', '--quiet', '-m', 'tracked report graph']);
      git(['worktree', 'add', '--quiet', '-b', branch, linked]);
      write('.planning/config.json', config('hold'));
      const options = { cwd: linked, defaultBranch: 'main', getPullRequest: () => ({ number: 52, state: 'OPEN',
        headRefName: branch, headRefOid: git(['rev-parse', 'HEAD']), baseRefName: 'main', baseRefOid: base }) };
      const input = { phase: 52, phaseDirectory: phase, pr: 52, worktree: linked, graphDir };
      const status = flow.status(input, options);
      assert.strictEqual(status.mode, 'hold'); assert.strictEqual(status.state, 'owed');
      assert.strictEqual(flow.evaluateGate(status).ok, false);
      assert.strictEqual(flow.verifyCodeReview({ ...input, live: options.getPullRequest() }, options).ok, false);
      assert.strictEqual(flow.resolveCodeReviewMode({ graphDir: path.join(linked, '.planning/graph') }).mode, 'report');
      for (const source of [deliver, pipelineDocs]) {
        const commands = phaseBuilderArgv(source);
        assert.ok(commands.length >= 2);
        for (const documented of commands) {
          const substitutions = { '<phase-directory>': phase, '<N>': '52', '<integration-pr>': '52',
            '<codex|claude>': 'codex', '<project-root>/.planning/graph': graphDir };
          const argv = documented.map(arg => substitutions[arg] || arg);
          const implicit = argv.slice(0, argv.indexOf('--graph'));
          assert.strictEqual(dispatcher.build(implicit, options).graph_dir, path.join(linked, '.planning/graph'));
          if (argv[0] === 'code-review') assert.strictEqual(dispatcher.build(argv, options).graph_dir, graphDir);
          else assert.throws(() => dispatcher.build(argv, options), /phase code review is owed.*delivery_pipeline.code_review.*report/);
        }
      }
    } finally {
      os.homedir = previousHomedir;
      if (previousGraph === undefined) delete process.env.SHIPYARD_GRAPH_DIR;
      else process.env.SHIPYARD_GRAPH_DIR = previousGraph;
      if (fs.existsSync(linked)) git(['worktree', 'remove', '--force', linked]);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('live integration evidence refuses both hosts; prepare clears exactly the role file', () => {
  integrationRepo(({ write, status, clear }) => {
    write(integration, 'Verdict: passed'); write(archived, 'sealed');
    for (const flag of [true, false]) assert.ok(status(flag).some(entry => entry.path === integration));
    assert.ok(status(true).some(entry => entry.path === archived));
    assert.ok(!status(false).some(entry => entry.path === archived));
    assert.strictEqual(clear().cleared, true); assert.deepStrictEqual(status(false), []);
    write('.shipyard-role-artifacts-neighbor.txt', 'unrelated');
    assert.deepStrictEqual(status(false).map(entry => entry.path), ['.shipyard-role-artifacts-neighbor.txt']);
  });
});

test('clearing modified committed integration evidence leaves a deletion until checkout', () => {
  integrationRepo(({ git, write, status, clear }) => {
    write(integration, 'committed'); git(['add', integration]); git(['commit', '--quiet', '-m', 'evidence']);
    write(integration, 'modified');
    assert.deepStrictEqual(status(false), [{ status: ' M', path: integration }]);
    clear(); assert.deepStrictEqual(status(false), [{ status: ' D', path: integration }]);
    git(['checkout', '--', integration]); assert.deepStrictEqual(status(false), []);
  });
});

for (const outcome of ['passed', 'needs-fix', 'human-review-required']) {
  test(`after a ${outcome} verdict the live INTEGRATION.md still refuses the next review until restored`, () => {
    integrationRepo(({ write, status, clear }) => {
      write(integration, `# Integration\nVerdict: ${outcome}\n`); write(archived, 'authenticated archive stand-in');
      assert.deepStrictEqual(status(false).map(entry => entry.path), [integration]);
      assert.deepStrictEqual(status(true).map(entry => entry.path).sort(), [integration, archived].sort());
      assert.strictEqual(clear().cleared, true); assert.deepStrictEqual(status(false), []);
      assert.deepStrictEqual(status(true).map(entry => entry.path), [archived]);
      assert.strictEqual(clear().cleared, false);
    });
  });
  test(`committed integration evidence is restored after ${outcome}`, () => {
    integrationRepo(({ git, write, status, clear }) => {
      write(integration, 'committed'); git(['add', integration]); git(['commit', '--quiet', '-m', 'evidence']);
      write(integration, `Verdict: ${outcome}\n`);
      assert.strictEqual(clear().cleared, true);
      git(['checkout', '--', integration]);
      assert.deepStrictEqual(status(false), []); assert.deepStrictEqual(status(true), []);
    });
  });
}

if (integratorCallerOnly && integratorCallerSelected !== 1) throw new Error('Expected exactly one integrator caller case');
done();
