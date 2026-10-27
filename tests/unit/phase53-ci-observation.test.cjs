'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const events = require(path.join(scripts, 'wait-events.cjs'));
const checks = require(path.join(scripts, 'check-state.cjs'));
const HEAD = 'a'.repeat(40);
const TICKET = 'T-53-08';
const PR = { number: 108, state: 'OPEN', isDraft: false, headRefName: `ticket/${TICKET}`,
  headRefOid: HEAD, baseRefName: 'epic/53', baseRefOid: 'b'.repeat(40), title: TICKET,
  reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', body: '', author: { login: 'author' } };
const run = (name = 'build', conclusion = 'success', extra = {}) => ({ id: 1, name,
  status: 'completed', conclusion, head_sha: HEAD, started_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/acme/demo/actions/runs/123/job/1', ...extra });

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
 } else if (/\\/actions\\/runs\\/\\d+$/.test(e)) emit({ id: Number(e.split('/').pop()), head_sha: '${HEAD}', name: 'CI', run_attempt: d.attempt || 1 });
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

test('real publisher binds named rows and real waiter omits compatible recollection', t => {
  const f = fixture(t);
  pendingBoard(f);
  const before = f.calls().length;
  const result = wait(f);
  assert.equal(result.settled, TICKET, JSON.stringify(result));
  assert.equal(result.watched[0].checks.total, 1);
  const calls = f.calls().slice(before);
  assert.equal(calls.filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
  assert.equal(calls.filter(a => a[0] === 'api' && a[1].includes('/check-runs?')).length, 1);
  const p = events.readPublished({ graphDir: f.graphDir });
  assert.equal(ci(p).checked_head, HEAD);
  assert.equal(ci(p).rows[0].name, 'build');
  assert.equal(ci(p).rows[0].run_id, '123');
  assert.deepEqual(result.watched[0].checks.rows, ci(p).rows);
});

test('same-summary changed names, run IDs and cancellation remain distinct', t => {
  const f = fixture(t);
  const a = publish(f);
  f.update({ checkPages: [{ total_count: 1, check_runs: [run('lint', 'success', { html_url: 'https://github.com/acme/demo/actions/runs/456/job/2' })] }] });
  const b = publish(f);
  assert.notEqual(a.metadata.binding.observation_digest, b.metadata.binding.observation_digest);
  assert.equal(ci(b).rows[0].run_id, '456');
  assert.equal(checks.classify(ci(b).rows).passing, 1);
});

test('same generation forged projection cannot substitute for the bound rows', t => {
  const f = fixture(t);
  const p = publish(f);
  const file = path.join(f.graphDir, 'delivery-state-meta.json');
  p.metadata.observation_projection.tickets[TICKET].ci_observation = { ...ci(p), rows: [] };
  p.metadata.binding.observation_digest = events.digest(p.metadata.observation_projection);
  fs.writeFileSync(file, JSON.stringify(p.metadata));
  assert.equal(events.readPublished({ graphDir: f.graphDir }).ok, false);
});

function comparable(result) {
  return { total: result.total, pending: result.pending, failing: result.failing,
    cancelled: result.cancelled, cancelled_runs: result.cancelled_runs,
    rows: result.rows.map(r => ({ name: r.name, state: r.state, bucket: r.bucket, link: r.link,
      startedAt: r.startedAt, workflow: r.workflow, run_id: checks.runIdOf(r) })).sort((a, b) => a.name.localeCompare(b.name)) };
}

for (const [label, conclusion, bucket] of [
  ['named failure', 'failure', 'fail'], ['pending', null, 'pending'],
  ['skipped', 'skipped', 'skipping'], ['unknown state', 'future_result', 'pending'],
]) {
  test(`direct and publication waiter paths agree on ${label}`, t => {
    const f = fixture(t);
    pendingBoard(f);
    const raw = run('named-job', conclusion, { status: conclusion ? 'completed' : 'queued' });
    const direct = [{ name: raw.name, state: conclusion ? conclusion.toUpperCase() : 'QUEUED', bucket,
      link: raw.html_url, startedAt: raw.started_at, workflow: 'CI' }];
    f.update({ checkPages: [{ total_count: 1, check_runs: [raw] }], direct });
    const published = wait(f).watched[0].checks;
    fs.rmSync(path.join(f.graphDir, 'delivery-state-meta.json'));
    const front = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-front.json')));
    front.actionable = {}; front.actionable_count = 0; front.waiting.ci = [TICKET];
    fs.writeFileSync(path.join(f.graphDir, 'delivery-front.json'), JSON.stringify(front));
    const fresh = wait(f).watched[0].checks;
    assert.deepEqual(comparable(published), comparable(fresh));
  });
}

test('complete check/status pages preserve status contexts and latest duplicate selection', t => {
  const f = fixture(t, { checkPages: [
    { total_count: 2, check_runs: [run('old-job')] },
    { total_count: 2, check_runs: [run('new-job', 'skipped', { id: 2 })] },
  ], statusPages: [
    { sha: HEAD, total_count: 3, statuses: [{ id: 4, context: 'external', state: 'failure' }] },
    { sha: HEAD, total_count: 3, statuses: [{ id: 5, context: 'external', state: 'success' },
      { id: 6, context: 'security', state: 'pending' }] },
  ] });
  const p = publish(f);
  assert.equal(ci(p).complete, true);
  assert.equal(ci(p).sources.check_runs.pages, 2);
  assert.equal(ci(p).sources.statuses.pages, 2);
  const c = checks.classify(ci(p).rows);
  assert.equal(c.total, 4);
  assert.equal(c.failing, 0);
  assert.equal(c.pending, 1);
  assert.equal(c.skipped, 1);
});

for (const [label, patch] of [
  ['missing check page', { checkPages: [{ total_count: 2, check_runs: [run()] }] }],
  ['missing status page', { statusPages: [{ sha: HEAD, total_count: 1, statuses: [] }] }],
  ['check head mismatch', { checkPages: [{ total_count: 1, check_runs: [run('build', 'success', { head_sha: 'b'.repeat(40) })] }] }],
  ['status head mismatch', { statusPages: [{ sha: 'b'.repeat(40), total_count: 0, statuses: [] }] }],
  ['check transport outage', { failChecks: true }],
  ['status transport outage', { failStatuses: true }],
  ['head moves during collection', { move: true }],
]) {
  test(`${label} is not reusable and the real waiter uses fresh direct fallback`, t => {
    const f = fixture(t);
    pendingBoard(f);
    f.update(patch);
    const p = publish(f);
    assert.equal(ci(p).complete, false);
    assert.equal(ci(p).checked_head, null);
    assert.equal(ci(p).rows, null);
    assert.equal(p.state[TICKET].checks.unavailable, !(patch.failChecks || patch.failStatuses));
    assert.equal(p.state[TICKET].checks.none_reported, false);
    if (patch.failChecks || patch.failStatuses) {
      pendingBoard(f);
      f.update(patch);
    }
    const n = f.calls().length;
    const output = wait(f);
    assert.equal(output.watched[0].checks.rows[0].name, 'build');
    assert.equal(f.calls().slice(n).filter(a => a[0] === 'pr' && a[1] === 'checks').length,
      patch.failChecks || patch.failStatuses ? 2 : 1);
  });
}

for (const [label, direct, expected] of [
  ['failure', [{ name: 'build', state: 'FAILURE', bucket: 'fail' }], { failing: 1, pending: 0, unavailable: false }],
  ['unknown bucket', [{ name: 'build', state: 'FUTURE', bucket: 'future' }], { failing: 0, pending: 1, unavailable: false }],
  ['unreadable', null, { failing: 0, pending: 0, unavailable: true }],
]) test(`transport fallback preserves fresh canonical ${label} without publishing reusable rows`, t => {
  const f = fixture(t, { failChecks: true, direct });
  const p = publish(f);
  assert.equal(ci(p).complete, false);
  assert.equal(ci(p).rows, null);
  assert.equal(p.ci_observations[TICKET], undefined);
  for (const [key, value] of Object.entries(expected)) assert.equal(p.state[TICKET].checks[key], value);
  assert.equal(f.calls().filter(a => a[0] === 'pr' && a[1] === 'checks').length, 1);
});

test('observed empty is complete and different from an outage', t => {
  const f = fixture(t, { checkPages: [{ total_count: 0, check_runs: [] }] });
  const p = publish(f);
  assert.equal(ci(p).complete, true);
  assert.equal(p.state[TICKET].checks.none_reported, true);
  assert.equal(p.state[TICKET].checks.unavailable, false);
});

test('new same-head polls refresh transport without inventing semantic transitions', t => {
  const f = fixture(t);
  const raw = run('build', null, { status: 'in_progress' });
  f.update({ checkPages: [{ total_count: 1, check_runs: [raw] }] });
  const a = publish(f, 'poll-one');
  const b = publish(f, 'poll-two');
  assert.notEqual(ci(a).poll_id, ci(b).poll_id);
  assert.equal(checks.compatibleCiObservation(ci(a), { head: HEAD, pollId: 'poll-two' }), false);
  const ctx = { graphDir: f.graphDir, ticket: TICKET, pr: 108, head: HEAD, run_id: 'same-head' };
  events.observe({ ...ctx, observation: a.observation.tickets[TICKET] });
  const result = events.observe({ ...ctx, observation: b.observation.tickets[TICKET] });
  assert.equal(result.changed, false, 'a fresh poll nonce is freshness, not new model work');
});

test('same-name check reruns select latest non-cancelled result and retain superseded cancel semantics', t => {
  const f = fixture(t, { checkPages: [{ total_count: 3, check_runs: [
    run('build', 'failure', { id: 1 }),
    run('build', 'cancelled', { id: 2, started_at: '2026-10-02T00:00:00Z' }),
    run('build', 'success', { id: 3, started_at: '2026-10-03T00:00:00Z' }),
  ] }] });
  const p = publish(f);
  const c = checks.classify(ci(p).rows);
  assert.equal(c.failing, 0);
  assert.equal(c.pending, 0);
  assert.equal(c.superseded, 1);
});

for (const superseded of [false, true]) {
  test(`${superseded ? 'superseded' : 'latest'} cancellation keeps exact run IDs through the real waiter`, t => {
    const f = fixture(t);
    pendingBoard(f);
    const cancelled = run('build', 'cancelled');
    const rows = [cancelled, ...(superseded ? [run('build', 'success', { id: 2, started_at: '2026-10-02T00:00:00Z' })] : [])];
    const direct = rows.map(r => ({ name: r.name, state: r.conclusion.toUpperCase(),
      bucket: r.conclusion === 'cancelled' ? 'cancel' : 'pass',
      startedAt: r.started_at, link: r.html_url, workflow: 'CI' }));
    f.update({ direct, checkPages: [{ total_count: rows.length, check_runs: rows }] });
    const n = f.calls().length;
    const output = wait(f);
    const c = output.watched[0].checks;
    assert.equal(c.cancelled, superseded ? 0 : 1);
    assert.equal(c.pending, superseded ? 0 : 1);
    const reruns = f.calls().slice(n).filter(a => a[0] === 'run' && a[1] === 'rerun');
    assert.equal(reruns.length, superseded ? 0 : 1);
    if (!superseded) {
      assert.equal(c.cancelled_runs[0].run_id, '123');
      assert.equal(reruns[0][2], '123');
    }
    assert.equal(f.calls().slice(n).filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
    fs.rmSync(path.join(f.graphDir, 'delivery-state-meta.json'));
    const frontFile = path.join(f.graphDir, 'delivery-front.json');
    const front = JSON.parse(fs.readFileSync(frontFile));
    front.actionable = {}; front.actionable_count = 0; front.waiting.ci = [TICKET];
    fs.writeFileSync(frontFile, JSON.stringify(front));
    assert.deepEqual(comparable(c), comparable(wait(f).watched[0].checks));
  });
}

for (const mode of ['absent', 'legacy', 'malformed']) {
  test(`${mode} metadata remains on the fresh refresh/direct compatibility path`, t => {
    const f = fixture(t);
    pendingBoard(f);
    const meta = path.join(f.graphDir, 'delivery-state-meta.json');
    if (mode === 'absent') fs.rmSync(meta);
    else fs.writeFileSync(meta, mode === 'legacy' ? '{"generation":1}' : '{');
    const before = f.calls().length;
    const result = wait(f);
    assert.equal(result.watched[0].checks.total, 1);
    const calls = f.calls().slice(before);
    assert.equal(calls.filter(a => a[0] === 'pr' && a[1] === 'checks').length, mode === 'absent' ? 1 : 0);
    if (mode !== 'absent') assert.equal(ci(events.readPublished({ graphDir: f.graphDir })).complete, true);
  });
}

test('failed publisher refresh never reuses a prior exact-head pass', t => {
  const f = fixture(t);
  pendingBoard(f);
  const before = f.calls().length;
  const result = JSON.parse(f.invoke('ci-wait.cjs', ['--graph', f.graphDir, '--json', '--timeout', '3'], {
    SHIPYARD_STATE_SYNC_FAIL_AFTER: 'state',
  }));
  assert.equal(result.watched[0].checks.total, 1);
  assert.equal(f.calls().slice(before).filter(a => a[0] === 'pr' && a[1] === 'checks').length, 1);
  assert.equal(events.readPublished({ graphDir: f.graphDir }).ok, false);
});

test('same-head new polls recollect rather than inheriting a prior pass', t => {
  const f = fixture(t);
  publish(f);
  const pending = run('build', null, { status: 'in_progress' });
  f.update({ checkPages: [{ total_count: 1, check_runs: [pending] }] });
  publish(f);
  const before = f.calls().length;
  const result = wait(f);
  assert.equal(result.settled, null);
  assert.equal(result.watched[0].checks.pending, 1);
  assert.ok(f.calls().slice(before).filter(a => a[0] === 'api' && a[1].includes('/check-runs?')).length >= 2);
  assert.equal(f.calls().slice(before).filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
});

test('complete row ordering does not create semantic model work', t => {
  const f = fixture(t, { checkPages: [{ total_count: 2, check_runs: [run('build'), run('lint', 'success', { id: 2 })] }] });
  const a = publish(f, 'one');
  f.update({ checkPages: [{ total_count: 2, check_runs: [run('lint', 'success', { id: 2 }), run('build')] }] });
  const b = publish(f, 'two');
  const ctx = { graphDir: f.graphDir, ticket: TICKET, pr: 108, head: HEAD, run_id: 'ordering' };
  events.observe({ ...ctx, observation: a.observation.tickets[TICKET] });
  assert.equal(events.observe({ ...ctx, observation: b.observation.tickets[TICKET] }).changed, false);
});

test('a same-head rerun obtains a new poll and its new rows before settlement', t => {
  const f = fixture(t);
  pendingBoard(f);
  f.update({ checkPages: [{ total_count: 1, check_runs: [run('build', 'cancelled')] }],
    afterRerun: { checkPages: [{ total_count: 1, check_runs: [run('build', 'success', { started_at: '2026-10-04T00:00:00Z' })] }] } });
  const before = f.calls().length;
  const result = wait(f, ['--timeout', '6']);
  assert.equal(result.watched[0].checks.pending, 0);
  assert.ok(result.rounds >= 2);
  const calls = f.calls().slice(before);
  assert.equal(calls.filter(a => a[0] === 'run' && a[1] === 'rerun').length, 1);
  assert.equal(calls.filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
  assert.equal(calls.filter(a => a[0] === 'api' && a[1].includes('/check-runs?')).length, result.rounds);
});

test('duplicate returned page identities cannot stand in for missing coverage', t => {
  const f = fixture(t, { checkPages: [
    { total_count: 2, check_runs: [run()] }, { total_count: 2, check_runs: [run()] },
  ] });
  const p = publish(f);
  assert.equal(ci(p).complete, false);
  assert.equal(p.state[TICKET].checks.unavailable, true);
});

for (const kind of ['projection', 'state', 'summary', 'head', 'coverage']) {
  test(`bound reader refuses inconsistent ${kind} data even with recomputed file digests`, t => {
    const f = fixture(t);
    const p = publish(f);
    const state = p.state, meta = p.metadata;
    const projected = meta.observation_projection.tickets[TICKET];
    if (kind === 'projection') projected.ci_observation.rows[0].name = 'forged';
    if (kind === 'state') state[TICKET].ci_observation.rows[0].run_id = '456';
    if (kind === 'summary') projected.checks.total += 1;
    if (kind === 'head') { state[TICKET].head_sha = 'c'.repeat(40); projected.head = 'c'.repeat(40); }
    if (kind === 'coverage') {
      state[TICKET].ci_observation.sources.check_runs.selected_count += 1;
      projected.ci_observation = state[TICKET].ci_observation;
    }
    const raw = JSON.stringify(state);
    meta.binding.state_digest = events.digest(raw);
    meta.binding.observation_digest = events.digest(meta.observation_projection);
    fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), raw);
    fs.writeFileSync(path.join(f.graphDir, 'delivery-state-meta.json'), JSON.stringify(meta));
    assert.equal(events.readPublished({ graphDir: f.graphDir }).ok, false);
  });
}

test('combined check/status pages reach the real waiter without a second collection', t => {
  const f = fixture(t);
  pendingBoard(f);
  const direct = [
    { name: 'build', state: 'SUCCESS', bucket: 'pass', link: run().html_url, startedAt: run().started_at, workflow: 'CI' },
    { name: 'external', state: 'FAILURE', bucket: 'fail', link: '', startedAt: '', workflow: '' },
    { name: 'security', state: 'PENDING', bucket: 'pending', link: '', startedAt: '', workflow: '' },
  ];
  f.update({ direct, statusPages: [
    { sha: HEAD, total_count: 2, statuses: [{ id: 1, context: 'external', state: 'failure' }] },
    { sha: HEAD, total_count: 2, statuses: [{ id: 2, context: 'security', state: 'pending' }] },
  ] });
  const before = f.calls().length;
  const result = wait(f);
  const c = result.watched[0].checks;
  assert.equal(c.total, 3);
  assert.equal(c.failing, 1);
  assert.equal(c.pending, 1);
  assert.deepEqual(c.rows.map(r => r.name), ['build', 'external', 'security']);
  const calls = f.calls().slice(before);
  assert.equal(calls.filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
  assert.equal(calls.filter(a => a[0] === 'api' && a[1].includes('/status?')).length, result.rounds);
  fs.rmSync(path.join(f.graphDir, 'delivery-state-meta.json'));
  const frontFile = path.join(f.graphDir, 'delivery-front.json');
  const front = JSON.parse(fs.readFileSync(frontFile));
  front.actionable = {}; front.actionable_count = 0; front.waiting.ci = [TICKET];
  fs.writeFileSync(frontFile, JSON.stringify(front));
  assert.deepEqual(comparable(c), comparable(wait(f).watched[0].checks));
});

test('a changed same-head workflow attempt changes the complete observation', t => {
  const f = fixture(t);
  const a = publish(f);
  f.update({ attempt: 2 });
  const b = publish(f);
  assert.equal(ci(a).rows[0].run_attempt, 1);
  assert.equal(ci(b).rows[0].run_attempt, 2);
  assert.notEqual(a.metadata.binding.observation_digest, b.metadata.binding.observation_digest);
});
