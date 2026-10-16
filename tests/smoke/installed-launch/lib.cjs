'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const SOURCE = path.join(ROOT, 'plugins/delivery-pipeline');
const REQUIRED_HELP_MARKERS = ['--json', '--model', '--config', '--cd', '--ignore-user-config'];
const NATIVE_EVIDENCE_FAMILY = 'RUNTIME_EVIDENCE_';
const GUARDED_WRITES = [
  'writeFile', 'appendFile', 'open', 'mkdir', 'mkdtemp', 'rename', 'link', 'symlink', 'copyFile', 'cp',
  'unlink', 'rm', 'rmdir', 'truncate', 'chmod', 'chown', 'lchown', 'utimes', 'lutimes', 'createWriteStream',
];

const fakeCodexSource = (logFile) => `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.162.1'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') { console.log(${JSON.stringify(REQUIRED_HELP_MARKERS.join(' '))}); process.exit(0); }
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: args, codexHome: process.env.CODEX_HOME || null }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
`;

const guardSource = (allowedRoot, logFile) => `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const allowed = ${JSON.stringify(allowedRoot)};
const logFile = ${JSON.stringify(logFile)};
const original = { appendFileSync: fs.appendFileSync, realpathSync: fs.realpathSync };
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
function physical(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try { return path.join(original.realpathSync(current), ...rest.reverse()); }
    catch (error) {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}
function targetOf(value) {
  if (value instanceof URL) return value.protocol === 'file:' ? value.pathname : null;
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === 'string' ? value : null;
}
function writes(flags) {
  if (typeof flags === 'number') return (flags & WRITE_FLAGS) !== 0;
  return typeof flags === 'string' && /[wa+]/.test(flags);
}
function check(name, value) {
  const raw = targetOf(value);
  if (raw === null) return;
  const real = physical(raw);
  if (real === allowed || real.startsWith(allowed + path.sep)) return;
  original.appendFileSync.call(fs, logFile, JSON.stringify({ call: name, path: real }) + '\\n');
}
function paths(name, args) {
  if (name === 'open') return writes(args[1]) ? [args[0]] : [];
  if (name === 'rename' || name === 'link' || name === 'copyFile' || name === 'cp') return [args[0], args[1]];
  if (name === 'symlink') return [args[1]];
  return [args[0]];
}
function wrap(holder, name, label) {
  const base = holder[name];
  if (typeof base !== 'function') return;
  holder[name] = function guarded(...args) {
    for (const value of paths(name, args)) check(label, value);
    return base.apply(this, args);
  };
}
for (const name of ${JSON.stringify(GUARDED_WRITES)}) {
  wrap(fs, name, name);
  wrap(fs, name + 'Sync', name + 'Sync');
  wrap(fs.promises, name, 'promises.' + name);
}
`;

function realDirectory(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(file, bytes, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function installerEnvironment(fixture) {
  return {
    PATH: fixture.path, HOME: fixture.home, CODEX_HOME: fixture.codexHome, LANG: 'C',
    SHIPYARD_GSD_AUTO_INSTALL: '0', SHIPYARD_CODEX_CAPABILITIES_FILE: fixture.hostEvidenceFile,
  };
}

function codexCapabilities() {
  const policy = require(path.join(SOURCE, 'scripts/model-policy.cjs'));
  const pairs = Object.values(policy.RUNTIME_ROLE_RUNG_DEFINITIONS.codex).flat()
    .map((rung) => ({ model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort }));
  return {
    supportedModels: [...new Set(pairs.map((pair) => pair.model))],
    supportedEfforts: [...new Set(pairs.map((pair) => pair.effort))],
    supportedSelections: pairs,
  };
}

function writeGuard(workRoot, name) {
  const file = path.join(workRoot, 'guards', name + '.cjs');
  const log = path.join(workRoot, 'guards', name + '.log');
  write(file, guardSource(workRoot, log));
  write(log, '');
  return { file, log };
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function createFixture() {
  const workRoot = realDirectory('shipyard-installed-launch-');
  const home = path.join(workRoot, 'home');
  const codexHome = path.join(workRoot, 'codex-home');
  const project = path.join(workRoot, 'project');
  const bin = path.join(workRoot, 'bin');
  const codexLog = path.join(workRoot, 'codex-calls.log');
  for (const directory of [home, project, bin]) fs.mkdirSync(directory, { recursive: true });
  write(codexLog, '');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const cli of ['npx', 'npm', 'curl', 'wget']) {
    write(path.join(bin, cli), '#!/bin/sh\necho "unexpected external CLI" >&2\nexit 99\n', 0o755);
  }
  write(path.join(bin, 'codex'), fakeCodexSource(codexLog), 0o755);
  write(path.join(codexHome, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs'),
    'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n');
  write(path.join(codexHome, 'gsd-core/bin/gsd-tools.cjs'), `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (args[0] !== 'capability' || args[1] !== 'install') process.exit(99);
fs.cpSync(args[2], path.join(process.env.GSD_CAPABILITIES_DIR, 'delivery-pipeline'), { recursive: true });
`);
  const hostEvidenceFile = path.join(workRoot, 'host-evidence.json');
  write(hostEvidenceFile, JSON.stringify(codexCapabilities()));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: project, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q', '-b', 'main');
  write(path.join(project, '.planning/config.json'), '{}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');

  const guard = writeGuard(workRoot, 'host');
  const fixture = {
    workRoot, home, bin, project, codexHome, hostEvidenceFile, guard,
    path: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    bundle: path.join(codexHome, 'shipyard'),
    scriptsDir: path.join(codexHome, 'shipyard/scripts'),
    agentsDir: path.join(codexHome, 'agents'),
    manifestFile: path.join(codexHome, 'agents/.shipyard-manifest.json'),
    bundleCapabilitiesFile: path.join(codexHome, 'shipyard/codex-capabilities.json'),
    readCodexLog: () => readJsonLines(codexLog),
    cleanup: () => fs.rmSync(workRoot, { recursive: true, force: true }),
  };
  const installed = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-shipyard-codex.sh'),
    '--phase', '2', '--project-dir', project], {
    cwd: project, env: installerEnvironment(fixture), encoding: 'utf8', timeout: 120000,
  });
  assert.equal(installed.status, 0, installed.stderr || String(installed.error));
  assert.ok(fs.existsSync(fixture.bundleCapabilitiesFile), 'installer must lay down the bundle capability file');
  assert.ok(fs.existsSync(fixture.manifestFile), 'installer must write the agents manifest');
  return fixture;
}

function runHost(fixture, script, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['--require', fixture.guard.file, script, ...args], {
    cwd: fixture.project,
    env: { PATH: fixture.path, HOME: fixture.home, ...extraEnv },
    encoding: 'utf8',
    timeout: 120000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function launchLabels(stderr) {
  const labels = [...stderr.matchAll(/hint\[([A-Za-z0-9_]+)\]/g)].map((match) => match[1]);
  if (/key is malformed|changed while reading/.test(stderr)) labels.push('ARCHIVE_AUTHORITY_INVALID');
  return [...new Set(labels)];
}

function classifyLaunch(run, cliLines) {
  const execs = Array.isArray(cliLines) ? cliLines.length : 0;
  const status = run && typeof run.status === 'number' ? run.status : null;
  const labels = launchLabels(run && typeof run.stderr === 'string' ? run.stderr : '');
  const result = (kind, terminal, reason) => ({ kind, execs, status, labels, terminal, reason });
  if (!run || run.signal || status === null) return result('unclassified', null, 'the host did not end with an exit status');
  if (execs > 1) return result('unclassified', null, 'the fake CLI logged more than one exec');
  if (execs === 1) {
    if (status === 0 && !labels.length) return result('reached', 'exit-0', 'one native exec and a clean exit');
    if (status !== 0 && labels.length && labels.every((label) => label.startsWith(NATIVE_EVIDENCE_FAMILY))) {
      return result('reached', 'runtime-evidence', 'one native exec, then missing native evidence');
    }
    return result('unclassified', null, 'one native exec ended outside the expected terminal outcomes');
  }
  if (status !== 0 && labels.length) return result('refused', 'refusal', 'no native exec and a named refusal');
  return result('unclassified', null, 'no native exec without a named refusal');
}

function runClassified(fixture, script, args, extraEnv = {}) {
  const before = fixture.readCodexLog().length;
  const run = runHost(fixture, script, args, extraEnv);
  const lines = fixture.readCodexLog().slice(before);
  return { run, lines, outcome: classifyLaunch(run, lines) };
}

function treeEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? [file, ...treeEntries(file)] : [file];
  });
}

function assertHarnessIsolation(fixture, { admitted = false } = {}) {
  const violations = readJsonLines(fixture.guard.log);
  assert.deepEqual(violations, [], 'the host wrote outside the harness work root');
  if (!admitted) return;
  const authority = path.join(fixture.home, '.local/state/shipyard/role-artifact-authority');
  assert.ok(fs.existsSync(authority), 'an admitted launch creates its authority state under the fixture HOME');
}

function assertNothingCreated(fixture) {
  assert.deepEqual(treeEntries(fixture.home), [], 'a refused launch must create nothing under the fixture HOME');
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: fixture.project, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: fixture.home },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, '', 'a refused launch must not touch the project');
}

function runWriteGuardControl(fixture) {
  const control = writeGuard(fixture.workRoot, 'control');
  const outside = fixture.workRoot + '-guard-control';
  const result = spawnSync(process.execPath, ['--require', control.file, '-e',
    'require("node:fs").writeFileSync(process.argv[1], "x")', outside], { encoding: 'utf8' });
  fs.rmSync(outside, { force: true });
  assert.equal(result.status, 0, result.stderr);
  return readJsonLines(control.log);
}

const CLAUDE_HELP_MARKERS = [
  '--model', '--effort', '--output-format', 'stream-json', '--session-id',
  '--permission-mode', '--permission-prompts', '--allowedTools', '--tools',
  '--restricted', '--strict-mcp-config', '--settings', '--setting-sources', '--agent',
  '--agents',
];
const PROJECT_PHASE = {
  phase: '99', phaseDir: '99-claude-fixture', ticket: 'T-99-01-claude-fixture',
  branch: 'ticket/t-99-01-claude-fixture', otherTicket: 'T-98-01-codex-fixture',
  otherPhase: '98', otherPhaseDir: '98-codex-fixture', otherBranch: 'ticket/t-98-01-codex-fixture',
};

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireFixtureRoots(fixture) {
  for (const key of ['workRoot', 'home', 'bin']) {
    if (!fixture || typeof fixture[key] !== 'string' || !path.isAbsolute(fixture[key])) {
      throw new Error(`fixture.${key} must be an absolute path`);
    }
  }
  const workRoot = path.resolve(fixture.workRoot);
  for (const key of ['home', 'bin']) {
    if (!inside(workRoot, path.resolve(fixture[key])) || path.resolve(fixture[key]) === workRoot) {
      throw new Error(`fixture.${key} must be inside the fixture work root`);
    }
  }
  return workRoot;
}

function inWorkRoot(workRoot, target) {
  const resolved = path.resolve(target);
  if (!inside(workRoot, resolved)) throw new Error(`refusing to write outside the fixture work root: ${resolved}`);
  return resolved;
}

function hermeticGit(fixture, cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: fixture.home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

function stageClaudeLayout(fixture) {
  const workRoot = requireFixtureRoots(fixture);
  const claudeHome = inWorkRoot(workRoot, path.join(fixture.home, '.claude'));
  const pluginRoot = inWorkRoot(workRoot, path.join(claudeHome, 'plugins/shipyard'));
  const tmpDir = inWorkRoot(workRoot, path.join(workRoot, 'tmp'));
  fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
  fs.cpSync(SOURCE, pluginRoot, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(tmpDir, 0o700);
  return { claudeHome, pluginRoot, scriptsDir: path.join(pluginRoot, 'scripts'), tmpDir, env: { TMPDIR: tmpDir } };
}

const fakeClaudeSource = (logFile) => `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(${JSON.stringify(CLAUDE_HELP_MARKERS.join(' '))}); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: args, envNames: Object.keys(process.env).sort() }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
`;

function installFakeClaude(fixture) {
  const workRoot = requireFixtureRoots(fixture);
  const executable = inWorkRoot(workRoot, path.join(fixture.bin, 'claude'));
  const logPath = inWorkRoot(workRoot, path.join(workRoot, 'claude-calls.log'));
  if (!fs.existsSync(logPath)) write(logPath, '');
  write(executable, fakeClaudeSource(logPath), 0o755);
  return { executable, logPath, readLog: () => readJsonLines(logPath) };
}

const fakeGhSource = (registryFile, callLog) => `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const registryFile = ${JSON.stringify(registryFile)};
const callLog = ${JSON.stringify(callLog)};
const raw = process.argv.slice(2);
const args = [];
for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] === '--repo') { i += 1; continue; }
  args.push(raw[i]);
}
function flag(name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }
function record(status) { fs.appendFileSync(callLog, JSON.stringify({ cwd: process.cwd(), args: raw, status }) + '\\n'); }
function unmodelled() {
  record(2);
  process.stderr.write('fake gh: unmodelled call: ' + raw.join(' ') + '\\n');
  process.exit(2);
}
function project() {
  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { return null; }
  let dir;
  try { dir = fs.realpathSync(process.cwd()); } catch { return null; }
  for (;;) {
    if (registry[dir]) return registry[dir];
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function pick(object, fields) {
  const out = {};
  for (const field of fields.split(',')) out[field] = object[field] === undefined ? null : object[field];
  return out;
}
function done(text) { record(0); process.stdout.write(text); process.exit(0); }
const entry = project();
if (!entry) unmodelled();
if (args.some((a) => ['-f', '-F', '-X', '--method', '--input', '--field', '--raw-field'].includes(a))) unmodelled();
const [group, action] = args;
if (group === 'repo' && action === 'view') {
  if (flag('--json') === 'defaultBranchRef' && flag('--jq') === '.defaultBranchRef.name') done(entry.defaultBranch + '\\n');
  if (flag('--json') === 'owner,name') done(JSON.stringify({ owner: { login: entry.owner }, name: entry.name }) + '\\n');
  unmodelled();
}
if (group === 'pr' && action === 'list' && flag('--json')) {
  const state = flag('--state');
  const head = flag('--head');
  if (!['open', 'closed', 'all'].includes(state)) unmodelled();
  const rows = entry.prs.filter((pr) => (state === 'all' || (state === 'open' ? pr.state === 'OPEN' : pr.state !== 'OPEN'))
    && (head === undefined || pr.headRefName === head));
  done(JSON.stringify(rows.map((pr) => pick(pr, flag('--json')))) + '\\n');
}
if (group === 'pr' && action === 'view' && /^\\d+$/.test(args[2] || '') && flag('--json')) {
  const pr = entry.prs.find((candidate) => candidate.number === Number(args[2]));
  if (!pr) unmodelled();
  done(JSON.stringify(pick(pr, flag('--json'))) + '\\n');
}
if (group === 'pr' && action === 'checks' && /^\\d+$/.test(args[2] || '')) done('[]\\n');
if (group === 'api') {
  const target = args[1] || '';
  if (/^repos\\/[^/]+\\/[^/]+\\/branches$/.test(target)) done(entry.branches.join('\\n') + '\\n');
  if (/^repos\\/[^/]+\\/[^/]+\\/compare\\/[^/]+(\\/[^/]+)*\\.\\.\\.[^/]+(\\/[^/]+)*$/.test(target)) done('0\\n');
  if (/^repos\\/[^/]+\\/[^/]+\\/commits\\/[0-9a-f]+\\/statuses$/.test(target)) done('[]\\n');
}
unmodelled();
`;

function installFakeGh(fixture) {
  const workRoot = requireFixtureRoots(fixture);
  const executable = inWorkRoot(workRoot, path.join(fixture.bin, 'gh'));
  const stateDir = inWorkRoot(workRoot, path.join(workRoot, 'gh-state'));
  const registryFile = path.join(stateDir, 'projects.json');
  const callLog = path.join(stateDir, 'calls.log');
  fs.mkdirSync(stateDir, { recursive: true });
  if (!fs.existsSync(registryFile)) write(registryFile, '{}\n');
  if (!fs.existsSync(callLog)) write(callLog, '');
  write(executable, fakeGhSource(registryFile, callLog), 0o755);
  return { executable, stateDir, registryFile, readCalls: () => readJsonLines(callLog) };
}

function planText(title) {
  return `---\nphase: fixture\n---\n\n# ${title}\n\n## Acceptance criteria\n\n- The fixture ticket is described.\n\n`
    + '## Verification commands\n\n- `node --version`\n';
}

function stageClaudeProject(fixture, name) {
  const workRoot = requireFixtureRoots(fixture);
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) throw new Error('project name must match ^[a-z0-9-]+$');
  const root = inWorkRoot(workRoot, path.join(workRoot, 'projects', name));
  const origin = inWorkRoot(workRoot, path.join(workRoot, 'origins', name + '.git'));
  if (fs.existsSync(root) || fs.existsSync(origin)) throw new Error(`project ${name} is already staged in this fixture`);
  const gh = installFakeGh(fixture);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  const git = (cwd, ...args) => hermeticGit(fixture, cwd, args);
  const { phase, phaseDir, ticket, branch, otherTicket, otherPhase, otherPhaseDir, otherBranch } = PROJECT_PHASE;
  git(root, 'init', '-q', '-b', 'main');
  write(path.join(root, 'src/fixture.txt'), 'base\n');
  write(path.join(root, '.planning/architecture/ADR-014-fixture.md'), '# ADR-014 fixture\n\nStatus: accepted\n');
  write(path.join(root, '.planning/config.json'), JSON.stringify({
    git: { base_branch: 'main' }, delivery_pipeline: { gsd_sync: false, integration_mode: 'direct-to-main' },
  }, null, 2) + '\n');
  const planFor = (dir, number) => `.planning/phases/${dir}/${number}-01-PLAN.md`;
  write(path.join(root, planFor(phaseDir, phase)), planText('Claude fixture'));
  write(path.join(root, planFor(otherPhaseDir, otherPhase)), planText('Codex fixture'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', branch);
  write(path.join(root, 'src/fixture.txt'), 'changed\n');
  git(root, 'commit', '-q', '-am', 'fixture change');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  git(workRoot, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main', branch);
  git(root, 'fetch', '-q', 'origin');
  git(root, 'remote', 'set-head', 'origin', 'main');
  const row = (plan, rowPhase, rowBranch) => ({
    title: 'Fixture ticket', plan, phase: rowPhase, repo: null, wave: 1, depends_on: [], cross_phase_deps: [],
    cross_repo_deps: [], files: ['src/fixture.txt'], risk: 'low', type: 'implementation',
    human_checkpoint: false, branch: rowBranch,
  });
  const graphDir = path.join(root, '.planning/graph');
  write(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: {
    [ticket]: row(planFor(phaseDir, phase), phase, branch),
    [otherTicket]: row(planFor(otherPhaseDir, otherPhase), otherPhase, otherBranch),
  } }, null, 2) + '\n');
  write(path.join(graphDir, 'delivery-state.json'), JSON.stringify({
    [ticket]: { status: 'pr-open', pr: 7, branch, pr_base: 'main', head_sha: head },
    [otherTicket]: { status: 'pending', pr: null, branch: otherBranch },
  }, null, 2) + '\n');
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '.planning/graph/\n');
  const registry = JSON.parse(fs.readFileSync(gh.registryFile, 'utf8'));
  registry[fs.realpathSync(root)] = {
    defaultBranch: 'main', owner: 'fixture-owner', name: name, branches: ['main', branch],
    prs: [{
      number: 7, state: 'OPEN', isDraft: false, headRefName: branch, headRefOid: head, baseRefName: 'main',
      baseRefOid: base, mergedAt: null, mergeCommit: null, reviewDecision: null,
      createdAt: '2026-01-01T00:00:00Z', url: 'https://example.invalid/fixture/pull/7', title: 'Fixture change',
      body: '', mergeStateStatus: 'CLEAN', author: { login: 'fixture-author' },
    }],
  };
  fs.writeFileSync(gh.registryFile, JSON.stringify(registry, null, 2) + '\n');
  return { root: fs.realpathSync(root), origin, phase, phaseDir, ticket, branch, head, base, otherTicket, otherPhase, otherPhaseDir };
}

function writeClaudeRoleRequest(fixture, project) {
  const workRoot = requireFixtureRoots(fixture);
  const directory = inWorkRoot(workRoot, path.join(workRoot, 'requests'));
  fs.mkdirSync(directory, { recursive: true });
  let index = fs.readdirSync(directory).length + 1;
  let file = path.join(directory, index + '.json');
  while (fs.existsSync(file)) { index += 1; file = path.join(directory, index + '.json'); }
  write(file, JSON.stringify({
    schema: 'shipyard.claude-role-request.v1', role: 'pr-sentinel', worktree: project.root, phase: project.phaseDir,
  }), 0o600);
  return file;
}

module.exports = {
  ROOT, SOURCE, codexCapabilities, createFixture, runHost, runClassified, classifyLaunch,
  assertHarnessIsolation, assertNothingCreated, runWriteGuardControl,
  stageClaudeLayout, installFakeClaude, installFakeGh, stageClaudeProject, writeClaudeRoleRequest,
};
