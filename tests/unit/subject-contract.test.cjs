'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const authorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subject-contract-authority-')));
const originalHomedir = os.homedir;
os.homedir = () => authorityHome;
process.on('exit', () => {
  os.homedir = originalHomedir;
  fs.rmSync(authorityHome, { recursive: true, force: true });
});
const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subject-contract-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function repo(name, remote) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

const D = 'd'.repeat(64), H = 'a'.repeat(40), B = 'b'.repeat(40);
const FIELDS = {
  'planning-input': repository => ({ phase: 50, input: 'INV-017', repository }),
  'decomposition-seal': repository => ({ phase: 50, repository, adr: D }),
  integrator: repository => ({ phase: '50-make-launch', repository, tickets: D }),
  'architecture-review': repository => ({ phase: '50-make-launch', repository, tickets: D, pr: 9, head: H, base: B }),
};

test('identity is equal from the root and from a linked worktree', () => {
  const root = repo('plain');
  const linked = path.join(scratch, 'plain-linked');
  git(root, 'worktree', 'add', '-q', linked, '-b', 'linked');
  assert.equal(target.repositoryIdentity(linked), target.repositoryIdentity(root));
  assert.equal(target.repositoryIdentity(root), path.join(root, '.git'));
});

test('identity works for a path with a space and a non-ASCII path', () => {
  for (const name of ['with space', 'репо']) {
    const root = repo(name);
    assert.equal(target.repositoryIdentity(root), path.join(root, '.git'));
  }
});

test('identity refuses a semicolon, a tab and a failing git', () => {
  for (const name of ['semi;colon', 'tab\there']) {
    const root = repo(name);
    assert.throws(() => target.repositoryIdentity(root), { code: 'REPOSITORY_IDENTITY_INVALID' });
  }
  assert.throws(() => target.repositoryIdentity(path.join(scratch, 'absent')), { code: 'REPOSITORY_IDENTITY_INVALID' });
});

test('identity makes its git call through the injected runner only', () => {
  const root = repo('injected');
  const calls = [];
  const value = target.repositoryIdentity(root, { execFileSync: (...args) => { calls.push(args); return '.git\n'; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-C', root, 'rev-parse', '--git-common-dir']);
  assert.equal(value, path.join(root, '.git'));
});

test('every family round-trips every repository form', () => {
  const values = ['/Volumes/KINGSTON/claude-shipyard/.git', '/Volumes/My Disk/shipyard/.git', '/Users/сергій/репо/.git', 'serhii-nochevnyi/shipyard'];
  for (const [name, make] of Object.entries(FIELDS)) {
    for (const value of values) {
      const fields = make(value);
      const parsed = target.parseSubject(name, target.buildSubject(name, fields));
      assert.ok(parsed, `${name} ${value}`);
      for (const [key, expected] of Object.entries(fields)) assert.equal(parsed[key], String(expected));
    }
  }
});

test('every family rejects a semicolon or control character in builder and parser', () => {
  for (const [name, make] of Object.entries(FIELDS)) {
    for (const bad of ['/a;b/.git', '/a\tb/.git', '/a\nb/.git', '']) {
      assert.throws(() => target.buildSubject(name, make(bad)), /repository/);
    }
    const good = target.buildSubject(name, make('/ok/.git'));
    for (const bad of ['/a;b/.git', '/a\tb/.git']) {
      assert.equal(target.parseSubject(name, good.replace('/ok/.git', bad)), null);
    }
  }
  assert.throws(() => target.buildSubject('nope', {}), /unknown subject family/);
});

test('PHASE_SUBJECT accepts a space and a non-ASCII character and rejects a semicolon', () => {
  const make = repository => `phase=50-x;repository=${repository};tickets=${D};pr=1;head=${H};base=${B}`;
  assert.ok(target.PHASE_SUBJECT.test(make('/Volumes/My Disk/репо/.git')));
  assert.ok(!target.PHASE_SUBJECT.test(make('/a;b/.git')));
});

test('accepted values list the identity first and the legacy owner/repo second', () => {
  const withRemote = repo('remote', 'git@github.com:Serhii-Nochevnyi/Shipyard.git');
  assert.deepEqual(target.acceptedRepositoryValues(withRemote), [path.join(withRemote, '.git'), 'serhii-nochevnyi/shipyard']);
  const without = repo('no-remote');
  assert.deepEqual(target.acceptedRepositoryValues(without), [path.join(without, '.git'), without]);
});

test('a repository without a github.com origin also accepts its old project-root path form', () => {
  for (const [name, remote] of [['gitlab-origin', 'git@gitlab.com:acme/mine.git'], ['bitbucket-origin', 'https://bitbucket.org/acme/mine.git'],
    ['ghe-origin', 'https://github.example.com/acme/mine.git'], ['no-origin', null]]) {
    const root = repo(name, remote);
    assert.deepEqual(target.legacyRepositoryForms(root), [root], name);
    const accepted = target.acceptedRepositoryValues(root);
    assert.ok(accepted.includes(root), name);
    assert.ok(!accepted.includes(path.join(scratch, 'unrelated')), name);
    assert.ok(!accepted.includes(path.dirname(root)), name);
  }
  const linkedRoot = repo('path-main');
  const linked = path.join(scratch, 'path-linked');
  git(linkedRoot, 'worktree', 'add', '-q', linked, '-b', 'path-linked');
  assert.deepEqual(target.legacyRepositoryForms(linked).sort(), [linked, linkedRoot].sort());
  const github = repo('path-github', 'git@github.com:Acme/Mine.git');
  assert.deepEqual(target.legacyRepositoryForms(github), ['acme/mine']);
  assert.deepEqual(target.legacyRepositoryForms(path.join(scratch, 'absent')), []);
});

test('a path form that the shared repository class refuses is not accepted', () => {
  const root = repo('legacy;semi');
  assert.deepEqual(target.legacyRepositoryForms(root), []);
});

test('consumers accept the shared class for planning-input, decomposition-seal and arch-review subjects', () => {
  const { normalizeTicketIdentity } = require('../../plugins/delivery-pipeline/scripts/run-contract.cjs');
  const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
  const sha = 'a'.repeat(64);
  const head = 'b'.repeat(40);
  for (const repository of ['/work/my repo/.git', '/work/дім/.git', 'owner/repo', '/plain/.git']) {
    const input = target.buildSubject('planning-input', { phase: 3, input: 'INV-001', repository });
    assert.equal(normalizeTicketIdentity(input, { role: 'decomposition', phase: 3 }).ticket, input);
    const review = target.buildSubject('architecture-review', { phase: '3-x', repository, tickets: sha, pr: 4, head, base: head });
    assert.equal(normalizeTicketIdentity(review, { role: 'arch-review', phase: 3 }).ticket, review);
    const seal = target.buildSubject('decomposition-seal', { phase: 3, repository, adr: sha });
    assert.ok(sealer.decompositionAdr.SUBJECT_PATTERN.test(seal));
  }
  assert.throws(() => normalizeTicketIdentity('phase=3;input=INV-001;repository=a;b', { role: 'decomposition', phase: 3 }));
  assert.throws(() => normalizeTicketIdentity('phase=3;input=INV-001;repository=a\tb', { role: 'decomposition', phase: 3 }));
  assert.throws(() => normalizeTicketIdentity('T-1 2', { role: 'executor' }));
  assert.throws(() => sealer.decompositionAdr.decompositionSubject({ phase: 3, repository: 'a;b', adr: { sha256: sha } }), /DECOMPOSITION_SUBJECT_INVALID|repository/);
});

test('a decomposition seal with the old owner/repo form verifies only through acceptedRepositories', () => {
  const { decompositionAdr } = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
  const dir = path.join(scratch, 'adr');
  fs.mkdirSync(path.join(dir, '.planning/architecture'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning/architecture/ADR-1.md'), 'adr');
  const adr = decompositionAdr.resolveAdr(dir, '.planning/architecture/ADR-1.md');
  const subject = target.buildSubject('decomposition-seal', { phase: 3, repository: 'owner/repo', adr: adr.sha256 });
  const base = { worktree: dir, repository: '/w/my repo/.git', adr };
  assert.throws(() => decompositionAdr.assertDecompositionSubject(subject, base), /different repository/);
  assert.equal(decompositionAdr.assertDecompositionSubject(subject, { ...base, acceptedRepositories: ['owner/repo'] }).repository, 'owner/repo');
  const other = target.buildSubject('decomposition-seal', { phase: 3, repository: 'x/y', adr: adr.sha256 });
  assert.throws(() => decompositionAdr.assertDecompositionSubject(other, { ...base, acceptedRepositories: ['owner/repo'] }), /different repository/);
  const bad = target.buildSubject('decomposition-seal', { phase: 3, repository: 'owner/repo', adr: 'c'.repeat(64) });
  assert.throws(() => decompositionAdr.assertDecompositionSubject(bad, { ...base, acceptedRepositories: ['owner/repo'] }), /digest/);
});

const SCRIPTS = '../../plugins/delivery-pipeline/scripts/';
const PATH_FORMS = [['plain', 'plain-repo'], ['space', 'with space'], ['non-ascii', 'репо-дім']];
const writeFile = (root, relative, text) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function planningFixture(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  const row = { branch: 'ticket/T-43-15-demo', plan: '.planning/phases/43-demo/43-01-PLAN.md', type: 'implementation',
    phase: 43, risk: 'low', human_checkpoint: false, critical: false, files: ['src/thing.js'], pr_base: 'main', repo: null };
  writeFile(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json', JSON.stringify({ name: 'shipyard' }));
  writeFile(root, '.planning/graph/tickets.json', JSON.stringify({ tickets: { 'T-43-15': row } }));
  writeFile(root, '.planning/graph/delivery-state.json', JSON.stringify({ 'T-43-15': { ready: true } }));
  writeFile(root, '.planning/investigations/INV-43-15/PROBLEM.md', '---\nadr: .planning/architecture/ADR-TEST.md\n---\n\n# Problem\n');
  writeFile(root, '.planning/investigations/INV-43-15/RESEARCH-CONTRACT.md', '# Research contract\n');
  writeFile(root, '.planning/investigations/INV-43-15/DECISIONS.md', '# Decisions\n');
  writeFile(root, '.planning/architecture/ADR-TEST.md', '# Planning ADR\n');
  writeFile(root, '.planning/REQUIREMENTS.md', '# Requirements\n');
  writeFile(root, '.planning/ROADMAP.md', '# Roadmap\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  return root;
}

for (const [label, dirName] of PATH_FORMS) {
  test(`planning-input and decomposition-seal subjects round-trip from the real producers (${label} path)`, () => {
    const { normalizeTicketIdentity } = require(SCRIPTS + 'run-contract.cjs');
    const sealer = require(SCRIPTS + 'planning-result-sealer.cjs');
    const builder = require(SCRIPTS + 'deliver-dispatch.cjs');
    const codexPlanning = require(SCRIPTS + 'codex-planning-context-host.cjs');
    const claudeDecompose = require(SCRIPTS + 'claude-decompose-host.cjs');
    const codexDecompose = require(SCRIPTS + 'codex-decompose-host.cjs');
    const root = planningFixture(`planning-${dirName}`);
    const identity = target.repositoryIdentity(root);
    const graphDir = path.join(root, '.planning/graph');
    for (const runtime of ['claude', 'codex']) {
      const request = builder.build(['decomposition', 'INV-43-15', '--phase', '44', '--runtime', runtime], { cwd: root, graphDir });
      if (runtime === 'claude') assert.equal(claudeDecompose.canonicalRequest(request).worktree, fs.realpathSync(root));
      else {
        assert.equal(normalizeTicketIdentity(request.scope.ticket, { role: 'decomposition', phase: request.scope.phase }).ticket, request.scope.ticket);
        const { scope: _scope, ...launch } = request;
        assert.equal(codexPlanning.requestValue(launch, { worktreePath: root }).contextPacket.role, 'decomposition');
      }
    }
    const input = target.buildSubject('planning-input', { phase: 44, input: 'INV-43-15', repository: identity });
    assert.equal(normalizeTicketIdentity(input, { role: 'decomposition', phase: 44 }).ticket, input);
    assert.equal(target.parseSubject('planning-input', input).repository, identity);
    const adr = sealer.decompositionAdr.resolveAdr(root, '.planning/architecture/ADR-TEST.md');
    const sealed = codexDecompose.sealScope({ worktree: root, phase: 44 }, { receipt: { policy_hash: 'p'.repeat(64) }, result: {} }, 'x');
    assert.equal(sealed.repository, identity);
    const subject = sealer.decompositionAdr.decompositionSubject({ phase: 44, repository: sealed.repository, adr });
    assert.equal(sealer.decompositionAdr.assertDecompositionSubject(subject, { worktree: root, repository: identity, adr }).repository, identity);
    assert.ok(sealer.decompositionAdr.SUBJECT_PATTERN.test(subject));
    const legacy = target.buildSubject('decomposition-seal', { phase: 44, repository: 'owner/repo', adr: adr.sha256 });
    assert.equal(sealer.decompositionAdr.assertDecompositionSubject(legacy, { worktree: root, repository: identity, adr, acceptedRepositories: ['owner/repo'] }).repository, 'owner/repo');
  });
}

test('planning and decomposition producers refuse a semicolon path at the identity step', () => {
  const sealer = require(SCRIPTS + 'planning-result-sealer.cjs');
  const codexDecompose = require(SCRIPTS + 'codex-decompose-host.cjs');
  const root = planningFixture('planning-semi;colon');
  assert.throws(() => codexDecompose.sealScope({ worktree: root, phase: 44 }, { receipt: { policy_hash: 'p'.repeat(64) }, result: {} }, 'x'),
    { code: 'REPOSITORY_IDENTITY_INVALID' });
  assert.throws(() => sealer.decompositionAdr.decompositionSubject({ phase: 44, repository: path.join(root, '.git'), adr: D }), /repository|DECOMPOSITION_SUBJECT_INVALID/);
});

function integratorFixture(name) {
  const root = path.join(scratch, name);
  const phase = '38-role-host-test';
  const ticket = 'T-38-01-role-host';
  const epic = `epic/${phase}`;
  const ticketBranch = `ticket/${ticket}`;
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  const plan = `.planning/phases/${phase}/38-01-PLAN.md`;
  writeFile(root, '.planning/architecture/ADR-014-test.md', '# ADR-014 test\nExplicit model and effort are required.\n');
  writeFile(root, plan, ['---', 'phase: 38', 'plan: 01', 'title: "Test role host"', '---', '', '## Context', '- Follows ADR-014.', '',
    '## Acceptance criteria', '- host authenticates each role result', '', '## Verification commands', '- node --test x', ''].join('\n'));
  writeFile(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
  writeFile(root, '.planning/graph/tickets.json', JSON.stringify({ tickets: { [ticket]: { title: 'Test role host', plan, phase: '38', repo: null, wave: 1,
    depends_on: [], cross_phase_deps: [], cross_repo_deps: [], files: ['src/role.txt'], risk: 'high', type: 'implementation',
    human_checkpoint: true, branch: ticketBranch, pr_base: epic, epic } } }));
  writeFile(root, '.planning/graph/delivery-state.json', JSON.stringify({ [ticket]: { status: 'merged', pr: 101, branch: ticketBranch, base: epic } }));
  writeFile(root, 'src/role.txt', 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'seed');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', base);
  git(root, 'checkout', '-q', '-b', epic);
  writeFile(root, 'src/role.txt', 'reviewed change\n');
  git(root, 'add', 'src/role.txt');
  git(root, 'commit', '-q', '-m', 'feat: change role source');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', ticketBranch, head);
  git(root, 'update-ref', `refs/remotes/origin/${ticketBranch}`, head);
  git(root, 'update-ref', `refs/remotes/origin/${epic}`, head);
  const pr = { number: 101, state: 'MERGED', isDraft: false, title: `feat(${ticket}): change role source`, body: `Implements ${ticket}.`,
    headRefName: ticketBranch, headRefOid: head, baseRefName: epic, baseRefOid: head, mergedAt: '2026-09-23T12:00:00Z',
    mergeCommit: { oid: head }, reviewDecision: null };
  return { root, phase, pr, ticketBranch };
}

for (const [label, dirName] of PATH_FORMS) {
  test(`integrator subject round-trips from the Claude role host through its consumers (${label} path)`, () => {
    const roleHost = require(SCRIPTS + 'claude-role-host.cjs');
    const records = require(SCRIPTS + 'dispatch-record.cjs');
    const { normalizeTicketIdentity } = require(SCRIPTS + 'run-contract.cjs');
    const f = integratorFixture(`integrator-${dirName}`);
    const prepared = roleHost.prepareIntegratorContext({
      storageRoot: scratch, refreshGit: false, defaultBranch: 'main',
      listPullRequests: ({ branch }) => (branch === f.ticketBranch ? [f.pr] : []), getPullRequest: () => f.pr },
    { schema: roleHost.REQUEST_SCHEMA, role: 'integrator', worktree: f.root, phase: f.phase });
    const parsed = target.parseSubject('integrator', prepared.ticket);
    assert.ok(parsed);
    assert.equal(parsed.repository, target.repositoryIdentity(f.root));
    assert.equal(normalizeTicketIdentity(prepared.ticket, { role: 'integrator', phase: 38 }).ticket, prepared.ticket);
    const graphDir = path.join(f.root, '.planning/graph');
    const input = { graphDir, worktree: f.root, dispatch_id: records.newDispatchId(), pid: process.pid, role: 'integrator', host: 'claude', ticket: prepared.ticket };
    records.recordInflight(input);
    const rows = Object.values(JSON.parse(fs.readFileSync(path.join(graphDir, 'dispatches.json'), 'utf8')).inflight || {});
    assert.ok(rows.some((row) => row.ticket === prepared.ticket));
    records.clearInflight(input);
  });
}

test('the Claude integrator producer refuses a semicolon path', () => {
  const roleHost = require(SCRIPTS + 'claude-role-host.cjs');
  const f = integratorFixture('integrator-semi;colon');
  assert.throws(() => roleHost.prepareIntegratorContext({
    storageRoot: scratch, refreshGit: false, defaultBranch: 'main',
    listPullRequests: ({ branch }) => (branch === f.ticketBranch ? [f.pr] : []), getPullRequest: () => f.pr },
  { schema: roleHost.REQUEST_SCHEMA, role: 'integrator', worktree: f.root, phase: f.phase }), { code: 'REPOSITORY_IDENTITY_INVALID' });
});

function architectureFixture(name) {
  const helpers = require('./helpers/codex-arch-review-fixtures.cjs');
  const f = helpers.fixture();
  const root = path.join(scratch, name);
  fs.renameSync(f.root, root);
  f.root = root;
  const graphDir = path.join(root, '.planning/graph');
  const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
  graph.tickets[helpers.TICKET].epic = 'epic/38-codex-arch-review';
  helpers.write(root, '.planning/graph/tickets.json', JSON.stringify(graph));
  helpers.write(root, '.planning/phases/38-codex-arch-review/38-01-SUMMARY.md', 'Original acceptance.');
  helpers.write(root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'develop' }, delivery_pipeline: { code_review: 'report' } }));
  helpers.git(root, ['branch', 'develop', f.base]);
  helpers.git(root, ['update-ref', 'refs/remotes/origin/develop', f.base]);
  helpers.git(root, ['switch', '-c', graph.tickets[helpers.TICKET].epic]);
  helpers.git(root, ['add', '.']);
  helpers.git(root, ['commit', '-m', 'phase evidence']);
  f.pr = { ...f.pr, number: 801, headRefName: graph.tickets[helpers.TICKET].epic, headRefOid: helpers.git(root, ['rev-parse', 'HEAD']), baseRefName: 'develop' };
  f.graph = graph;
  f.graphDir = graphDir;
  f.options = { cwd: root, graphDir, refreshGit: false, defaultBranch: 'develop', getPullRequest: () => f.pr };
  f.args = ['arch-review', '38-codex-arch-review', '--phase', '38', '--pr', '801'];
  return f;
}

async function claudeSubject(f, request) {
  const roleHost = require(SCRIPTS + 'claude-role-host.cjs');
  const original = target.phaseBinding;
  const seen = [];
  target.phaseBinding = (input) => {
    const binding = original(input);
    seen.push({ input, binding });
    throw Object.assign(new Error('subject captured'), { captured: true });
  };
  try {
    await roleHost.createClaudeRoleHost({ ...f.options, storageRoot: scratch }).run(request).then(() => assert.fail('host must stop at the capture'), (error) => {
      if (!error.captured) throw error;
    });
  } finally { target.phaseBinding = original; }
  return seen[0];
}

for (const [label, dirName] of PATH_FORMS) {
  test(`architecture-review subject agrees across deliver-dispatch, the Codex context and the Claude role host (${label} path)`, async () => {
    const { normalizeTicketIdentity } = require(SCRIPTS + 'run-contract.cjs');
    const builder = require(SCRIPTS + 'deliver-dispatch.cjs');
    const context = require(SCRIPTS + 'codex-arch-review-context.cjs');
    const roleArtifact = require(SCRIPTS + 'role-artifact.cjs');
    const f = architectureFixture(`arch-${dirName}`);
    try {
      const identity = target.repositoryIdentity(f.root);
      const codexRequest = builder.build([...f.args, '--runtime', 'codex'], f.options);
      const launched = codexRequest.scope.ticket;
      const claudeRequest = builder.build([...f.args, '--runtime', 'claude'], f.options);
      const captured = await claudeSubject(f, claudeRequest);
      assert.equal(captured.input.repository, identity);
      assert.equal(captured.binding.subject, launched);
      assert.equal(target.parseSubject('architecture-review', launched).repository, identity);
      assert.equal(normalizeTicketIdentity(launched, { role: 'arch-review', phase: 38 }).ticket, launched);
      const prepared = context.prepare(codexRequest.scope, { role: 'arch-review', signals: {}, context: codexRequest.context }, f.options);
      assert.equal(prepared.prepared.pr, 801);
    } finally { fs.rmSync(roleArtifact.archiveAuthorityDirectory(f.root), { recursive: true, force: true }); }
  });
}

test('every architecture-review producer refuses a semicolon path with REPOSITORY_IDENTITY_INVALID', async () => {
  const builder = require(SCRIPTS + 'deliver-dispatch.cjs');
  const context = require(SCRIPTS + 'codex-arch-review-context.cjs');
  const roleHost = require(SCRIPTS + 'claude-role-host.cjs');
  const f = architectureFixture('arch-semi;colon');
  for (const runtime of ['codex', 'claude']) {
    assert.throws(() => builder.build([...f.args, '--runtime', runtime], f.options), { code: 'REPOSITORY_IDENTITY_INVALID' }, runtime);
  }
  const scope = { run_id: 'deliver-arch-x', ticket: 'x', phase: 38, worktree: f.root, runtime: 'codex', provider: 'openai' };
  assert.throws(() => context.prepare(scope, { role: 'arch-review', signals: {}, context: {} }, f.options), { code: 'REPOSITORY_IDENTITY_INVALID' });
  await assert.rejects(roleHost.createClaudeRoleHost({ ...f.options, storageRoot: scratch }).run({
    schema: roleHost.REQUEST_SCHEMA, role: 'arch-review', worktree: f.root, phase: '38-codex-arch-review', pr: 801, repo: null }),
  { code: 'REPOSITORY_IDENTITY_INVALID' });
});

function codeReviewFixture(name) {
  const f = architectureFixture(name);
  const helpers = require('./helpers/codex-arch-review-fixtures.cjs');
  f.graph.epics = { 38: { branch: f.pr.headRefName, phaseDir: '38-codex-arch-review', repos: [null], jira: null } };
  writeFile(f.root, '.planning/graph/tickets.json', JSON.stringify(f.graph));
  writeFile(f.root, '.planning/config.json', JSON.stringify({ git: { base_branch: 'develop' },
    delivery_pipeline: { code_review: 'report' } }));
  helpers.git(f.root, ['add', '.']); helpers.git(f.root, ['commit', '-m', 'code review graph']);
  f.pr = { ...f.pr, headRefOid: helpers.git(f.root, ['rev-parse', 'HEAD']) };
  f.args[0] = 'code-review';
  return f;
}

for (const [label, dirName] of PATH_FORMS) {
  test(`code-review subject agrees across deliver-dispatch, the Codex context and the Claude role host (${label} path)`, async () => {
    const { normalizeTicketIdentity } = require(SCRIPTS + 'run-contract.cjs');
    const builder = require(SCRIPTS + 'deliver-dispatch.cjs');
    const context = require(SCRIPTS + 'codex-code-review-context.cjs');
    const f = codeReviewFixture(`code-${dirName}`);
    const identity = target.repositoryIdentity(f.root);
    const codexRequest = builder.build([...f.args, '--runtime', 'codex'], f.options);
    const claudeRequest = builder.build([...f.args, '--runtime', 'claude'], f.options);
    const captured = await claudeSubject(f, claudeRequest);
    assert.equal(captured.input.repository, identity);
    assert.equal(captured.binding.subject, codexRequest.scope.ticket);
    assert.equal(target.parseSubject('architecture-review', codexRequest.scope.ticket).repository, identity);
    assert.equal(normalizeTicketIdentity(codexRequest.scope.ticket, { role: 'code-review', phase: 38 }).ticket, codexRequest.scope.ticket);
    const prepared = context.prepare(codexRequest.scope, { role: 'code-review', signals: {}, context: codexRequest.context }, f.options);
    assert.equal(prepared.prepared.pr, 801);
  });
}

test('every code-review producer refuses a semicolon path with REPOSITORY_IDENTITY_INVALID', async () => {
  const builder = require(SCRIPTS + 'deliver-dispatch.cjs');
  const context = require(SCRIPTS + 'codex-code-review-context.cjs');
  const roleHost = require(SCRIPTS + 'claude-role-host.cjs');
  const flow = require(SCRIPTS + 'phase-code-review.cjs');
  const f = codeReviewFixture('code-semi;colon');
  for (const runtime of ['codex', 'claude'])
    assert.throws(() => builder.build([...f.args, '--runtime', runtime], f.options), { code: 'REPOSITORY_IDENTITY_INVALID' });
  const scope = { ticket: 'x', phase: 38, worktree: f.root };
  assert.throws(() => context.prepare(scope, { role: 'code-review', signals: {}, context: {} }, f.options),
    { code: 'REPOSITORY_IDENTITY_INVALID' });
  await assert.rejects(roleHost.createClaudeRoleHost({ ...f.options, storageRoot: scratch }).run({
    schema: roleHost.REQUEST_SCHEMA, role: 'code-review', worktree: f.root, phase: '38-codex-arch-review', pr: 801, repo: null }),
  { code: 'REPOSITORY_IDENTITY_INVALID' });
  assert.throws(() => flow.status({ phase: 38, pr: 801, worktree: f.root, graphDir: f.graphDir }, f.options),
    { code: 'REPOSITORY_IDENTITY_INVALID' });
});
