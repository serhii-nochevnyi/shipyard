'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'repo-resolve.cjs'
);
const mod = require(SCRIPT);

const trash = [];
process.on('exit', () => {
  for (const dir of trash) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tempDir(prefix = 'shipyard-repo-resolve-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(cwd, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function gitRepo() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'gitconfig'), '');
  git(dir, ['init', '-q']);
  return dir;
}

function project(config) {
  const dir = tempDir('shipyard-repo-project-');
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline: config }, null, 2));
  return dir;
}

function isolatedProject(config) {
  const workspace = tempDir('shipyard-repo-workspace-');
  const dir = path.join(workspace, 'project');
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline: config }, null, 2));
  return dir;
}

function run(args, cwd = os.tmpdir()) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

suite('configured repository resolution');

test('an existing configured git checkout resolves to its repository root', () => {
  const checkout = gitRepo();
  const canonicalCheckout = fs.realpathSync(checkout);
  const result = mod.resolveConfiguredRepo({
    ticket: 'T-30-02',
    repo: 'acme/service',
    config: { repos: { 'acme/service': checkout } },
  });
  assert.deepStrictEqual(result, {
    ticket: 'T-30-02',
    repo: 'acme/service',
    resolution: 'configured',
    executable: true,
    configured_path: canonicalCheckout,
    repository_root: canonicalCheckout,
    reason: null,
    discovery_status: 'not-run',
    candidates: [],
    searched_roots: [],
  });
});

test('a missing entry is trackable-only and keeps the ticket and reason', () => {
  const result = mod.resolveConfiguredRepo({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: {} },
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'track-only');
  assert.strictEqual(result.ticket, 'T-30-03');
  assert.strictEqual(result.repo, 'acme/service');
  assert.match(result.reason, /pipeline\.repos/);
  assert.strictEqual(result.discovery_status, 'not-run');
});

test('an invalid configured path is trackable-only without filesystem mutation', () => {
  const parent = tempDir();
  const missing = path.join(parent, 'does-not-exist');
  const before = fs.readdirSync(parent);
  const result = mod.resolveConfiguredRepo({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: { 'acme/service': missing } },
  });
  assert.strictEqual(result.executable, false);
  assert.match(result.reason, /does-not-exist/);
  assert.deepStrictEqual(fs.readdirSync(parent), before, 'resolution must not create a checkout');

  const notGit = path.join(parent, 'not-git');
  fs.mkdirSync(notGit);
  const nonRepo = mod.resolveConfiguredRepo({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: { 'acme/service': notGit } },
  });
  assert.strictEqual(nonRepo.executable, false);
  assert.match(nonRepo.reason, /not a git repository/);
});

test('malformed repository arguments fail closed before any filesystem write', () => {
  const parent = tempDir();
  const before = fs.readdirSync(parent);
  for (const input of [
    null,
    { repo: 'acme', config: { repos: {} } },
    { repo: 'acme/service/extra', config: { repos: {} } },
    { repo: 'acme/service', config: null },
    { repo: 'acme/service', ticket: 30, config: { repos: {} } },
  ]) {
    assert.throws(() => mod.resolveConfiguredRepo(input), /repo-resolve:/, JSON.stringify(input));
  }
  assert.deepStrictEqual(fs.readdirSync(parent), before, 'invalid arguments must not touch the filesystem');
});

test('the CLI uses the same configured branch and returns machine-readable resolution', () => {
  const checkout = gitRepo();
  const canonicalCheckout = fs.realpathSync(checkout);
  const projectDir = project({ repos: { 'acme/service': checkout } });
  const result = run([
    'configured', 'acme/service', '--ticket', 'T-30-02', '--project-dir', projectDir, '--json',
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.ticket, 'T-30-02');
  assert.strictEqual(output.resolution, 'configured');
  assert.strictEqual(output.executable, true);
  assert.strictEqual(output.repository_root, canonicalCheckout);
});

function repoAt(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gitconfig'), '');
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', origin]);
  return fs.realpathSync(dir);
}

test('origin normalization accepts GitHub SSH, HTTPS, and scp-like forms', () => {
  for (const origin of [
    'git@github.com:Acme/Service.git',
    'ssh://git@github.com/Acme/Service.git',
    'https://github.com/Acme/Service.git/',
    'https://token@github.com/Acme/Service',
  ]) {
    assert.strictEqual(mod.normalizeOrigin(origin), 'acme/service', origin);
  }
  assert.strictEqual(mod.normalizeOrigin('https://gitlab.com/acme/service.git'), null);
  assert.strictEqual(mod.normalizeOrigin('acme/service'), null);
});

test('discovery matches origin rather than the directory basename and scans one level', () => {
  const parent = tempDir();
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(projectDir);
  const matching = repoAt(path.join(parent, 'unrelated-directory-name'), 'git@github.com:Acme/Service.git');
  repoAt(path.join(parent, 'service'), 'git@github.com:someone-else/Service.git');
  const nested = path.join(parent, 'nested-root', 'service');
  repoAt(nested, 'git@github.com:acme/service.git');

  const result = mod.discoverRepository({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.resolution, 'discovered');
  assert.strictEqual(result.discovery_status, 'unique');
  assert.strictEqual(result.executable, true);
  assert.strictEqual(result.repository_root, matching);
  assert.deepStrictEqual(result.candidates.map((candidate) => candidate.path), [matching]);
  assert.ok(result.searched_roots.includes(fs.realpathSync(parent)) || result.searched_roots.includes(parent));
});

test('zero discovery candidates are distinct from an ambiguous result', () => {
  const parent = tempDir();
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(projectDir);
  const none = mod.discoverRepository({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
  });
  assert.strictEqual(none.resolution, 'undiscovered');
  assert.strictEqual(none.discovery_status, 'none');
  assert.deepStrictEqual(none.candidates, []);
  assert.strictEqual(none.executable, false);

  repoAt(path.join(parent, 'first'), 'https://github.com/acme/service.git');
  repoAt(path.join(parent, 'second'), 'git@github.com:acme/service.git');
  const ambiguous = mod.discoverRepository({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
  });
  assert.strictEqual(ambiguous.resolution, 'ambiguous');
  assert.strictEqual(ambiguous.discovery_status, 'ambiguous');
  assert.strictEqual(ambiguous.executable, false);
  assert.strictEqual(ambiguous.candidates.length, 2);
  assert.match(ambiguous.reason, /multiple checkouts/);
  assert.deepStrictEqual(
    ambiguous.candidates.map((candidate) => candidate.origin),
    ['acme/service', 'acme/service'],
    'candidate output must expose only the normalized origin identity'
  );
});

test('discovery ignores symlinks that escape the searched root and directories inside a parent repository', () => {
  const parent = tempDir();
  const root = path.join(parent, 'root');
  const projectDir = path.join(root, 'project');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(projectDir);
  const escaped = repoAt(outside, 'git@github.com:acme/service.git');
  fs.symlinkSync(escaped, path.join(root, 'linked-checkout'), 'dir');

  const parentRepo = repoAt(path.join(parent, 'parent-repo'), 'git@github.com:acme/service.git');
  fs.mkdirSync(path.join(parentRepo, 'nested-directory'));
  const result = mod.discoverRepository({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: {}, repos_root: root },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.resolution, 'undiscovered');
  assert.deepStrictEqual(result.candidates, []);

  const nestedResult = mod.discoverRepository({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: {}, repos_root: path.dirname(parentRepo) },
    projectRoot: projectDir,
  });
  assert.strictEqual(nestedResult.resolution, 'ambiguous');
  assert.deepStrictEqual(
    nestedResult.candidates.map((candidate) => candidate.path),
    [escaped, parentRepo].sort(),
    'only real direct child checkouts may be candidates'
  );
});

test('resolveRepository keeps a valid configured checkout ahead of discovery', () => {
  const parent = tempDir();
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(projectDir);
  const configured = repoAt(path.join(parent, 'configured'), 'git@github.com:acme/service.git');
  repoAt(path.join(parent, 'discovered'), 'git@github.com:acme/service.git');
  const result = mod.resolveRepository({
    ticket: 'T-30-03',
    repo: 'acme/service',
    config: { repos: { 'acme/service': configured }, repos_root: parent },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.resolution, 'configured');
  assert.strictEqual(result.repository_root, configured);
  assert.strictEqual(result.discovery_status, 'not-run');
});

test('the CLI rejects an unknown slug instead of treating it as a checkout request', () => {
  const result = run(['configured', 'not-a-slug', '--json']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /owner\/name/);
});

test('the CLI rejects option-like values for value-taking flags', () => {
  for (const flags of [
    ['--ticket', '--json'],
    ['--project-dir', '--json'],
  ]) {
    const result = run(['resolve', 'acme/service', ...flags]);
    assert.strictEqual(result.status, 2, `${flags[0]} must not consume ${flags[1]} as its value`);
    assert.match(result.stderr, new RegExp(`${flags[0]} requires a value`));
    assert.match(result.stderr, /the flag "--json"/);
  }
});

test('human-readable discovery output names the selected resolution', () => {
  const parent = tempDir();
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(projectDir);
  repoAt(path.join(parent, 'checkout-with-an-unrelated-name'), 'git@github.com:acme/service.git');
  const result = run(['discover', 'acme/service', '--project-dir', projectDir]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /acme\/service: discovered checkout /);
});

test('the operator prompt names the repository and all three D3 choices', () => {
  const prompt = mod.choicePrompt('acme/service', '/work/service');
  assert.match(prompt, /acme\/service/);
  assert.match(prompt, /clone to \/work\/service/);
  assert.match(prompt, /existing checkout path/);
  assert.match(prompt, /skip/);
});

test('an unanswered choice becomes a durable park payload without filesystem mutation', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const before = fs.readdirSync(parent).sort();
  const result = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {} },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.resolution, 'track-only');
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.decision, 'skip');
  assert.strictEqual(result.operator_choice, 'skip');
  assert.strictEqual(result.choice_source, 'unattended');
  assert.match(result.park_reason, /no operator choice.*skipped/);
  assert.strictEqual(result.reason, result.park_reason);
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), before, 'unanswered choice must not create a destination');
});

test('an explicit existing path is adopted only when its origin and nesting are valid', () => {
  const projectDir = isolatedProject({});
  const checkout = repoAt(path.join(tempDir(), 'held-under-another-name'), 'git@github.com:acme/service.git');
  const result = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {} },
    projectRoot: projectDir,
    choice: 'existing',
    existingPath: checkout,
  });
  assert.strictEqual(result.resolution, 'supplied');
  assert.strictEqual(result.executable, true);
  assert.strictEqual(result.repository_root, checkout);
  assert.strictEqual(result.decision, 'existing');
  assert.strictEqual(result.operator_choice, 'existing');

  const wrongOrigin = repoAt(path.join(tempDir(), 'wrong-origin'), 'git@github.com:someone-else/service.git');
  const rejected = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {} },
    projectRoot: projectDir,
    choice: 'existing',
    existingPath: wrongOrigin,
  });
  assert.strictEqual(rejected.executable, false);
  assert.strictEqual(rejected.decision, 'existing');
  assert.match(rejected.park_reason, /origin.*acme\/service/);
});

test('an existing path nested in the project is refused unless sub_repos declares it', () => {
  const projectDir = isolatedProject({});
  const nested = repoAt(path.join(projectDir, 'foreign-checkout'), 'git@github.com:acme/service.git');
  const rejected = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {}, sub_repos: [] },
    projectRoot: projectDir,
    choice: 'existing',
    existingPath: nested,
  });
  assert.strictEqual(rejected.executable, false);
  assert.match(rejected.park_reason, /nested inside project/);

  const allowed = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {}, sub_repos: ['foreign-checkout'] },
    projectRoot: projectDir,
    choice: 'existing',
    existingPath: nested,
  });
  assert.strictEqual(allowed.executable, true);
  assert.strictEqual(allowed.resolution, 'supplied');
});

test('clone records explicit intent and a validated destination without cloning or writing', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const destination = path.join(parent, 'service');
  const before = fs.readdirSync(parent).sort();
  const result = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    choice: 'clone',
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'track-only');
  assert.strictEqual(result.decision, 'clone');
  assert.strictEqual(result.operator_choice, 'clone');
  assert.strictEqual(result.destination, destination);
  assert.match(result.park_reason, /clone.*pending/);
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), before, 'clone choice must not create a destination in T-30-04');

  const outside = path.join(tempDir(), 'outside-service');
  const rejected = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    choice: 'clone',
    destination: outside,
  });
  assert.strictEqual(rejected.executable, false);
  assert.match(rejected.park_reason, /outside pipeline\.repos_root/);
});

test('clone refuses a dangling destination symlink before recording an adoptable checkout', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const destination = path.join(parent, 'service');
  fs.symlinkSync(path.join(parent, 'missing-service-target'), destination);

  const result = mod.chooseRepository({
    ticket: 'T-30-04',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    choice: 'clone',
  });

  assert.strictEqual(result.executable, false);
  assert.match(result.park_reason, /already exists and cannot be adopted/);
  assert.match(result.park_reason, /not available/);
  assert.ok(fs.lstatSync(destination).isSymbolicLink(), 'the dangling symlink must remain untouched');
});

test('state-sync and deliver name the configured resolver caller', () => {
  const stateSync = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs'), 'utf8');
  const deliver = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'commands', 'deliver.md'), 'utf8');
  assert.match(stateSync, /require\(path\.join\(__dirname, 'repo-resolve\.cjs'\)\)/);
  assert.match(stateSync, /resolveConfiguredRepo\(\{ repo, config: cfg \}\)/);
  assert.match(deliver, /repo-resolve\.cjs resolve <owner\/name>/);
  assert.match(deliver, /repo-resolve\.cjs choose <owner\/name>/);
  assert.match(deliver, /escalation-record\.cjs mark <T-id>/);
  assert.match(deliver, /resolution: "discovered"/);
});

done();
