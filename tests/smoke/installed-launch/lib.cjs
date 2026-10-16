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

module.exports = {
  ROOT, SOURCE, codexCapabilities, createFixture, runHost, runClassified, classifyLaunch,
  assertHarnessIsolation, assertNothingCreated, runWriteGuardControl,
};
