'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, describe, it } = require('node:test');
const lib = require('../smoke/installed-launch/lib.cjs');

const roots = [];

function descriptor() {
  const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-project-')));
  roots.push(workRoot);
  const home = path.join(workRoot, 'home');
  const bin = path.join(workRoot, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  return { workRoot, home, bin };
}

const hostEnv = (fixture) => ({ PATH: [fixture.bin, process.env.PATH].join(path.delimiter), HOME: fixture.home });
const gitEnv = (fixture) => ({ PATH: process.env.PATH, HOME: fixture.home, GIT_CONFIG_NOSYSTEM: '1' });
const git = (fixture, cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(fixture) });
const tracked = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function gh(fixture, cwd, ...args) {
  return spawnSync(path.join(fixture.bin, 'gh'), args, { cwd, encoding: 'utf8', env: hostEnv(fixture) });
}

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('fake gh', () => {
  const fixture = descriptor();
  const project = lib.stageClaudeProject(fixture, 'gh-shapes');
  const fake = lib.installFakeGh(fixture);

  it('answers every modelled shape from the project and from a subdirectory', () => {
    const sub = path.join(project.root, 'src');
    for (const cwd of [project.root, sub]) {
      const pr = JSON.parse(gh(fixture, cwd, 'pr', 'view', '7', '--json', 'number,headRefName,baseRefOid').stdout);
      assert.deepEqual(pr, { number: 7, headRefName: project.branch, baseRefOid: project.base });
      const open = JSON.parse(gh(fixture, cwd, 'pr', 'list', '--head', project.branch, '--state', 'open', '--limit', '5', '--json', 'number,headRefOid').stdout);
      assert.deepEqual(open, [{ number: 7, headRefOid: project.head }]);
      assert.deepEqual(JSON.parse(gh(fixture, cwd, 'pr', 'list', '--head', 'other', '--state', 'open', '--json', 'number').stdout), []);
      assert.deepEqual(JSON.parse(gh(fixture, cwd, 'pr', 'list', '--state', 'closed', '--json', 'number').stdout), []);
      assert.equal(gh(fixture, cwd, 'pr', 'list', '--state', 'all', '--json', 'number').stdout.trim(), '[{"number":7}]');
      assert.equal(gh(fixture, cwd, 'api', 'repos/{owner}/{repo}/branches', '--paginate', '--jq', '.[].name').stdout, `main\n${project.branch}\n`);
      assert.equal(gh(fixture, cwd, 'api', 'repos/{owner}/{repo}/compare/a...b', '--jq', '.ahead_by').stdout.trim(), '0');
      assert.equal(gh(fixture, cwd, 'api', `repos/{owner}/{repo}/commits/${project.head}/statuses`).stdout.trim(), '[]');
      const checks = gh(fixture, cwd, 'pr', 'checks', '7', '--json', 'name');
      assert.equal(checks.status, 0);
      assert.equal(checks.stdout.trim(), '[]');
      assert.equal(gh(fixture, cwd, 'repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name').stdout, 'main\n');
      const owner = JSON.parse(gh(fixture, cwd, 'repo', 'view', '--json', 'owner,name').stdout);
      assert.ok(owner.owner.login && owner.name);
    }
    const withRepo = gh(fixture, project.root, '--repo', 'a/b', 'pr', 'view', '7', '--json', 'number');
    assert.deepEqual(JSON.parse(withRepo.stdout), { number: 7 });
    assert.ok(fake.readCalls().length >= 20);
    assert.ok(fake.readCalls().every((call) => call.status === 0));
  });

  it('exits 2 and records every unmodelled call', () => {
    const outside = path.join(fixture.workRoot, 'elsewhere');
    fs.mkdirSync(outside);
    const before = fake.readCalls().length;
    const cases = [
      [project.root, ['auth', 'status']],
      [project.root, ['api', '-X', 'POST', 'repos/{owner}/{repo}/issues']],
      [outside, ['pr', 'view', '7', '--json', 'number']],
    ];
    for (const [cwd, args] of cases) {
      const result = gh(fixture, cwd, ...args);
      assert.equal(result.status, 2, args.join(' '));
      assert.ok(result.stderr.includes('fake gh: unmodelled call'), result.stderr);
    }
    const added = fake.readCalls().slice(before);
    assert.equal(added.length, 3);
    assert.ok(added.every((call) => call.status === 2));
  });

  it('makes no network call', () => {
    assert.ok(!/require\(['"]node:(https?|net|dns|tls)['"]\)|fetch\(/.test(fs.readFileSync(path.join(fixture.bin, 'gh'), 'utf8')));
  });
});

describe('stageClaudeProject', () => {
  it('builds a clean project whose remote, graph and fake gh agree', () => {
    const fixture = descriptor();
    const project = lib.stageClaudeProject(fixture, 'agree');
    assert.equal(git(fixture, project.root, 'status', '--porcelain', '--untracked-files=all').stdout, '');
    assert.equal(git(fixture, project.root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'main');
    assert.equal(git(fixture, project.root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim(), 'origin/main');
    const fetched = spawnSync('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      { cwd: project.root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fixture.home } });
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.equal(git(fixture, project.origin, 'rev-parse', `refs/heads/${project.branch}`).stdout.trim(), project.head);
    const graph = path.join(project.root, '.planning/graph');
    assert.ok(fs.statSync(graph).isDirectory());
    assert.equal(git(fixture, project.root, 'ls-files', '--', '.planning/graph').stdout, '');
    assert.ok(fs.readFileSync(path.join(project.root, '.git/info/exclude'), 'utf8').includes('.planning/graph/'));
    const tickets = JSON.parse(fs.readFileSync(path.join(graph, 'tickets.json'), 'utf8')).tickets;
    assert.deepEqual(Object.keys(tickets).sort(), [project.otherTicket, project.ticket].sort());
    for (const row of Object.values(tickets)) {
      assert.ok(Array.isArray(row.files) && row.files.length && typeof row.plan === 'string');
      assert.ok(['low', 'medium', 'high'].includes(row.risk));
      assert.equal(typeof row.human_checkpoint, 'boolean');
      assert.equal(typeof row.phase, 'string');
      const plan = fs.readFileSync(path.join(project.root, row.plan), 'utf8');
      assert.match(plan, /## Acceptance criteria\n\n- \S/);
    }
    const state = JSON.parse(fs.readFileSync(path.join(graph, 'delivery-state.json'), 'utf8'));
    const live = JSON.parse(gh(fixture, project.root, 'pr', 'view', '7', '--json', 'number,headRefName,headRefOid,baseRefName').stdout);
    const listed = JSON.parse(gh(fixture, project.root, 'pr', 'list', '--head', project.branch, '--state', 'open', '--json', 'number').stdout);
    assert.deepEqual(listed, [{ number: 7 }]);
    const entry = state[project.ticket];
    assert.equal(entry.status, 'pr-open');
    assert.deepEqual([entry.pr, entry.head_sha, entry.pr_base, entry.branch],
      [live.number, live.headRefOid, live.baseRefName, live.headRefName]);
    assert.equal(state[project.otherTicket].status, 'pending');
    const branches = gh(fixture, project.root, 'api', 'repos/{owner}/{repo}/branches', '--paginate', '--jq', '.[].name').stdout;
    assert.ok(!branches.includes(tickets[project.otherTicket].branch));
  });

  it('refuses a reused name, a bad name and a descriptor outside the work root, creating nothing', () => {
    const fixture = descriptor();
    lib.stageClaudeProject(fixture, 'once');
    assert.throws(() => lib.stageClaudeProject(fixture, 'once'), /already staged/);
    assert.throws(() => lib.stageClaudeProject(fixture, '../bad'), /project name/);
    assert.throws(() => lib.stageClaudeProject(fixture, 'Bad Name'), /project name/);
    const entries = (dir) => fs.readdirSync(dir).sort();
    const projects = entries(path.join(fixture.workRoot, 'projects'));
    assert.deepEqual(projects, ['once']);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-project-outside-')));
    roots.push(outside);
    for (const bad of [{ ...fixture, home: outside }, { ...fixture, bin: outside }, { ...fixture, workRoot: outside }]) {
      assert.throws(() => lib.stageClaudeProject(bad, 'nope'), /fixture/);
    }
    assert.deepEqual(entries(outside), []);
    assert.deepEqual(entries(path.join(fixture.workRoot, 'projects')), ['once']);
  });
});

describe('writeClaudeRoleRequest', () => {
  it('writes the four-field request under the work root, one new file per call', () => {
    const fixture = descriptor();
    const project = lib.stageClaudeProject(fixture, 'request');
    const first = lib.writeClaudeRoleRequest(fixture, project);
    const second = lib.writeClaudeRoleRequest(fixture, project);
    assert.notEqual(first, second);
    for (const file of [first, second]) {
      assert.equal(path.dirname(file), path.join(fixture.workRoot, 'requests'));
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        schema: 'shipyard.claude-role-request.v1', role: 'pr-sentinel', worktree: project.root, phase: project.phaseDir,
      });
    }
  });
});

describe('the staged Claude role host against the fixture', () => {
  it('reaches the fake claude exactly once per launch, on two launches of one project', { timeout: 240000 }, () => {
    const fixture = descriptor();
    const layout = lib.stageClaudeLayout(fixture);
    const claude = lib.installFakeClaude(fixture);
    const project = lib.stageClaudeProject(fixture, 'reach');
    const fake = lib.installFakeGh(fixture);
    const request = lib.writeClaudeRoleRequest(fixture, project);
    const env = { ...hostEnv(fixture), ...layout.env };
    const launch = () => spawnSync(process.execPath, [path.join(layout.scriptsDir, 'claude-role-host.cjs'), '--args-file', request],
      { cwd: project.root, env, encoding: 'utf8', timeout: 120000 });
    const nativeLines = () => claude.readLog().filter((line) => line.argv[0] === '--print');
    for (const expected of [1, 2]) {
      const run = launch();
      const stop = `stopped before the native call: first stderr line ${JSON.stringify(run.stderr.split('\n')[0])}, `
        + `last gh call ${tracked(fake.readCalls().slice(-1)[0])}`;
      assert.equal(nativeLines().length, expected, stop);
      const labels = [...run.stderr.matchAll(/hint\[([A-Za-z0-9_]+)\]/g)].map((match) => match[1]);
      for (const label of labels) assert.ok(label.startsWith('RUNTIME_EVIDENCE_'), `${label}: ${run.stderr}`);
      assert.equal(fake.readCalls().filter((call) => call.status === 2).length, 0, 'no unmodelled gh call');
      assert.equal(git(fixture, project.root, 'status', '--porcelain', '--untracked-files=all').stdout, '');
    }
    assert.ok(fs.existsSync(path.join(fixture.home, '.local/state/shipyard/role-artifact-authority')));
  });
});
