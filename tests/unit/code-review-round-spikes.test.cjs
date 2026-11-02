'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-spikes-')));
const homedir = os.homedir;
os.homedir = () => path.join(work, 'parent-home');
process.on('exit', () => { os.homedir = homedir; fs.rmSync(work, { recursive: true, force: true }); });
const repository = path.resolve(__dirname, '../..');

const SITES = {
  normalize: ['scripts/code-review-core.cjs', 'round > ROUND_CAP ||', 'round > 5 ||'],
  seal: ['scripts/role-artifact.cjs', 'result.review_round > core.ROUND_CAP', 'result.review_round > 5'],
  replay: ['scripts/role-artifact.cjs', "lineage.active.size >= require('./code-review-core.cjs').ROUND_CAP",
    'lineage.active.size >= 5'],
};
const TRACE = ['scripts/role-artifact.cjs', "lineage.active.size >= require('./code-review-core.cjs').ROUND_CAP",
  '((globalThis.guardSizes ??= []).push(lineage.active.size), lineage.active.size >= 5)'];
const VARIANTS = { A: [], B: [SITES.normalize, SITES.seal], C: [SITES.normalize, SITES.seal, SITES.replay],
  T: [SITES.normalize, SITES.seal, TRACE] };

const PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scripts = path.join(__dirname, 'plugins/delivery-pipeline/scripts');
const art = require(path.join(scripts, 'role-artifact.cjs'));
const core = require(path.join(scripts, 'code-review-core.cjs'));
const target = require(path.join(scripts, 'architecture-target.cjs'));
const fixtures = require('./tests/fixtures/code-review/artifact-fixture.cjs');
const [mode, runtime, argument] = process.argv.slice(2);
const emit = row => process.stdout.write(JSON.stringify(row) + '\\n');
const failure = (stage, error) => ({ stage, code: error.code || null, message: String(error.message).split('\\n')[0] });
const sizes = () => { const taken = globalThis.guardSizes || []; globalThis.guardSizes = []; return taken; };
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const read = (root, phase) => {
  try {
    const rows = art.priorCodeReviewVerdicts({ worktreePath: root, repository: target.repositoryIdentity(root), phaseDir: phase });
    return { rows };
  } catch (error) { return { error: failure('history', error) }; }
};
const summary = rows => rows.map(row => ({ round: row.review_round, auth: row.answer_authenticated }));

if (mode === 'read') {
  const info = JSON.parse(argument);
  if (runtime === 'codex') process.env.CODEX_HOME = path.join(info.root, '.planning/codex-fixture');
  const { rows, error } = read(info.root, info.phase);
  const row = { history: rows ? summary(rows) : null, error: error || null, next: null };
  if (rows) row.next = core.nextRound({ priorVerdicts: rows, head: git(info.root, ['rev-parse', 'HEAD']),
    isAncestor: (a, b) => { try { git(info.root, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } } });
  row.current = null;
  try {
    const current = art.currentCodeReviewVerdict({ worktreePath: info.root, pr: 52, head: info.head, baseName: 'main',
      baseCommit: info.base, graphDir: info.graphDir, headBranch: info.branch });
    row.current = current ? { round: current.round, verdict: current.verdict } : null;
  } catch (error) { row.current = failure('current', error); }
  emit(row);
} else {
  const f = fixtures.fixture('spike');
  f.graph.epics = { '052': { branch: f.branch, phaseDir: f.phase, repos: [null] } };
  Object.assign(f.graph.tickets['T-52-01'], { epic: f.branch, branch: 'feat/review-ticket', repo: null, phaseDir: f.phase });
  fs.writeFileSync(path.join(f.root, '.planning/config.json'),
    JSON.stringify({ git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'hold' } }));
  f.writeGraph();
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests/fixtures/code-review/review.json'), 'utf8'));
  const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
  const options = { runtime };
  for (let round = 1; round <= Number(argument); round++) {
    const row = { round };
    let stage = 'advance';
    try {
      const binding = f.advance(round);
      let input;
      if (round === 1) {
        stage = 'retain';
        input = fixtures.retainPlanningInput(f, f.input(binding, 1, null, { ...raw, findings: [raw.findings[0]] }), f.root, null, options);
      } else {
        stage = 'carry';
        const prior = read(f.root, f.phase).rows.at(-1);
        const priorFindings = core.carryPriorFindings({ priorFindings: prior,
          deltaDiff: f.git(['diff', '--unified=50', prior.head, 'HEAD']), readSource });
        const blank = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [],
          dispositions: priorFindings.map(finding => ({ ref: finding.ref, disposition: 'unresolved', justification: 'still fails' })) };
        stage = 'normalize';
        const result = core.normalizeResult(blank, { round, scope: 'delta', priorFindings, readSource });
        input = f.input(binding, round, prior.head, { ...blank, dispositions: [] });
        input.result = { ...input.result, ...result };
        fixtures.setOriginalReview(input, blank, priorFindings);
        stage = 'retain';
        fixtures.retainPlanningInput(f, input, f.root, null, options);
      }
      stage = 'seal';
      sizes();
      art.sealJudgment(input);
      row.sealed = true;
    } catch (error) { row.sealed = false; row.error = failure(stage, error); }
    row.guard_seal = sizes();
    const { rows, error } = read(f.root, f.phase);
    row.history = rows ? summary(rows) : null;
    row.history_error = error || null;
    row.guard_history = sizes();
    let current = null;
    try { current = f.lookup(); } catch {}
    row.current = current ? { round: current.round, verdict: current.verdict } : null;
    emit(row);
    if (!row.sealed) break;
  }
  emit({ end: true, root: f.root, phase: f.phase, branch: f.branch, base: f.base, graphDir: f.graphDir, head: f.git(['rev-parse', 'HEAD']) });
  if (mode !== 'keep') f.cleanup();
}
`;

const copies = new Map();
function replaceOnce(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, 'expected exactly one occurrence of: ' + from);
  return parts.join(to);
}
function copyOf(name) {
  if (copies.has(name)) return copies.get(name);
  const dir = path.join(work, 'copies', name);
  for (const source of ['plugins/delivery-pipeline', 'tests/fixtures/code-review'])
    fs.cpSync(path.join(repository, source), path.join(dir, source), { recursive: true });
  fs.writeFileSync(path.join(dir, 'probe.cjs'), PROBE);
  for (const [file, from, to] of VARIANTS[name]) {
    const target = path.join(dir, 'plugins/delivery-pipeline', file);
    fs.writeFileSync(target, replaceOnce(fs.readFileSync(target, 'utf8'), from, to));
  }
  copies.set(name, dir);
  return dir;
}

function environment(name) {
  const dir = path.join(work, 'env', name);
  for (const part of ['home', 'tmp', 'codex', 'config', 'cache', 'state', 'data', 'runtime', 'claude'])
    fs.mkdirSync(path.join(dir, part), { recursive: true });
  fs.chmodSync(path.join(dir, 'runtime'), 0o700);
  fs.writeFileSync(path.join(dir, 'gitconfig'),
    '[user]\n\tname = Spike\n\temail = spike@example.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const at = part => path.join(dir, part);
  return { PATH: process.env.PATH, HOME: at('home'), CODEX_HOME: at('codex'), CLAUDE_CONFIG_DIR: at('claude'),
    TMPDIR: at('tmp'), TMP: at('tmp'), TEMP: at('tmp'), XDG_CONFIG_HOME: at('config'), XDG_CACHE_HOME: at('cache'),
    XDG_STATE_HOME: at('state'), XDG_DATA_HOME: at('data'), XDG_RUNTIME_DIR: at('runtime'),
    GIT_CONFIG_GLOBAL: at('gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
}

function probe(variant, env, args) {
  const copy = copyOf(variant);
  const result = spawnSync(process.execPath, [path.join(copy, 'probe.cjs'), ...args], {
    cwd: copy, encoding: 'utf8', env, timeout: 540000 });
  assert.equal(result.status, 0, result.stderr);
  if (args[0] !== 'read')
    assert.ok(fs.readdirSync(path.join(env.HOME, '.local/state/shipyard/role-artifact-authority')).length > 0);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

const table = rows => rows.filter(row => !row.end).map(row => [row.round, row.sealed ? 'sealed' : (row.error.stage + ' ' + row.error.code
  + ' ' + row.error.message), 'history=' + JSON.stringify(row.history), 'current=' + JSON.stringify(row.current),
  'guard_seal=' + JSON.stringify(row.guard_seal), 'guard_history=' + JSON.stringify(row.guard_history)].join(' | ')).join('\n');

function expectLineage(rows, sealed, refusal) {
  const rounds = rows.filter(row => !row.end);
  assert.deepEqual(rounds.filter(row => row.sealed).map(row => row.round), sealed);
  for (const row of rounds.filter(entry => entry.sealed)) {
    assert.deepEqual(row.history, Array.from({ length: row.round }, (_, index) => ({ round: index + 1, auth: true })));
    assert.deepEqual(row.current, { round: row.round, verdict: 'needs-fix' });
  }
  if (!refusal) return assert.equal(rounds.length, sealed.length);
  const refused = rounds.at(-1);
  assert.equal(refused.sealed, false);
  assert.equal(refused.round, sealed.length + 1);
  assert.equal(refused.error.code, refusal.code);
  assert.match(refused.error.message, refusal.message);
  assert.equal(refused.current, null);
}

const EXPECTED = {
  A: [[1, 2, 3], { code: 'INVALID_RESULT', message: /invalid review round or scope/ }],
  B: [[1, 2, 3, 4], { code: 'REVIEW_NATIVE_INVALID', message: /lack authenticated sealed source lineage/ }],
  C: [[1, 2, 3, 4, 5], { code: 'INVALID_RESULT', message: /invalid review round or scope/ }],
};
const LAST = { A: 4, B: 5, C: 6 };

for (const runtime of ['claude', 'codex']) {
  test('S1 ' + runtime + ': a carried needs-fix lineage under the three ceiling variants', t => {
    for (const variant of ['A', 'B', 'C']) {
      const rows = probe(variant, environment(`s1-${runtime}-${variant}`), ['seal', runtime, String(LAST[variant])]);
      t.diagnostic(`variant ${variant} ${runtime}\n${table(rows)}`);
      expectLineage(rows, ...EXPECTED[variant]);
    }
  });

  test('S1 ' + runtime + ': guard depth observed at the replay bound with the ceiling at all three sites', t => {
    const rows = probe('T', environment('trace-' + runtime), ['seal', runtime, '5']);
    t.diagnostic(`variant T ${runtime}\n${table(rows)}`);
    expectLineage(rows, [1, 2, 3, 4, 5]);
  });

  test('S4 ' + runtime + ': code of the current release reads a sealed round-4 verdict', t => {
    const name = 's4-' + runtime, env = environment(name);
    const sealed = probe('C', env, ['keep', runtime, '4']);
    const info = sealed.at(-1);
    assert.deepEqual(sealed.filter(row => !row.end).map(row => row.sealed), [true, true, true, true]);
    const patched = probe('C', env, ['read', runtime, JSON.stringify(info)])[0];
    t.diagnostic(`patched reader ${runtime}: ${JSON.stringify(patched)}`);
    assert.deepEqual(patched.history, [1, 2, 3, 4].map(round => ({ round, auth: true })));
    assert.deepEqual(patched.next, { round: null, state: 'limit', rounds_used: 4 });
    assert.deepEqual(patched.current, { round: 4, verdict: 'needs-fix' });
    const older = probe('A', env, ['read', runtime, JSON.stringify(info)])[0];
    t.diagnostic(`unpatched reader ${runtime}: ${JSON.stringify(older)}`);
    assert.equal(older.history, null);
    assert.equal(older.error.code, 'INVALID_RESULT');
    assert.equal(older.error.message, 'invalid code-review round, scope or prior_head');
    assert.equal(older.current, null);

    const bin = path.join(work, 'bin-' + name);
    fs.mkdirSync(bin, { recursive: true });
    const live = { number: 52, state: 'OPEN', headRefName: info.branch, headRefOid: info.head, baseRefName: 'main', baseRefOid: info.base };
    fs.writeFileSync(path.join(bin, 'pr.json'), JSON.stringify(live));
    fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(' + JSON.stringify(path.join(bin, 'pr.json')) + '));\n', { mode: 0o755 });
    const cli = spawnSync(process.execPath, [path.join(copyOf('A'), 'plugins/delivery-pipeline/scripts/phase-code-review.cjs'), 'status',
      info.phase, '--phase', '52', '--pr', '52', '--worktree', info.root, '--graph', info.graphDir], {
      cwd: bin, encoding: 'utf8', env: { ...env, PATH: bin + path.delimiter + env.PATH } });
    t.diagnostic(`unpatched status CLI ${runtime}: exit=${cli.status} stdout=${JSON.stringify(cli.stdout)} stderr=${JSON.stringify(cli.stderr)}`);
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /^INVALID_RESULT: invalid code-review round, scope or prior_head\nhint\[INVALID_RESULT\]: The dispatch result does not match the shape the boundary requires\. [^\n]*Fix the result fields to match the documented schema and re-run\.\n$/);
  });
}

test('every patch asserts exactly one occurrence', () => {
  assert.throws(() => replaceOnce('one one', 'one', 'two'), /exactly one occurrence/);
  assert.throws(() => replaceOnce('zzz', 'one', 'two'), /exactly one occurrence/);
});
