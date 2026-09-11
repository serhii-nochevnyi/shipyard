'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'repo-resolve.cjs'
);
const STATE_SYNC = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs'
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
  assert.deepStrictEqual(calls.map(({ command, args, options }) => ({ command, args, cwd: options.cwd })), [{
    command: 'gh',
    args: ['repo', 'view', 'acme/service', '--json', 'sshUrl,url'],
    cwd: '/project',
  }]);
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

test('clone command is full and proves the requested origin base ref', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const source = gitRepo();
  git(source, ['config', 'user.email', 'shipyard-tests@example.invalid']);
  git(source, ['config', 'user.name', 'Shipyard Tests']);
  fs.writeFileSync(path.join(source, 'README.md'), 'seed\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-qm', 'seed']);
  git(source, ['branch', 'epic/base']);

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
  assert.strictEqual(result.config_written, true);
  assert.strictEqual(result.base_ref, 'origin/epic/base');
  assert.strictEqual(result.base_verified, true);
  assert.strictEqual(result.repository_root, fs.realpathSync(destination));
  assert.deepStrictEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: 'git',
    args: ['clone', source, destination],
  }]);
  assert.strictEqual(git(destination, ['rev-parse', '--verify', 'refs/remotes/origin/epic/base^{commit}']).length, 40);
  const persisted = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf8'));
  assert.strictEqual(persisted.pipeline.repos['acme/service'], fs.realpathSync(destination));
});

test('clone parks a checkout when the required origin base is missing', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const source = gitRepo();
  git(source, ['config', 'user.email', 'shipyard-tests@example.invalid']);
  git(source, ['config', 'user.name', 'Shipyard Tests']);
  fs.writeFileSync(path.join(source, 'README.md'), 'seed\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-qm', 'seed']);
  const destination = path.join(parent, 'missing-base-service');

  const result = mod.cloneRepository({
    ticket: 'T-30-07',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    destination,
    base: 'epic/does-not-exist',
    cloneUrl: source,
  });

  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'clone-unverified');
  assert.strictEqual(result.base_verified, false);
  assert.match(result.park_reason, /origin\/epic\/does-not-exist/);
  assert.strictEqual(fs.existsSync(destination), true, 'verification must not hide the clone failure by deleting it');
});

test('a repeated clone adopts an existing matching checkout without invoking clone', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const destination = repoAt(path.join(parent, 'service'), 'git@github.com:acme/service.git');
  git(destination, ['config', 'user.email', 'shipyard-tests@example.invalid']);
  git(destination, ['config', 'user.name', 'Shipyard Tests']);
  fs.writeFileSync(path.join(destination, 'README.md'), 'adopted\n');
  git(destination, ['add', 'README.md']);
  git(destination, ['commit', '-qm', 'seed']);
  git(destination, ['update-ref', 'refs/remotes/origin/epic/base', 'HEAD']);
  let invoked = false;
  const result = mod.cloneRepository({
    ticket: 'T-30-08',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    destination,
    base: 'epic/base',
    cloneUrl: '/a/source-that-must-not-be-used',
  }, () => {
    invoked = true;
    throw new Error('matching checkout must be adopted before clone');
  });

  assert.strictEqual(result.executable, true, result.reason);
  assert.strictEqual(result.resolution, 'adopted');
  assert.strictEqual(result.adopted, true);
  assert.strictEqual(result.repository_root, destination);
  assert.strictEqual(result.base_ref, 'origin/epic/base');
  assert.strictEqual(result.base_verified, true);
  assert.strictEqual(invoked, false);
});

test('a matching clone destination without the requested base stays unverified', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  const destination = repoAt(path.join(parent, 'missing-base'), 'git@github.com:acme/service.git');
  const result = mod.cloneRepository({
    ticket: 'T-30-09',
    repo: 'acme/service',
    config: { repos: {}, repos_root: parent },
    projectRoot: projectDir,
    destination,
    base: 'epic/base',
    cloneUrl: '/a/source-that-must-not-be-used',
  }, () => { throw new Error('an unverified checkout must not invoke clone'); });

  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'clone-unverified');
  assert.strictEqual(result.base_verified, false);
  assert.match(result.park_reason, /required ref origin\/epic\/base is missing/);
  assert.strictEqual(fs.existsSync(destination), true);
});

test('an existing non-git or mismatched destination is refused untouched', () => {
  const projectDir = isolatedProject({});
  const parent = path.dirname(projectDir);
  for (const [name, setup, expected] of [
    ['plain-destination', (dir) => fs.mkdirSync(dir), /not a git repository/],
    ['wrong-origin', (dir) => repoAt(dir, 'git@github.com:someone-else/service.git'), /origin.*acme\/service/],
  ]) {
    const destination = path.join(parent, name);
    setup(destination);
    const before = fs.readdirSync(destination).sort();
    const result = mod.cloneRepository({
      ticket: 'T-30-08',
      repo: 'acme/service',
      config: { repos: {}, repos_root: parent },
      projectRoot: projectDir,
      destination,
      base: 'epic/base',
      cloneUrl: '/a/source-that-must-not-be-used',
    }, () => { throw new Error('existing destination must not be overwritten'); });
    assert.strictEqual(result.executable, false);
    assert.match(result.park_reason, expected);
    assert.deepStrictEqual(fs.readdirSync(destination).sort(), before);
  }
});

test('successful resolution writes one canonical path and the next cold start uses it', () => {
  const projectDir = isolatedProject({ custom_setting: 'keep-me' });
  const parent = path.dirname(projectDir);
  const checkout = repoAt(path.join(parent, 'service-with-an-unrelated-name'), 'git@github.com:acme/service.git');
  const first = mod.resolveAndPersistRepository({
    repo: 'acme/service',
    config: { repos: {} },
    projectRoot: projectDir,
  });
  assert.strictEqual(first.resolution, 'discovered');
  assert.strictEqual(first.executable, true, first.reason);
  assert.strictEqual(first.config_written, true);

  const file = path.join(projectDir, '.planning', 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.pipeline.custom_setting, 'keep-me');
  assert.strictEqual(raw.pipeline.repos['acme/service'], checkout);

  const loaded = require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs'));
  const second = mod.resolveAndPersistRepository({
    repo: 'acme/service',
    config: loaded.loadConfig(projectDir).config,
    projectRoot: projectDir,
  });
  assert.strictEqual(second.resolution, 'configured');
  assert.strictEqual(second.executable, true);
  assert.strictEqual(second.repository_root, checkout);
});

test('write-back prefers delivery_pipeline and preserves the legacy namespace', () => {
  const projectDir = isolatedProject({});
  const file = path.join(projectDir, '.planning', 'config.json');
  const checkout = repoAt(path.join(path.dirname(projectDir), 'preferred-service'), 'git@github.com:acme/service.git');
  fs.writeFileSync(file, JSON.stringify({
    keep: { owner: 'operator' },
    pipeline: { repos: { 'legacy/keep': '/legacy/path' }, old_key: true },
    delivery_pipeline: {
      models: { executor: 'opus' },
      repos: { 'legacy/preferred': '/preferred/path' },
    },
  }, null, 2) + '\n');

  const result = mod.persistResolvedRepository(projectDir, 'acme/service', checkout);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.written, true);
  assert.strictEqual(result.namespace, 'delivery_pipeline');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(raw.keep, { owner: 'operator' });
  assert.deepStrictEqual(raw.pipeline, { repos: { 'legacy/keep': '/legacy/path' }, old_key: true });
  assert.strictEqual(raw.delivery_pipeline.models.executor, 'opus');
  assert.strictEqual(raw.delivery_pipeline.repos['legacy/preferred'], '/preferred/path');
  assert.strictEqual(raw.delivery_pipeline.repos['acme/service'], checkout);

  const before = fs.readFileSync(file, 'utf8');
  const repeated = mod.persistResolvedRepository(projectDir, 'acme/service', checkout);
  assert.strictEqual(repeated.valid, true);
  assert.strictEqual(repeated.written, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'an unchanged path must not rewrite config');
});

test('write-back refuses malformed namespaces instead of falling back silently', () => {
  const projectDir = isolatedProject({});
  const file = path.join(projectDir, '.planning', 'config.json');
  const checkout = repoAt(path.join(path.dirname(projectDir), 'malformed-namespace-service'), 'git@github.com:acme/service.git');
  for (const raw of [
    { pipeline: { repos: {} }, delivery_pipeline: [] },
    { pipeline: { repos: {} }, delivery_pipeline: null },
    { pipeline: [], delivery_pipeline: {} },
    { pipeline: 'legacy', delivery_pipeline: { repos: {} } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const result = mod.persistResolvedRepository(projectDir, 'acme/service', checkout);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.written, false);
    assert.match(result.reason, /config write-back refused: (pipeline|delivery_pipeline) must be a JSON object/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  }
});

test('unparseable or malformed config is refused without changing the file', () => {
  const projectDir = isolatedProject({});
  const file = path.join(projectDir, '.planning', 'config.json');
  const checkout = repoAt(path.join(path.dirname(projectDir), 'unparseable-service'), 'git@github.com:acme/service.git');
  for (const contents of ['{broken\n', JSON.stringify({ pipeline: { repos: [] } }, null, 2) + '\n']) {
    fs.writeFileSync(file, contents);
    const before = fs.readFileSync(file, 'utf8');
    const result = mod.persistResolvedRepository(projectDir, 'acme/service', checkout);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.written, false);
    assert.match(result.reason, /write-back refused/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  }
});

test('a config write failure parks only the resolved repository with its reason', () => {
  const projectDir = isolatedProject({});
  const file = path.join(projectDir, '.planning', 'config.json');
  fs.writeFileSync(file, '{broken\n');
  const checkout = repoAt(path.join(path.dirname(projectDir), 'parked-service'), 'git@github.com:acme/service.git');
  const result = mod.resolveAndPersistRepository({
    repo: 'acme/service',
    config: { repos: {} },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.resolution, 'config-write-failed');
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolved_repository_root, checkout);
  assert.match(result.park_reason, /config write-back was refused/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken\n');
});

test('an invalid repository root refuses discovery instead of falling back to the project parent', () => {
  const projectDir = isolatedProject({});
  const result = mod.resolveRepository({
    repo: 'acme/service',
    config: { repos: {}, repos_root: null },
    projectRoot: projectDir,
  });
  assert.strictEqual(result.executable, false);
  assert.strictEqual(result.resolution, 'invalid-policy');
  assert.match(result.reason, /repos_root is invalid/);
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
  assert.match(rejected.park_reason, /nested inside (this )?project/);

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

test('state-sync and deliver name the repository resolver caller', () => {
  const stateSync = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs'), 'utf8');
  const deliver = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'commands', 'deliver.md'), 'utf8');
  assert.match(stateSync, /require\(path\.join\(__dirname, 'repo-resolve\.cjs'\)\)/);
  assert.match(stateSync, /resolveAndPersistRepository\(\{/);
  assert.match(stateSync, /configValid: CFG_VALID/);
  assert.match(stateSync, /repo_resolution/);
  assert.match(deliver, /repo-resolve\.cjs resolve <owner\/name>/);
  assert.match(deliver, /repo-resolve\.cjs choose <owner\/name>/);
  assert.match(deliver, /escalation-record\.cjs mark <T-id>/);
  assert.match(deliver, /repo-resolve\.cjs clone <owner\/name>/);
  assert.match(deliver, /atomically|atomic/i);
  assert.match(deliver, /inaccessible or\s+nonexistent/);
  assert.match(deliver, /resolution: "discovered"/);
});

test('state-sync persists discovered checkouts, copies resolution per ticket, and keeps other repos actionable', () => {
  const workspace = tempDir('shipyard-state-sync-repos-');
  const projectDir = path.join(workspace, 'project');
  const graphDir = path.join(projectDir, '.planning', 'graph');
  const phaseDir = path.join(projectDir, '.planning', 'phases', '30-reachability');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(phaseDir, { recursive: true });

  const acmeCheckout = repoAt(path.join(workspace, 'service-checkout'), 'git@github.com:acme/service.git');
  const betaCheckout = repoAt(path.join(workspace, 'other-checkout'), 'git@github.com:beta/other.git');
  fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), JSON.stringify({
    pipeline: { repos_root: workspace, auto_merge: 'off', sentinel: 'off' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(projectDir, '.planning', 'PROJECT.md'), '# shipyard\n\n## Core Value\nKeep delivery observable.\n');
  fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), [
    '# Roadmap: shipyard', '', '## Requirements', '',
    '- **REQ-30** — Reachable work remains executable.', '',
    '## Phases', '', '### Phase 30: Reachability',
    '**Requirements**: REQ-30', '',
  ].join('\n'));

  const tickets = {
    'T-30-10': { phase: '30', title: 'First service ticket', branch: 'ticket/T-30-10', files: ['src/service.js'], repo: 'acme/service' },
    'T-30-11': { phase: '30', title: 'Second service ticket', branch: 'ticket/T-30-11', files: ['src/other-service.js'], repo: 'acme/service' },
    'T-30-12': { phase: '30', title: 'Other repository ticket', branch: 'ticket/T-30-12', files: ['src/other.js'], repo: 'beta/other' },
    'T-30-13': { phase: '30', title: 'Unreachable repository ticket', branch: 'ticket/T-30-13', files: ['src/missing.js'], repo: 'missing/repo' },
  };
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets }, null, 2) + '\n');
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), '{}\n');
  for (const [ticket, entry] of Object.entries(tickets)) {
    const plan = ticket.slice(2).toLowerCase();
    fs.writeFileSync(path.join(phaseDir, `${plan}-PLAN.md`), [
      '---', 'phase: 30', `plan: ${ticket.slice(-2)}`, `title: "${entry.title}"`,
      `files_modified: [${entry.files.join(', ')}]`, 'requirements: [REQ-30]',
      'delivery:', `  ticket: ${ticket}`, '  risk: low', '  human_checkpoint: false', '---', '',
      `## Goal\n\n${entry.title}.`,
    ].join('\n'));
  }

  const bin = path.join(workspace, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, [
    '#!/bin/sh',
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf "[]\\n"; exit 0; fi',
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then printf "main\\n"; exit 0; fi',
    'if [ "$1" = "api" ]; then printf "main\\n"; exit 0; fi',
    'echo "unhandled gh call: $*" >&2; exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(gh, 0o755);

  const env = { ...process.env, HOME: path.join(workspace, 'home'), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const key of Object.keys(env)) {
    if (/^(?:SHIPYARD_|GSD_|CLAUDE_|CODEX_)/.test(key)
        || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  fs.mkdirSync(env.HOME, { recursive: true });
  const result = spawnSync(process.execPath, [STATE_SYNC], {
    cwd: projectDir,
    encoding: 'utf8',
    env,
  });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);

  const raw = JSON.parse(fs.readFileSync(path.join(projectDir, '.planning', 'config.json'), 'utf8'));
  assert.strictEqual(raw.pipeline.repos['acme/service'], acmeCheckout);
  assert.strictEqual(raw.pipeline.repos['beta/other'], betaCheckout);

  const state = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json'), 'utf8'));
  for (const ticket of ['T-30-10', 'T-30-11']) {
    assert.deepStrictEqual(state[ticket].repo_resolution, {
      resolution: 'discovered', executable: true, repository_root: acmeCheckout, reason: null,
    });
  }
  assert.deepStrictEqual(state['T-30-12'].repo_resolution, {
    resolution: 'discovered', executable: true, repository_root: betaCheckout, reason: null,
  });
  assert.strictEqual(state['T-30-12'].ready, true, 'a healthy sibling repo must remain actionable');
  assert.strictEqual(state['T-30-13'].ready, false, 'only the unreachable repo should be parked');
  assert.deepStrictEqual(state['T-30-13'].blocked_by, ['repo']);
});

done();
