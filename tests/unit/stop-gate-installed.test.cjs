'use strict';

delete process.env.SHIPYARD_GRAPH_DIR;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts');
const armer = require(path.join(SCRIPTS, 'stop-gate-arm.cjs'));

const tmp = (tag) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `shipyard-installed-${tag}-`)));
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const home = tmp('home');
const shim = tmp('bin');
const realMktemp = spawnSync('bash', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(shim, 'mktemp'),
  `#!/usr/bin/env bash\nif [ "$#" -eq 1 ] && [ "$1" = -d ]; then exec ${realMktemp} -d "${home}/tmp.XXXXXX"; fi\nexec ${realMktemp} "$@"\n`,
  { mode: 0o755 });
const install = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-shipyard-claude-hook.sh')], {
  cwd: ROOT, encoding: 'utf8',
  env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, HOME: home, CLAUDE_HOME: path.join(home, '.claude'), SHIPYARD_GSD_AUTO_INSTALL: '0' },
});
const STOP_DIR = path.join(home, '.claude', 'hooks', 'shipyard-stop-gate');
const INSTALLED = path.join(STOP_DIR, 'stop-gate.cjs');

function writeFront(dir, front) {
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'delivery-front.json'), JSON.stringify(front));
}

function fixture(liveNewer) {
  const root = tmp('repo');
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'init');
  const older = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const newer = new Date().toISOString();
  const a = path.join(root, 'wt-a');
  const b = path.join(root, 'wt-b');
  git(main, 'worktree', 'add', '-q', '-b', 'a', a);
  git(main, 'worktree', 'add', '-q', '-b', 'b', b);
  writeFront(a, { generated_at: liveNewer ? newer : older, actionable_count: 1, left_behind_count: 0,
    actionable: { execute: ['T-99-01'] } });
  writeFront(b, { generated_at: liveNewer ? older : newer, actionable_count: 0, left_behind_count: 0,
    actionable: {}, fixpoint: true });
  armer.arm(a, 'installed-a-0001');
  armer.arm(b, 'installed-b-0001');
  return { a, b };
}

function hook(script, cwd, sessionId) {
  const r = spawnSync('node', [script], { cwd, input: JSON.stringify({ session_id: sessionId }), encoding: 'utf8' });
  assert.equal(r.status, 0, `the hook must always exit 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

suite('stop-gate — the installed copied bundle');

test('the installer succeeds into a scratch CLAUDE_HOME', () => {
  assert.equal(install.status, 0, install.stderr);
  assert.ok(fs.existsSync(INSTALLED));
});

test('installed bundle files are byte-identical to the source', () => {
  const files = fs.readdirSync(STOP_DIR).filter((f) => f.endsWith('.cjs'));
  assert.ok(files.includes('stop-gate-arm.cjs'));
  for (const f of files) {
    assert.ok(fs.readFileSync(path.join(STOP_DIR, f)).equals(fs.readFileSync(path.join(SCRIPTS, f))), `${f} differs`);
  }
});

for (const liveNewer of [false, true]) {
  test(`installed and source hooks agree on two armed sessions (live board ${liveNewer ? 'newer' : 'older'})`, () => {
    const { a, b } = fixture(liveNewer);
    for (const script of [INSTALLED, path.join(SCRIPTS, 'stop-gate.cjs')]) {
      const va = hook(script, a, 'installed-a-0001');
      assert.ok(va && va.decision === 'block', `${script}: A blocks from its own board`);
      assert.equal(hook(script, b, 'installed-b-0001'), null, `${script}: B allows from its own board`);
    }
  });
}

done();
