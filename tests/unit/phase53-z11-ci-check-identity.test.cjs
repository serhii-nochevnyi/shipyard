'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const events = require(path.join(scripts, 'wait-events.cjs'));
const checks = require(path.join(scripts, 'check-state.cjs'));
const HEAD = 'a'.repeat(40);
const TICKET = 'T-53-11';
const PR = { number: 108, state: 'OPEN', isDraft: false, headRefName: `ticket/${TICKET}`,
  headRefOid: HEAD, baseRefName: 'epic/53', baseRefOid: 'b'.repeat(40), title: TICKET,
  reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', body: '', author: { login: 'author' } };
const run = (name = 'build', conclusion = 'success', extra = {}) => {
  const id = extra.id || 1;
  const html_url = extra.html_url ?? `https://github.com/acme/demo/actions/runs/${122 + id}/job/${id}`;
  const runId = Number(html_url.match(/\/runs\/(\d+)/)?.[1] || 123);
  return { id, name, status: 'completed', conclusion, head_sha: HEAD,
    started_at: '2026-10-01T00:00:00Z', app: { id: 15368, slug: 'github-actions' },
    check_suite: { id: 1000 + runId }, html_url, ...extra };
};

function fixture(t, data = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const graphDir = path.join(root, '.planning/graph');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, '.planning/config.json'), JSON.stringify({
    git: { base_branch: 'main' }, delivery_pipeline: { integration_mode: 'epic-stacked', gsd_sync: false },
  }));
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ epics: { '53': { branch: 'epic/53', repos: [null] } }, tickets: {
    [TICKET]: { phase: '53', epic: 'epic/53', branch: PR.headRefName, depends_on: [], human_checkpoint: true, checkpoint: 'merge' },
  } }));
  const input = path.join(root, 'input.json');
  const calls = path.join(root, 'calls.jsonl');
  const defaults = { checkPages: [{ total_count: 1, check_runs: [run()] }],
    statusPages: [{ sha: HEAD, total_count: 0, statuses: [] }], direct: [
      { name: 'build', state: 'SUCCESS', bucket: 'pass', link: run().html_url, startedAt: run().started_at, workflow: '' },
    ] };
  fs.writeFileSync(input, JSON.stringify({ ...defaults, ...data }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), d = JSON.parse(fs.readFileSync(process.env.CI_FIXTURE));
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify(a) + '\\n');
const emit = v => process.stdout.write(JSON.stringify(v));
if (a[0] === 'repo') emit({ owner: { login: 'acme' }, name: 'demo', nameWithOwner: 'acme/demo' });
else if (a[0] === 'pr' && a[1] === 'list') emit([${JSON.stringify(PR)}]);
else if (a[0] === 'pr' && a[1] === 'view') emit(${JSON.stringify(PR)});
else if (a[0] === 'pr' && a[1] === 'checks') { if (d.direct === null) process.exit(1); emit(d.direct); }
else if (a[0] === 'run' && a[1] === 'rerun') {
 if (d.afterRerun) fs.writeFileSync(process.env.CI_FIXTURE, JSON.stringify({ ...d, ...d.afterRerun }));
} else if (a[0] === 'api') {
 const e = a[1];
 if (e.endsWith('/branches')) process.stdout.write('main\\nepic/53\\nticket/${TICKET}\\n');
 else if (e.includes('/compare/')) process.stdout.write('0');
 else if (e.includes('/reviews')) emit([]);
 else if (/\\/pulls\\/108$/.test(e)) {
  const n = Number(fs.existsSync(process.env.CI_PULL_COUNT) ? fs.readFileSync(process.env.CI_PULL_COUNT) : 0) + 1;
  fs.writeFileSync(process.env.CI_PULL_COUNT, String(n));
  emit({ number: 108, state: 'open', head: { sha: d.move && n % 2 === 0 ? 'c'.repeat(40) : '${HEAD}' }, base: { repo: { full_name: 'acme/demo' } } });
 } else if (/\\/actions\\/runs\\/\\d+$/.test(e)) {
  const id = Number(e.split('/').pop());
  emit({ id, head_sha: '${HEAD}', name: 'CI', workflow_id: 50, event: 'pull_request',
    head_repository: { full_name: 'acme/demo' }, repository: { full_name: 'acme/demo' },
    check_suite_id: 1000 + id, run_number: id, run_attempt: d.attempt || 1, ...(d.runs || {})[id] });
 }
 else if (e.includes('/check-runs?')) { if (d.failChecks) process.exit(1); emit(d.checkPages); }
 else if (e.includes('/status?')) { if (d.failStatuses) process.exit(1); emit(d.statusPages); }
 else { process.stderr.write('unhandled endpoint ' + e); process.exit(2); }
} else process.exit(2);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    CI_FIXTURE: input, CI_CALLS: calls, CI_PULL_COUNT: path.join(root, 'pull-count') };
  for (const key of Object.keys(env)) if (/^(SHIPYARD_|GSD_|CLAUDE_|CODEX_|GH_|GITHUB_)/.test(key)) delete env[key];
  function invoke(script, args = [], extra = {}) {
    const r = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
      cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  }
  return { root, graphDir, input, invoke, calls: () => fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
  update: value => fs.writeFileSync(input, JSON.stringify({ ...defaults, ...value })) };
}

function publish(f, poll = 'fixture-poll') {
  f.invoke('state-sync.cjs', [], { SHIPYARD_CI_POLL_ID: poll });
  const p = events.readPublished({ graphDir: f.graphDir });
  assert.equal(p.ok, true, p.reason);
  return p;
}
function wait(f, args = []) {
  return JSON.parse(f.invoke('ci-wait.cjs', ['--graph', f.graphDir, '--json', '--timeout', '3', '--interval', '1', ...args]));
}
function ci(p) { return p.state[TICKET].ci_observation; }
function pendingBoard(f) {
  f.update({ checkPages: [{ total_count: 1, check_runs: [run('build', null, { status: 'in_progress' })] }],
    direct: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] });
  publish(f);
  f.update({});
}

// Tracer: an independent App's current failure must survive the ordinary path.
test('independent Apps with equal check names survive collection, publication and waiting', t => {
  const f = fixture(t);
  pendingBoard(f);
  const raw = [
    run('build', 'failure', { app: { id: 400, slug: 'external-a' }, html_url: '', id: 1 }),
    run('build', 'success', { app: { id: 401, slug: 'external-b' }, html_url: '', id: 2,
      started_at: '2026-10-02T00:00:00Z' }),
  ];
  f.update({ checkPages: [{ total_count: raw.length, check_runs: raw }] });
  const p = publish(f);
  const observation = ci(p);
  assert.equal(observation.complete, true);
  assert.equal(observation.rows.length, 2);
  assert.equal(checks.classify(observation.rows).failing, 1);
  assert.equal(checks.isGreen(checks.classify(observation.rows)), false);
  assert.equal(p.state[TICKET].checks.failing, 1);
  pendingBoard(f);
  f.update({ checkPages: [{ total_count: raw.length, check_runs: raw }] });
  const result = wait(f);
  assert.equal(result.watched[0].checks.failing, 1);
  assert.equal(result.watched[0].checks.rows.length, 2);
});

const later = (extra = {}) => run('build', 'success', { id: 2,
  started_at: '2026-10-02T00:00:00Z', ...extra });
const runResponse = (id, extra = {}) => ({ id, head_sha: HEAD, name: 'CI', workflow_id: 50,
  event: 'pull_request', head_repository: { full_name: 'acme/demo' },
  repository: { full_name: 'acme/demo' }, check_suite_id: 1000 + id,
  run_number: id, run_attempt: 1, ...extra });

// Substitute physical API responses only; exercise the public collector and
// classifier, including verification of provider, repository and suite evidence.
function collect(raw, { runs = {}, statuses = [], split = false, pull = {}, consumer = checks } = {}) {
  const calls = [];
  const observation = consumer.collectCiObservation({ pr: 108, repo: 'acme/demo', head: HEAD, pollId: 'identity' }, args => {
    calls.push(args);
    const endpoint = args[1];
    let value;
    if (endpoint.endsWith('/pulls/108')) value = { number: 108, state: 'open',
      head: { sha: HEAD, repo: { full_name: 'acme/demo' } }, base: { repo: { full_name: 'acme/demo' } }, ...pull };
    else if (endpoint.includes('/check-runs?')) value = split
      ? raw.map(row => ({ total_count: raw.length, check_runs: [row] }))
      : [{ total_count: raw.length, check_runs: raw }];
    else if (endpoint.includes('/status?')) value = [{ sha: HEAD, total_count: statuses.length, statuses }];
    else {
      const match = endpoint.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/);
      assert.ok(match, `unexpected physical endpoint ${endpoint}`);
      const key = match[1] + (match[2] ? `/attempts/${match[2]}` : '');
      value = runResponse(Number(match[1]), runs[key]);
    }
    return { status: 0, stdout: JSON.stringify(value) };
  });
  assert.equal(observation.complete, true, observation.note);
  assert.equal(consumer.compatibleCiObservation(observation, { pr: 108, repo: 'acme/demo', head: HEAD }), true);
  return { observation, calls, tally: consumer.classify(observation.rows) };
}

for (const provider of ['App', 'workflow']) {
  for (const conclusion of ['failure', null, 'cancelled']) {
    test(`independent ${provider} ${conclusion || 'pending'} survives publisher and ordinary waiter`, t => {
      const f = fixture(t);
      pendingBoard(f);
      const raw = [run('build', conclusion, { status: conclusion ? 'completed' : 'queued',
        ...(provider === 'App' ? { app: { id: 400, slug: 'external' }, html_url: '' } : {}) }), later()];
      const runs = provider === 'workflow' ? { 124: { workflow_id: 51 } } : {};
      const direct = collect(raw, { runs, split: true });
      assert.equal(direct.observation.rows.length, 2);
      assert.equal(direct.tally[conclusion === 'failure' ? 'failing' : 'pending'], 1);
      assert.equal(direct.tally.cancelled, conclusion === 'cancelled' ? 1 : 0);
      assert.equal(checks.isGreen(direct.tally), false);
      f.update({ checkPages: raw.map(row => ({ total_count: 2, check_runs: [row] })), runs });
      const published = publish(f);
      assert.equal(ci(published).rows.length, 2);
      pendingBoard(f);
      f.update({ checkPages: raw.map(row => ({ total_count: 2, check_runs: [row] })), runs });
      const before = f.calls().length;
      const result = wait(f).watched[0].checks;
      assert.equal(result[conclusion === 'failure' ? 'failing' : 'pending'], 1);
      assert.equal(result.cancelled, conclusion === 'cancelled' ? 1 : 0);
      assert.deepEqual(result.rows, ci(events.readPublished({ graphDir: f.graphDir })).rows);
      assert.equal(f.calls().slice(before).filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
    });
  }
}

test('distinct stable workflow IDs remain independent despite equal workflow names and events', () => {
  const { observation, tally } = collect([run('build', 'failure'), later()], { runs: { 124: { workflow_id: 51 } } });
  assert.deepEqual(observation.rows.map(row => [row.workflow, row.event, row.workflow_id]),
    [['CI', 'pull_request', 50], ['CI', 'pull_request', 51]]);
  assert.equal(tally.failing, 1);
});

for (const conclusion of ['failure', 'cancelled']) {
  test(`a verified later workflow run supersedes only its ${conclusion} predecessor`, () => {
    const independent = run('build', 'failure', { id: 3, app: { id: 401, slug: 'other' }, html_url: '' });
    const { observation, tally, calls } = collect([run('build', conclusion), later(), independent], { split: true });
    assert.equal(tally.failing, 1, 'independent failure survives the proven rerun');
    assert.equal(tally.cancelled, 0);
    assert.equal(tally.superseded, conclusion === 'cancelled' ? 1 : 0);
    assert.equal(observation.sources.check_runs.total_count, 3);
    assert.equal(observation.rows.length, conclusion === 'cancelled' ? 3 : 2);
    assert.ok(calls.find(args => args[1].includes('/check-runs?')).at(1).includes('filter=all'));
  });

  test(`different check IDs claiming one same-run job retain their ${conclusion} obligation`, () => {
    const { tally } = collect([run('build', conclusion), later({
      html_url: run().html_url, check_suite: { id: 1123 },
    })]);
    assert.equal(tally.failing, conclusion === 'failure' ? 1 : 0);
    assert.equal(tally.pending, conclusion === 'cancelled' ? 1 : 0);
    assert.equal(tally.superseded, 0);
    assert.equal(checks.isGreen(tally), false);
  });

  test(`verified ordered attempts supersede a same-run ${conclusion} with a new job ID`, () => {
    const raw = [run('build', conclusion, { html_url: 'https://github.com/acme/demo/actions/runs/123/attempts/1/job/1' }),
      later({ html_url: 'https://github.com/acme/demo/actions/runs/123/attempts/2/job/2', check_suite: { id: 1123 } })];
    const { tally, calls, observation } = collect(raw, { runs: {
      '123/attempts/1': { run_attempt: 1 }, '123/attempts/2': { run_attempt: 2 },
    } });
    assert.equal(tally.failing, 0);
    assert.equal(tally.pending, 0);
    assert.equal(checks.isGreen(tally), true);
    assert.ok(calls.some(args => args[1].endsWith('/attempts/1')));
    assert.ok(calls.some(args => args[1].endsWith('/attempts/2')));
    assert.equal(observation.rows.at(-1).run_attempt, 2);
  });
}

for (const [label, patch] of [
  ['missing App', { app: undefined }],
  ['untrusted App with Actions-shaped URL', { app: { id: 401, slug: 'github-actions' } }],
  ['wrong App slug', { app: { id: 15368, slug: 'external' } }],
  ['missing suite', { check_suite: undefined }],
  ['conflicting suite', { check_suite: { id: 999 } }],
  ['arbitrary URL host', { html_url: 'https://example.com/acme/demo/actions/runs/123/job/1' }],
  ['URL from another repository', { html_url: 'https://github.com/acme/other/actions/runs/123/job/1' }],
  ['URL without job association', { html_url: 'https://github.com/acme/demo/actions/runs/123' }],
]) test(`${label} cannot establish rerun authority`, () => {
  const { observation, tally } = collect([run('build', 'cancelled', patch), later()]);
  assert.equal(observation.rows.length, 2);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
  assert.equal(checks.isGreen(tally), false);
});

for (const [label, patch] of [
  ['missing workflow ID', { workflow_id: undefined }],
  ['conflicting run ID', { id: 999 }],
  ['foreign checked head', { head_sha: 'b'.repeat(40) }],
  ['foreign head repository', { head_repository: { full_name: 'acme/other' } }],
  ['foreign run repository', { repository: { full_name: 'acme/other' } }],
  ['missing event', { event: '' }],
  ['different event', { event: 'push' }],
  ['missing attempt', { run_attempt: undefined }],
  ['invalid attempt', { run_attempt: 0 }],
  ['missing run sequence', { run_number: undefined }],
  ['backwards run sequence', { run_number: 125 }],
  ['same run sequence on different runs', { run_number: 124 }],
]) test(`${label} does not hide an older cancellation`, () => {
  const { tally, observation } = collect([run('build', 'cancelled'), later()], { runs: { 123: patch } });
  assert.equal(observation.rows.length, 2);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.pending, 1);
  assert.equal(tally.superseded, 0);
});

test('equal App and names do not merge different jobs inside the same verified run', () => {
  const { tally, observation } = collect([run('build', 'failure'), later({
    html_url: 'https://github.com/acme/demo/actions/runs/123/job/2', check_suite: { id: 1123 },
  })]);
  assert.equal(tally.failing, 1);
  assert.equal(observation.rows.length, 2);
});

test('the classifier recognizes two verified snapshots of exactly the same run and job', () => {
  const old = collect([run('build', 'cancelled')]).observation.rows[0];
  const current = collect([run('build', 'success', { started_at: '2026-10-02T00:00:00Z' })]).observation.rows[0];
  const tally = checks.classify([old, current]);
  assert.equal(tally.cancelled, 0);
  assert.equal(tally.superseded, 1);
  assert.equal(checks.isGreen(tally), true);
});

test('a reused job ID across distinct workflow runs cannot manufacture logical identity', () => {
  const { tally } = collect([run('build', 'cancelled'), later({
    html_url: 'https://github.com/acme/demo/actions/runs/124/job/1',
  })]);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
});

test('duplicate job names within an attempt make cross-run identity ambiguous', () => {
  const raw = [run('build', 'cancelled'), later({
    html_url: 'https://github.com/acme/demo/actions/runs/123/job/2', check_suite: { id: 1123 },
  }), later({ id: 3 })];
  const { tally, observation } = collect(raw);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
  assert.equal(observation.rows.length, 3);
});

test('a later run cannot erase conflicting check IDs for a predecessor job', () => {
  const raw = [run('build', 'cancelled'), later({
    html_url: run().html_url, check_suite: { id: 1123 },
  }), later({ id: 3 })];
  const { tally, observation } = collect(raw);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
  assert.equal(observation.rows.length, 3);
});

test('latest-run metadata cannot manufacture a supersession between unknown job attempts', () => {
  const { tally } = collect([run('build', 'cancelled'), later({
    html_url: 'https://github.com/acme/demo/actions/runs/123/job/2', check_suite: { id: 1123 },
  })], { runs: { 123: { run_attempt: 2 } } });
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
});

test('a mismatched attempt response cannot bless an attempt-specific locator', () => {
  const raw = [run('build', 'cancelled', { html_url: 'https://github.com/acme/demo/actions/runs/123/attempts/1/job/1' }),
    later({ html_url: 'https://github.com/acme/demo/actions/runs/123/attempts/2/job/2', check_suite: { id: 1123 } })];
  const { tally } = collect(raw, { runs: { '123/attempts/1': { run_attempt: 2 }, '123/attempts/2': { run_attempt: 2 } } });
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
});

test('raw gh rows with only names, timestamps and workflow display names remain conservative', () => {
  const tally = checks.classify([
    { name: 'build', bucket: 'cancel', startedAt: run().started_at, workflow: 'CI', link: run().html_url },
    { name: 'build', bucket: 'pass', startedAt: later().started_at, workflow: 'CI', link: later().html_url },
  ]);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.pending, 1);
  assert.equal(tally.superseded, 0);
});

test('commit status contexts remain independent of check runs and retain their latest-status semantics', () => {
  const { observation, tally } = collect([run('build', 'cancelled'), later()], { statuses: [
    { id: 1, context: 'build', state: 'failure' },
    { id: 2, context: 'build', state: 'pending' },
    { id: 3, context: 'security', state: 'failure' },
  ] });
  assert.equal(tally.superseded, 1);
  assert.equal(tally.pending, 1);
  assert.equal(tally.failing, 1);
  assert.deepEqual(observation.rows.filter(row => row.source === 'commit-status').map(row => row.name), ['build', 'security']);
});

test('publication refreshes stable workflow identity on the same checked head before waiting', t => {
  const f = fixture(t);
  pendingBoard(f);
  const raw = [run('build', 'failure'), later()];
  f.update({ checkPages: [{ total_count: 2, check_runs: raw }] });
  const first = publish(f, 'proven-rerun');
  assert.equal(ci(first).rows.length, 1);
  pendingBoard(f);
  f.update({ checkPages: [{ total_count: 2, check_runs: raw }], runs: { 124: { workflow_id: 51 } } });
  const result = wait(f).watched[0].checks;
  const current = events.readPublished({ graphDir: f.graphDir });
  assert.equal(result.failing, 1);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows, ci(current).rows);
  assert.notEqual(ci(first).poll_id, ci(current).poll_id);
  assert.equal(checks.compatibleCiObservation(ci(first), { head: HEAD, pollId: ci(current).poll_id }), false);
});

test('unavailable refresh uses fresh direct rows and cannot inherit prior proven rerun authority', t => {
  const f = fixture(t);
  pendingBoard(f);
  f.update({ checkPages: [{ total_count: 2, check_runs: [run('build', 'cancelled'), later()] }] });
  assert.equal(checks.classify(ci(publish(f)).rows).cancelled, 0);
  pendingBoard(f);
  const direct = [
    { name: 'build', bucket: 'cancel', state: 'CANCELLED', link: '', workflow: 'CI', startedAt: run().started_at },
    { name: 'build', bucket: 'pass', state: 'SUCCESS', link: '', workflow: 'CI', startedAt: later().started_at },
  ];
  f.update({ failChecks: true, direct });
  const before = f.calls().length;
  const result = wait(f).watched[0].checks;
  assert.equal(result.cancelled, 1);
  assert.equal(result.pending, 1);
  assert.deepEqual(result.rows, direct);
  assert.ok(f.calls().slice(before).some(args => args[0] === 'pr' && args[1] === 'checks'));
  assert.equal(events.readPublished({ graphDir: f.graphDir }).ci_observations[TICKET], undefined);
});

test('a previously collapsed observation schema cannot be reused as current evidence', () => {
  const { observation } = collect([run()]);
  assert.equal(checks.compatibleCiObservation({ ...observation, schema_version: 1 }), false);
});

test('a newer timestamp cannot reverse verified attempt ordering', () => {
  const raw = [run('build', 'cancelled', { html_url: 'https://github.com/acme/demo/actions/runs/123/attempts/2/job/1' }),
    later({ html_url: 'https://github.com/acme/demo/actions/runs/123/attempts/1/job/2', check_suite: { id: 1123 } })];
  const { tally } = collect(raw, { runs: {
    '123/attempts/2': { run_attempt: 2 }, '123/attempts/1': { run_attempt: 1 },
  } });
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
});

test('missing timestamps cannot replace verified ordering with check IDs', () => {
  const { tally } = collect([run('build', 'cancelled', { started_at: null }), later()]);
  assert.equal(tally.cancelled, 1);
  assert.equal(tally.superseded, 0);
});

test('the real builder reproduces package bytes, modes, manifests and a cold identity consumer', t => {
  const root = path.resolve(__dirname, '../..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-identity-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const shipped = path.join(root, 'plugins/shipyard');
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  function inventory(directory, prefix = '') {
    return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const relative = prefix + entry.name;
        const filename = path.join(directory, relative);
        const stat = fs.lstatSync(filename);
        assert.equal(stat.isSymbolicLink(), false, relative);
        const row = { path: relative, mode: stat.mode & 0o777, directory: entry.isDirectory() };
        return entry.isDirectory() ? [row, ...inventory(directory, relative + '/')]
          : [{ ...row, digest: digest(fs.readFileSync(filename)) }];
      });
  }
  const before = inventory(shipped);
  const built = require('../../scripts/package-shipyard-codex.cjs').build(path.join(temporary, 'package'));
  assert.deepEqual(inventory(shipped), before, 'isolated construction cannot mutate shipped outputs');
  const generated = inventory(built);
  const owned = new Set(['host/plugins/delivery-pipeline/scripts/check-state.cjs', '.codex-plugin/plugin.json', 'package-build.json']);
  assert.deepEqual(generated.filter(row => !owned.has(row.path)), before.filter(row => !owned.has(row.path)),
    'no generated output outside the exact three declared paths may differ');
  assert.deepEqual(generated, before, 'the complete current package must be genuine builder output');
  const canonical = path.join(scripts, 'check-state.cjs');
  const mirror = path.join(built, 'host/plugins/delivery-pipeline/scripts/check-state.cjs');
  assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonical));
  assert.equal(fs.statSync(mirror).mode & 0o777, fs.statSync(canonical).mode & 0o777);
  for (const file of owned) {
    assert.deepEqual(fs.readFileSync(path.join(built, file)), fs.readFileSync(path.join(shipped, file)));
    assert.equal(fs.statSync(path.join(built, file)).mode & 0o777, fs.statSync(path.join(shipped, file)).mode & 0o777);
  }
  const manifestBytes = fs.readFileSync(path.join(built, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const identity = JSON.parse(fs.readFileSync(path.join(built, 'package-build.json')));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json')));
  const hash = crypto.createHash('sha256');
  for (const row of generated.filter(row => !row.directory && !['.codex-plugin/plugin.json', 'package-build.json'].includes(row.path))) {
    hash.update(row.path + '\0');
    hash.update(fs.readFileSync(path.join(built, row.path)));
  }
  const sourceDigest = hash.digest('hex');
  assert.equal(manifest.version, `${source.version}+codex.${sourceDigest.slice(0, 16)}`);
  assert.equal(identity.version, manifest.version);
  assert.equal(identity.digest, crypto.createHash('sha256').update(sourceDigest).update('\0').update(manifestBytes).digest('hex'));
  assert.equal(require.cache[mirror], undefined, 'the staged consumer must be loaded independently');
  const staged = require(mirror);
  const raw = [run('build', 'cancelled', { app: { id: 401, slug: 'external' }, html_url: '' }), later()];
  assert.equal(collect(raw, { consumer: staged }).tally.cancelled, 1);
  assert.equal(collect([run('build', 'cancelled'), later()], { consumer: staged }).tally.superseded, 1);
});
