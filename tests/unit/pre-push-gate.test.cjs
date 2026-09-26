'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'shipyard-pre-push-gate.sh');

const trash = [];
process.on('exit', () => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function gitEnv(gitconfig) {
  return { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  return (r.stdout || '').trim();
}

function initRepo(dir, env) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir], { env });
  git(dir, ['config', 'user.email', 'pph@example.com'], env);
  git(dir, ['config', 'user.name', 'pph test'], env);
  git(dir, ['config', 'commit.gpgsign', 'false'], env);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init'], env);
}

function writeStubGate(logPath, ticketLogPath) {
  const gatePath = path.join(path.dirname(logPath), 'stub-publish-gate.cjs');
  fs.writeFileSync(gatePath, [
    "const fs = require('fs');",
    "const i = process.argv.indexOf('--worktree');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, (i === -1 ? 'NO-WORKTREE-ARG' : process.argv[i + 1]) + '\\n');`,
    "const t = process.argv.indexOf('--ticket');",
    `fs.appendFileSync(${JSON.stringify(ticketLogPath)}, (t === -1 ? 'NO-TICKET-ARG' : process.argv[t + 1]) + '\\n');`,
    'process.exit(0);',
    '',
  ].join('\n'));
  return gatePath;
}

function fixture() {
  // @invariant: realpath'd — git rev-parse --show-toplevel reports /private/tmp, not macOS's /tmp symlink
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-pph-')));
  trash.push(root);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const env = gitEnv(gitconfig);
  const repoA = path.join(root, 'repoA');
  const repoB = path.join(root, 'repoB');
  initRepo(repoA, env);
  initRepo(repoB, env);
  fs.mkdirSync(path.join(repoB, 'sub'), { recursive: true });
  const logPath = path.join(root, 'gate.log');
  const ticketLogPath = path.join(root, 'ticket.log');
  const gatePath = writeStubGate(logPath, ticketLogPath);
  return { root, env, repoA, repoB, logPath, ticketLogPath, gatePath };
}

function runHook({ env, gatePath, cwd, command, payloadCwd }) {
  const payload = JSON.stringify({ tool_input: { command }, cwd: payloadCwd });
  const r = spawnSync('bash', [HOOK], {
    cwd,
    input: payload,
    encoding: 'utf8',
    env: { ...env, SHIPYARD_PUBLISH_GATE: gatePath },
  });
  return r;
}

function readLog(logPath) {
  try { return fs.readFileSync(logPath, 'utf8').trim(); } catch { return null; }
}

const REMEDY = /git -C <absolute worktree> push/;

suite('shipyard-pre-push-gate — resolves the push target through git');

test('cd "$W"; git push — $W never expanded, so it cannot resolve; refuses naming the remedy', () => {
  const { env, gatePath, repoA, logPath } = fixture();
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: 'cd "$W"; git push' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, REMEDY);
  assert.equal(readLog(logPath), null, 'the gate must never be invoked on an unresolvable target');
});

test('git -C "$W" push — same unexpanded case through the -C flag; refuses naming the remedy', () => {
  const { env, gatePath, repoA, logPath } = fixture();
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: 'git -C "$W" push' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, REMEDY);
  assert.equal(readLog(logPath), null);
});

test('cd <abs B>; git push — a bare trailing `;` must not become part of the path', () => {
  const { env, gatePath, repoA, repoB, logPath } = fixture();
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: `cd ${repoB}; git push` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(logPath), repoB);
});

test('git -C <abs repo B> push — from a session cwd in repo A, gates B', () => {
  const { env, gatePath, repoA, repoB, logPath } = fixture();
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: `git -C ${repoB} push` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(logPath), repoB);
});

test('cd <subdir of B> && git push — gates B\'s toplevel, not the subdirectory', () => {
  const { env, gatePath, repoA, repoB, logPath } = fixture();
  const sub = path.join(repoB, 'sub');
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: `cd ${sub} && git push` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(logPath), repoB);
});

test('plain git push — no named target, gates the git toplevel of cwd', () => {
  const { env, gatePath, repoB, logPath } = fixture();
  const r = runHook({ env, gatePath, cwd: repoB, payloadCwd: repoB, command: 'git push' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(logPath), repoB);
});

test('a nonexistent -C path refuses naming the remedy', () => {
  const { env, gatePath, repoA, root, logPath } = fixture();
  const missing = path.join(root, 'does-not-exist');
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: `git -C ${missing} push` });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, REMEDY);
  assert.equal(readLog(logPath), null);
});

test('a command without `git push` exits 0 without ever calling the gate', () => {
  const { env, gatePath, repoA, logPath } = fixture();
  const r = runHook({ env, gatePath, cwd: repoA, payloadCwd: repoA, command: 'git status' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(logPath), null);
});

test('a push of ticket/T-43-02-x invokes the gate with --ticket T-43-02', () => {
  const { env, gatePath, repoB, ticketLogPath } = fixture();
  git(repoB, ['checkout', '-q', '-b', 'ticket/T-43-02-x'], env);
  const r = runHook({ env, gatePath, cwd: repoB, payloadCwd: repoB, command: 'git push' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(ticketLogPath), 'T-43-02');
});

test('a push of feat/x keeps --ticket publish', () => {
  const { env, gatePath, repoB, ticketLogPath } = fixture();
  git(repoB, ['checkout', '-q', '-b', 'feat/x'], env);
  const r = runHook({ env, gatePath, cwd: repoB, payloadCwd: repoB, command: 'git push' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(ticketLogPath), 'publish');
});

done();
