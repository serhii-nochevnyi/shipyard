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

test('an invalid repository root refuses discovery instead of falling back to the project parent', () => {
  const projectDir = isolatedProject({});
  const result = mod.discoverRepository({
    ticket: 'T-30-05',
    repo: 'acme/service',
    config: { repos: {}, repos_root: null },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'invalid-policy');
  assert.strictEqual(result.discovery_status, 'invalid');
  assert.match(result.reason, /repos_root is invalid/);
});

test('a repository root that is an existing file refuses discovery', () => {
  const projectDir = isolatedProject({});
  const rootFile = path.join(path.dirname(projectDir), 'repos-root-file');
  fs.writeFileSync(rootFile, 'occupied\n');
  const result = mod.discoverRepository({
    ticket: 'T-30-05',
    repo: 'acme/service',
    config: { repos: {}, repos_root: rootFile },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'invalid-policy');
  assert.strictEqual(result.discovery_status, 'invalid');
  assert.match(result.reason, /repos_root is invalid/);
});

test('a configured directory inside another git checkout is trackable-only', () => {
  const parent = gitRepo();
  const nested = path.join(parent, 'nested-directory');
  fs.mkdirSync(nested);
  const result = mod.resolveConfiguredRepo({
    ticket: 'T-30-02',
    repo: 'acme/service',
    config: { repos: { 'acme/service': nested } },
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'track-only');
  assert.match(result.reason, /inside another git repository.*repository root/);
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

test('the discovery CLI passes an explicitly configured repository root to the resolver', () => {
  const configuredRoot = tempDir('shipyard-configured-repos-root-');
  const projectDir = path.join(configuredRoot, 'project');
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'config.json'),
    JSON.stringify({ pipeline: { repos_root: configuredRoot } }, null, 2) + '\n',
  );
  const checkout = repoAt(path.join(configuredRoot, 'checkout-found-only-under-configured-root'), 'git@github.com:acme/service.git');
  const result = run(['discover', 'acme/service', '--project-dir', projectDir, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.resolution, 'discovered');
  assert.strictEqual(output.repository_root, checkout);
  assert.ok(output.searched_roots.includes(configuredRoot));
});

test('the CLI keeps an invalid explicit checkout from falling through to discovery', () => {
  const parent = tempDir('shipyard-invalid-configured-repo-');
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'config.json'),
    JSON.stringify({ pipeline: { repos: { 'acme/service': 'relative-checkout' }, repos_root: parent } }, null, 2) + '\n',
  );
  repoAt(path.join(parent, 'valid-discovery'), 'git@github.com:acme/service.git');

  const result = run(['resolve', 'acme/service', '--project-dir', projectDir, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.resolution, 'track-only');
  assert.strictEqual(output.executable, false);
  assert.match(output.reason, /relative/);
});

test('a non-object delivery namespace does not suppress the legacy discovery root', () => {
  const configuredRoot = tempDir('shipyard-legacy-repos-root-');
  const projectDir = path.join(configuredRoot, 'project');
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'config.json'),
    JSON.stringify({ pipeline: { repos_root: configuredRoot }, delivery_pipeline: null }, null, 2) + '\n',
  );
  const checkout = repoAt(path.join(configuredRoot, 'legacy-root-checkout'), 'git@github.com:acme/service.git');

  const result = run(['discover', 'acme/service', '--project-dir', projectDir, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.resolution, 'discovered');
  assert.strictEqual(output.repository_root, checkout);
  assert.ok(output.searched_roots.includes(configuredRoot));
});

test('an explicit declared null root keeps precedence over a legacy root', () => {
  const parent = tempDir('shipyard-declared-null-repos-root-');
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.planning', 'config.json'),
    JSON.stringify({
      pipeline: { repos_root: parent },
      delivery_pipeline: { repos_root: null },
    }, null, 2) + '\n',
  );
  repoAt(path.join(parent, 'legacy-discovery'), 'git@github.com:acme/service.git');

  const result = run(['discover', 'acme/service', '--project-dir', projectDir, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.resolution, 'invalid-policy');
  assert.strictEqual(output.discovery_status, 'invalid');
  assert.strictEqual(output.executable, false);
});

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

test('clone command is full and proves the requested origin base ref', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const source = gitRepo();
  git(source, ['config', 'user.email', 'shipyard-tests@example.invalid']);
  git(source, ['config', 'user.name', 'Shipyard Tests']);
  git(source, ['remote', 'add', 'origin', 'git@github.com:acme/service.git']);
  fs.writeFileSync(path.join(source, 'README.md'), 'seed\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-qm', 'seed']);
  git(source, ['branch', 'epic/base']);
  git(source, ['update-ref', 'refs/remotes/origin/epic/base', git(source, ['rev-parse', 'refs/heads/epic/base'])]);

  const destination = path.join(parent, 'service');
  const calls = [];
  const result = mod.cloneRepository({
    ticket: 'T-30-07',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    destination,
    base: 'epic/base',
    cloneUrl: source,
  }, (command, args, options) => {
    calls.push({ command, args, options });
    return spawnSync(command, args, options);
  });

  assert.strictEqual(result.executable, true, result.reason);
  assert.strictEqual(result.resolution, 'cloned');
  assert.strictEqual(result.base_ref, 'origin/epic/base');
  assert.strictEqual(result.base_verified, true);
  assert.strictEqual(result.repository_root, fs.realpathSync(destination));
  assert.deepStrictEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: 'git',
    args: ['clone', '--origin', 'origin', source, destination],
  }, {
    command: 'git',
    args: ['-C', destination, 'remote', 'set-url', 'origin', 'git@github.com:acme/service.git'],
  }]);
  assert.strictEqual(git(destination, ['rev-parse', '--verify', 'refs/remotes/origin/epic/base^{commit}']).length, 40);
});

test('clone parks a checkout when the required origin base is missing', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const source = gitRepo();
  git(source, ['config', 'user.email', 'shipyard-tests@example.invalid']);
  git(source, ['config', 'user.name', 'Shipyard Tests']);
  git(source, ['remote', 'add', 'origin', 'git@github.com:acme/service.git']);
  fs.writeFileSync(path.join(source, 'README.md'), 'seed\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-qm', 'seed']);
  git(source, ['update-ref', 'refs/remotes/origin/epic/does-not-exist', git(source, ['rev-parse', 'HEAD'])]);
  const destination = path.join(parent, 'missing-base-service');

  const result = mod.cloneRepository({
    ticket: 'T-30-07',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    destination,
    base: 'epic/does-not-exist',
    cloneUrl: source,
  }, (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (command === 'git' && args[0] === 'clone') {
      const removed = spawnSync(
        'git',
        ['-C', destination, 'update-ref', '-d', 'refs/remotes/origin/epic/does-not-exist'],
        { encoding: 'utf8' },
      );
      assert.strictEqual(removed.status, 0, removed.stderr);
    }
    return result;
  });

  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'clone-unverified');
  assert.strictEqual(result.base_verified, false);
  assert.match(result.park_reason, /origin\/epic\/does-not-exist/);
  assert.strictEqual(fs.existsSync(destination), true, 'verification must not hide the clone failure by deleting it');
  const marker = JSON.parse(fs.readFileSync(path.join(destination, '.shipyard-clone-unverified.json'), 'utf8'));
  assert.deepStrictEqual(marker, {
    version: 1,
    kind: 'shipyard-clone-unverified',
    repo: 'acme/service',
    required_base: 'origin/epic/does-not-exist',
  });
});

test('discovery refuses a checkout quarantined after an unverified clone', () => {
  const parent = tempDir();
  const projectDir = path.join(parent, 'project');
  fs.mkdirSync(projectDir);
  const checkout = repoAt(path.join(parent, 'service'), 'git@github.com:acme/service.git');
  fs.writeFileSync(
    path.join(checkout, '.shipyard-clone-unverified.json'),
    JSON.stringify({
      version: 1,
      kind: 'shipyard-clone-unverified',
      repo: 'acme/service',
      required_base: 'origin/epic/missing',
    }, null, 2) + '\n',
  );

  const result = mod.discoverRepository({
    ticket: 'T-30-07',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'quarantined');
  assert.match(result.reason, /quarantined.*origin\/epic\/missing/);
});

test('explicit remote clone URLs require a classifiable project origin', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const result = mod.cloneRepository({
    ticket: 'T-30-07',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    destination: path.join(parent, 'service'),
    base: 'epic/base',
    projectOrigin: 'http://github.com/serhii-nochevnyi/shipyard.git',
    cloneUrl: 'https://github.com/acme/service.git',
  });
  assert.strictEqual(result.executable, false);
  assert.match(result.reason, /project origin.*unsupported/);
  assert.strictEqual(fs.existsSync(path.join(parent, 'service')), false);
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
  assert.strictEqual(
    prompt,
    'Repository acme/service needs an explicit checkout decision. Choose one: clone to /work/service, provide an existing checkout path, or skip for now (skip parks the ticket).',
  );
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
  assert.strictEqual(
    result.park_reason,
    'repository acme/service is not reachable; no operator choice was provided, so it was skipped',
  );
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
  assert.strictEqual(
    rejected.park_reason,
    `operator supplied a checkout for acme/service, but it was rejected: existing checkout "${wrongOrigin}" has an origin that does not resolve to acme/service`,
  );
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
  assert.match(rejected.park_reason, /nested inside this project/);

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
    projectOrigin: 'git@github.com:serhii-nochevnyi/shipyard.git',
    cloneMetadata: {
      sshUrl: 'git@github.com:acme/service.git',
      url: 'https://github.com/acme/service.git',
    },
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'track-only');
  assert.strictEqual(result.decision, 'clone');
  assert.strictEqual(result.operator_choice, 'clone');
  assert.strictEqual(result.destination, destination);
  assert.strictEqual(result.clone_url, 'git@github.com:acme/service.git');
  assert.strictEqual(result.clone_protocol, 'ssh');
  assert.strictEqual(result.clone_source, 'sshUrl');
  assert.strictEqual(result.park_reason, 'operator chose clone for acme/service; clone is pending a delivery step');
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

test('clone URL selection follows the project origin protocol', () => {
  const ssh = mod.selectCloneUrl(
    'git@github.com:serhii-nochevnyi/shipyard.git',
    { sshUrl: 'git@github.com:Acme/Service.git', url: 'https://github.com/Acme/Service.git' },
    'acme/service',
  );
  assert.deepStrictEqual(ssh, {
    valid: true,
    protocol: 'ssh',
    field: 'sshUrl',
    url: 'git@github.com:Acme/Service.git',
    reason: null,
  });

  const https = mod.selectCloneUrl(
    'https://github.com/serhii-nochevnyi/shipyard.git',
    { sshUrl: 'git@github.com:Acme/Service.git', url: 'https://github.com/Acme/Service.git' },
    'acme/service',
  );
  assert.strictEqual(https.valid, true);
  assert.strictEqual(https.protocol, 'https');
  assert.strictEqual(https.field, 'url');
  assert.strictEqual(https.url, 'https://github.com/Acme/Service.git');

  const http = mod.selectCloneUrl(
    'http://github.com/serhii-nochevnyi/shipyard.git',
    { sshUrl: 'git@github.com:Acme/Service.git', url: 'http://github.com/Acme/Service.git' },
    'acme/service',
  );
  assert.strictEqual(http.valid, false);
  assert.match(http.reason, /neither SSH nor HTTPS/);
});

test('clone URL selection refuses inconsistent metadata and credentials', () => {
  const wrongProtocol = mod.selectCloneUrl(
    'git@github.com:serhii-nochevnyi/shipyard.git',
    { sshUrl: 'https://github.com/acme/service.git' },
    'acme/service',
  );
  assert.strictEqual(wrongProtocol.valid, false);
  assert.match(wrongProtocol.reason, /project origin protocol/);
  assert.strictEqual(wrongProtocol.url, null);

  const credential = mod.selectCloneUrl(
    'https://github.com/serhii-nochevnyi/shipyard.git',
    { url: 'https://token@github.com/acme/service.git' },
    'acme/service',
  );
  assert.strictEqual(credential.valid, false);
  assert.match(credential.reason, /credentials/);
  assert.strictEqual(credential.url, null);
  assert.ok(!JSON.stringify(credential).includes('token'));

  const query = mod.selectCloneUrl(
    'https://github.com/serhii-nochevnyi/shipyard.git',
    { url: 'https://github.com/acme/service.git?ref=release' },
    'acme/service',
  );
  assert.strictEqual(query.valid, false);
  assert.strictEqual(query.reason, 'gh metadata URL for acme/service contains query or fragment data and was refused');
  assert.strictEqual(query.url, null);

  const fragment = mod.selectCloneUrl(
    'https://github.com/serhii-nochevnyi/shipyard.git',
    { url: 'https://github.com/acme/service.git#release' },
    'acme/service',
  );
  assert.strictEqual(fragment.valid, false);
  assert.strictEqual(fragment.reason, 'gh metadata URL for acme/service contains query or fragment data and was refused');
  assert.strictEqual(fragment.url, null);
});

test('gh metadata is read with the explicit repository and JSON fields', () => {
  const calls = [];
  const metadata = mod.readGhRepositoryMetadata('acme/service', '/project', (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: JSON.stringify({ sshUrl: 'git@github.com:acme/service.git', url: 'https://github.com/acme/service.git' }),
    };
  });
  assert.deepStrictEqual(metadata, {
    valid: true,
    metadata: { sshUrl: 'git@github.com:acme/service.git', url: 'https://github.com/acme/service.git' },
    reason: null,
  });
  assert.deepStrictEqual(calls.map(({ command, args, options }) => ({
    command,
    args,
    cwd: options.cwd,
    promptDisabled: options.env.GH_PROMPT_DISABLED,
  })), [{
    command: 'gh',
    args: ['repo', 'view', 'acme/service', '--json', 'sshUrl,url'],
    cwd: '/project',
    promptDisabled: '1',
  }]);
  assert.strictEqual(calls[0].options.env.GH_PROMPT_DISABLED, '1');
});

test('clone preparation reports unavailable metadata without invoking git clone', () => {
  const result = mod.resolveCloneUrl({
    repo: 'acme/service',
    projectRoot: '/project',
    projectOrigin: 'https://github.com/serhii-nochevnyi/shipyard.git',
    cloneMetadata: {},
  });
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /no usable url/);
  assert.strictEqual(result.url, null);
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
  assert.strictEqual(fs.lstatSync(destination).isSymbolicLink(), true, 'the dangling symlink must remain untouched');
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
