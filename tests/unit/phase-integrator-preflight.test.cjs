'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/phase-integrator-preflight.cjs');
const pre = require(SCRIPT);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
const ENV = { ...process.env, HOME: ROOT, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
process.env.HOME = ENV.HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = ENV.GIT_CONFIG_GLOBAL;
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) process.env[key] = ENV[key];

const EPIC = 'epic/41-x';
const PLAN_DIR = '.planning/phases/41-x';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let counter = 0;
function fixture(ids = ['T-41-01', 'T-41-02']) {
  counter += 1;
  const dir = path.join(ROOT, `f${counter}`);
  const origin = path.join(dir, 'origin.git');
  const wt = path.join(dir, 'wt');
  const graphDir = path.join(dir, 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  git(dir, 'init', '--quiet', '--bare', origin);
  git(dir, 'clone', '--quiet', origin, wt);
  git(wt, 'checkout', '--quiet', '-b', EPIC);
  fs.mkdirSync(path.join(wt, PLAN_DIR), { recursive: true });
  for (const id of ids) fs.writeFileSync(path.join(wt, PLAN_DIR, `41-${id.slice(-2)}-PLAN.md`), id);
  git(wt, 'add', '.');
  git(wt, 'commit', '--quiet', '-m', 'plans');
  const tickets = {};
  const merges = {};
  for (const id of ids) {
    const branch = `ticket/${id}-work`;
    tickets[id] = { phase: '41', plan: `${PLAN_DIR}/41-${id.slice(-2)}-PLAN.md`, branch, epic: EPIC, repo: null };
    git(wt, 'checkout', '--quiet', '-b', branch, EPIC);
    fs.writeFileSync(path.join(wt, `${id}.txt`), id);
    git(wt, 'add', '.');
    git(wt, 'commit', '--quiet', '-m', id);
    const head = git(wt, 'rev-parse', 'HEAD');
    git(wt, 'checkout', '--quiet', EPIC);
    git(wt, 'merge', '--quiet', '--no-ff', '-m', `merge ${id}`, branch);
    merges[id] = { head, merge: git(wt, 'rev-parse', 'HEAD') };
  }
  git(wt, 'push', '--quiet', 'origin', EPIC);
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets }));
  const prs = {};
  let n = 100;
  for (const id of ids) {
    n += 1;
    prs[id] = { number: n, state: 'MERGED', title: `${id}: work`, body: '', headRefName: tickets[id].branch,
      headRefOid: merges[id].head, baseRefName: EPIC, mergedAt: '2026-09-25T00:00:00Z', mergeCommit: { oid: merges[id].merge } };
  }
  return { dir, origin, wt, graphDir, tickets, prs, extra: [] };
}

function stubs(f) {
  return {
    listPullRequests: ({ branch }) => [...Object.values(f.prs), ...f.extra].filter((pr) => pr.headRefName === branch)
      .map(({ number, state, headRefName, baseRefName, mergedAt }) => ({ number, state, headRefName, baseRefName, mergedAt })),
    getPullRequest: ({ pr }) => [...Object.values(f.prs), ...f.extra].find((item) => item.number === pr),
  };
}

function run(f, opts) {
  return pre.preflight({ phase: '41', graphDir: f.graphDir, worktree: f.wt }, opts || stubs(f));
}

function refuses(f, pattern, opts) {
  assert.throws(() => run(f, opts), (error) => error.code === 'PREFLIGHT_REFUSED' && pattern.test(error.message));
}

suite('phase-integrator-preflight: complete proof');

test('complete set yields a bounded digest-bound proof for every graph ticket', () => {
  const f = fixture();
  const proof = run(f);
  assert.strictEqual(proof.schema, 'shipyard.phase-integrator-preflight.v1');
  assert.deepStrictEqual(proof.ticket_set.map((e) => e.id), ['T-41-01', 'T-41-02']);
  assert.deepStrictEqual(Object.keys(proof.ticket_set[0]), ['id', 'pr', 'head', 'base', 'branch']);
  assert.strictEqual(proof.ticket_set_digest, crypto.createHash('sha256').update(JSON.stringify(proof.ticket_set)).digest('hex'));
  assert.strictEqual(proof.epic.commit, git(f.wt, 'rev-parse', 'HEAD'));
  assert.strictEqual(proof.epic.tree, git(f.wt, 'rev-parse', 'HEAD^{tree}'));
  assert.strictEqual(proof.merges[1].merge_commit, f.prs['T-41-02'].mergeCommit.oid);
  assert.ok(proof.merges.every((m) => m.ancestor === true));
  assert.strictEqual(pre.proofDigest(proof), proof.proof_digest);
  assert.ok(!JSON.stringify(proof).includes('"title"'), 'live PR payloads are not stored');
});

suite('phase-integrator-preflight: refusals');

test('missing PR refuses', () => { const f = fixture(); delete f.prs['T-41-02']; refuses(f, /T-41-02 has no merged PR/); });
test('open PR refuses', () => {
  const f = fixture(); Object.assign(f.prs['T-41-02'], { state: 'OPEN', mergedAt: null });
  refuses(f, /T-41-02 has no merged PR \(PR still open\)/);
});
test('duplicate merged PRs refuse', () => {
  const f = fixture(); f.extra.push({ ...f.prs['T-41-01'], number: 999 }); refuses(f, /T-41-01 has 2 merged PRs/);
});
test('mismatched base refuses', () => { const f = fixture(); f.prs['T-41-01'].baseRefName = 'main'; refuses(f, /targets main/); });
test('mismatched head branch refuses', () => {
  const f = fixture(); const o = stubs(f); const get = o.getPullRequest;
  o.getPullRequest = (q) => ({ ...get(q), headRefName: 'ticket/other' }); refuses(f, /head branch does not match/, o);
});
test('mismatched repository PR number refuses', () => {
  const f = fixture(); const o = stubs(f); const get = o.getPullRequest;
  o.getPullRequest = (q) => ({ ...get(q), number: 5 }); refuses(f, /is not live-merged/, o);
});
test('absent merge SHA refuses', () => { const f = fixture(); f.prs['T-41-01'].mergeCommit = null; refuses(f, /no merge commit SHA/); });
test('non-ancestor merge refuses', () => {
  const f = fixture();
  git(f.wt, 'checkout', '--quiet', '-b', 'stray', f.prs['T-41-01'].headRefOid);
  fs.writeFileSync(path.join(f.wt, 'stray.txt'), 's'); git(f.wt, 'add', '.'); git(f.wt, 'commit', '--quiet', '-m', 's');
  const stray = git(f.wt, 'rev-parse', 'HEAD'); git(f.wt, 'checkout', '--quiet', EPIC);
  f.prs['T-41-01'].mergeCommit.oid = stray;
  refuses(f, /is not an ancestor of pinned/);
});
test('stale graph mapping refuses', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({ 'T-41-01': { branch: 'ticket/old' } }));
  refuses(f, /stale branch/);
});
test('moved head without marker mapping refuses', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'),
    JSON.stringify({ 'T-41-01': { branch: f.tickets['T-41-01'].branch, pr_branch: 'ticket/renamed', status: 'merged', pr: 101 } }));
  refuses(f, /no authenticated merged-PR branch mapping/);
});
test('changed graph (plan without ticket) refuses', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.wt, PLAN_DIR, '41-03-PLAN.md'), 'x');
  refuses(f, /does not match the phase plan set/);
});
test('worktree not at the pinned epic head refuses', () => {
  const f = fixture(); git(f.wt, 'checkout', '--quiet', 'HEAD~1'); refuses(f, /is not the pinned/);
});
test('epic moving during preflight refuses', () => {
  const f = fixture(); const o = stubs(f); let fetches = 0; const other = git(f.wt, 'rev-parse', 'HEAD~1');
  o.git = (cwd, args) => {
    if (args[0] === 'fetch') { fetches += 1; if (fetches === 2) git(f.wt, 'update-ref', `refs/remotes/origin/${EPIC}`, other); return ''; }
    return git(cwd, ...args);
  };
  refuses(f, /moved during preflight/, o);
});

suite('phase-integrator-preflight: CLI and verify');

function cli(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...ENV, ...env } });
}

function fakeGh(f) {
  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'prs.json'), JSON.stringify(Object.values(f.prs)));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const prs = require(${JSON.stringify(path.join(f.dir, 'prs.json'))});
const a = process.argv.slice(2);
if (a[1] === 'list') console.log(JSON.stringify(prs.filter((p) => p.headRefName === a[a.indexOf('--head') + 1])));
else console.log(JSON.stringify(prs.find((p) => p.number === Number(a[2]))));
`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

test('CLI writes proof and ticket-set file bound to one digest; verify accepts it', () => {
  const f = fixture(); const env = fakeGh(f);
  const proofFile = path.join(f.dir, 'proof.json'); const setFile = path.join(f.dir, 'set.json');
  const r = cli(['--phase', '41', '--graph-dir', f.graphDir, '--worktree', f.wt, '--proof-file', proofFile,
    '--ticket-set-file', setFile, '--json'], env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  assert.strictEqual(out.proof_digest, proof.proof_digest);
  assert.strictEqual(out.merges.length, 2);
  const v = cli(['--verify', '--worktree', f.wt, '--proof-file', proofFile, '--ticket-set-file', setFile,
    '--ticket-set-digest', proof.ticket_set_digest, '--json'], env);
  assert.strictEqual(v.status, 0, v.stdout + v.stderr);
});

test('CLI refusal leaves no proof', () => {
  const f = fixture(); delete f.prs['T-41-02']; const env = fakeGh(f);
  const proofFile = path.join(f.dir, 'proof.json'); fs.writeFileSync(proofFile, '{}');
  const r = cli(['--phase', '41', '--graph-dir', f.graphDir, '--worktree', f.wt, '--proof-file', proofFile, '--json'], env);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(JSON.parse(r.stdout).ok, false);
  assert.ok(!fs.existsSync(proofFile));
});

test('verify refuses a changed ticket set, a mismatched digest, a tampered proof and a moved epic', () => {
  const f = fixture(); const opts = stubs(f);
  const proof = run(f, opts);
  const proofFile = path.join(f.dir, 'p.json'); fs.writeFileSync(proofFile, JSON.stringify(proof));
  const setFile = path.join(f.dir, 's.json'); fs.writeFileSync(setFile, JSON.stringify(proof.ticket_set.slice(0, 1)));
  assert.throws(() => pre.verifyProof({ proofFile, ticketSetFile: setFile, worktree: f.wt }), /ticket-set file does not match/);
  assert.throws(() => pre.verifyProof({ proofFile, ticketSetDigest: 'x', worktree: f.wt }), /digest does not match the proof/);
  fs.writeFileSync(proofFile, JSON.stringify({ ...proof, merges: [] }));
  assert.throws(() => pre.verifyProof({ proofFile, worktree: f.wt }), /proof digest does not match/);
  fs.writeFileSync(proofFile, JSON.stringify(proof));
  fs.writeFileSync(path.join(f.wt, 'new.txt'), 'n'); git(f.wt, 'add', '.'); git(f.wt, 'commit', '--quiet', '-m', 'n');
  git(f.wt, 'push', '--quiet', 'origin', EPIC);
  assert.throws(() => pre.verifyProof({ proofFile, worktree: f.wt }), /not at the proof-pinned epic/);
  git(f.wt, 'reset', '--quiet', '--hard', 'HEAD~1');
  assert.throws(() => pre.verifyProof({ proofFile, worktree: f.wt }), /moved since the proof/);
});

done();
