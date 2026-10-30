'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS = path.join(ROOT, 'plugins/delivery-pipeline/scripts');
const checks = require(path.join(SCRIPTS, 'check-state.cjs'));
const events = require(path.join(SCRIPTS, 'wait-events.cjs'));
const capture = require('../fixtures/phase53/github-job-attempts.json');
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const originalCapture = JSON.stringify(capture);
const OLD = 123527093931, NEW = 123531082914;
const RUN = capture.derived.workflow.id;
const { repository: REPO, head: HEAD, pr: PR } = capture.derived;
const OLD_CHECK = Number(capture.captured.all_attempt_job_pages[0].jobs.find(j => j.id === OLD).check_run_url.split('/').pop());
const NEW_CHECK = Number(capture.captured.all_attempt_job_pages[0].jobs.find(j => j.id === NEW).check_run_url.split('/').pop());
const jobsCalls = calls => calls.filter(a => a[0] === 'api' && /\/jobs\?/.test(a[1]));

function scenario({ state = 'success', matching = true, cancelled = false, queuedCapture = false } = {}) {
  const pages = clone(capture.captured.all_attempt_job_pages);
  const old = clone(capture.derived.check_runs.find(r => r.id === OLD_CHECK));
  const next = clone(capture.derived.check_runs.find(r => r.id === NEW_CHECK));
  const job = pages[0].jobs.find(j => j.id === NEW);
  if (queuedCapture) Object.assign(job, clone(capture.captured.new_job_queued_snapshot));
  if (matching) { next.name = 'test-fast'; job.name = 'test-fast'; }
  next.status = ['queued', 'in_progress'].includes(state) ? state : 'completed';
  next.conclusion = next.status === 'completed' ? state : null;
  next.started_at = job.started_at;
  Object.assign(job, { status: next.status, conclusion: next.conclusion });
  if (cancelled) {
    old.conclusion = 'cancelled';
    pages[0].jobs.find(j => j.id === OLD).conclusion = 'cancelled';
  }
  return { raw: [old, next], pages };
}

function collect(data, consumer = checks) {
  const calls = [], before = JSON.stringify(data);
  let pulls = 0;
  const observation = consumer.collectCiObservation({ pr: PR, repo: REPO, head: HEAD,
    pollId: data.pollId || 'z17-public-collector' }, args => {
    calls.push(args);
    const e = args[1];
    let value;
    if (e.endsWith(`/pulls/${PR}`)) {
      pulls += 1;
      value = { number: PR, state: 'open', head: { sha: data.move && pulls === 2 ? 'b'.repeat(40) : HEAD,
        repo: { full_name: REPO } }, base: { repo: { full_name: REPO } } };
    } else if (e.includes('/check-runs?')) {
      if (data.failChecks) return { status: 1, stderr: 'core check transport unavailable' };
      value = data.checkPages || [{ total_count: data.raw.length, check_runs: data.raw }];
    } else if (e.includes('/status?')) {
      if (data.failStatuses) return { status: 1, stderr: 'core status transport unavailable' };
      value = data.statusPages || [{ sha: HEAD, total_count: (data.statuses || []).length, statuses: data.statuses || [] }];
    } else if (/\/jobs\?/.test(e)) {
      assert.deepEqual(args, ['api', `repos/${REPO}/actions/runs/${e.match(/\/runs\/(\d+)/)[1]}/jobs?per_page=100&filter=all`, '--paginate', '--slurp']);
      if (data.jobsError === 'throw') throw new Error('optional endpoint unavailable');
      if (data.jobsError === 'transport') return { status: 1, stderr: 'optional endpoint unavailable' };
      if (data.jobsError === 'json') return { status: 0, stdout: '{malformed' };
      value = data.pagesByRun ? data.pagesByRun[e.match(/\/runs\/(\d+)/)[1]] : data.pages;
    } else {
      const match = e.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/);
      assert.ok(match, `unexpected physical endpoint ${e}`);
      const key = match[1] + (match[2] ? `/attempts/${match[2]}` : '');
      value = { ...clone(capture.derived.workflow), ...(data.runs || {})[key] };
    }
    return { status: 0, stdout: JSON.stringify(value) };
  });
  assert.equal(JSON.stringify(data), before, 'collection cannot rewrite raw inputs or job history');
  return { observation, calls, tally: consumer.classify(observation.rows) };
}

function complete(result, consumer = checks) {
  assert.equal(result.observation.complete, true, result.observation.note);
  assert.equal(consumer.compatibleCiObservation(result.observation, { pr: PR, repo: REPO, head: HEAD,
    pollId: result.observation.poll_id }), true);
  return result;
}

function conservative(data, consumer = checks) {
  const result = complete(collect(data, consumer), consumer);
  assert.equal(result.tally.failing, 1);
  assert.equal(consumer.isGreen(result.tally), false);
  assert.ok(result.observation.rows.some(r => r.id === OLD_CHECK && r.state === 'FAILURE'));
  assert.equal(result.observation.transport_unavailable, undefined, 'optional failures cannot invoke core fallback');
  return result;
}

test('retained capture provenance preserves all 77 jobs and distinct queued and completed observations', () => {
  assert.deepEqual(capture.provenance.sources.slice(0, 3).map(s => s.sha256), [
    '7986056e24f9419f8bbaf331ca0e0878d2ced90e4a2b3fb5c066bc679bc95c1f',
    '144e085133094a642bd31979af4bb8b822b7f809e56de6f65edac002d2aa0552',
    '013116672641cca6c0e6336604bdc09ff106e1c54ab7d8009706141168edf0ee',
  ]);
  const pages = capture.captured.all_attempt_job_pages;
  assert.equal(pages.length, 1);
  assert.equal(pages[0].total_count, 77);
  assert.equal(pages[0].jobs.length, 77);
  assert.equal(new Set(pages[0].jobs.map(j => j.id)).size, 77);
  assert.deepEqual([...new Set(pages[0].jobs.map(j => j.run_attempt))].sort(), [1, 2]);
  assert.equal(capture.captured.old_job_snapshot.conclusion, 'failure');
  assert.equal(capture.captured.new_job_queued_snapshot.status, 'queued');
  assert.equal(pages[0].jobs.find(j => j.id === NEW).conclusion, 'success');
  assert.ok(pages[0].jobs.some(j => j.conclusion === 'cancelled'));
  assert.equal(capture.derived.retained_old_producer_diagnostic.incorrect_projected_attempt, 2);
  assert.equal(capture.derived.retained_old_producer_diagnostic.actual_job_attempt, 1);
  assert.match(capture.provenance.projection, /reconstructed/);
  assert.equal(capture.derived.retained_old_producer_diagnostic.native_acceptance, false);
});

test('all captured plain job URLs prove their actual attempts with one complete listing', () => {
  const result = complete(collect({ raw: clone(capture.derived.check_runs), pages: clone(capture.captured.all_attempt_job_pages) }));
  assert.equal(result.observation.sources.check_runs.total_count, 77);
  const rows = result.observation.rows;
  assert.equal(rows.find(r => r.id === OLD_CHECK).run_attempt, 1);
  assert.equal(rows.find(r => r.id === NEW_CHECK).run_attempt, 2);
  assert.equal(rows.find(r => r.id === OLD_CHECK).state, 'FAILURE');
  assert.equal(rows.find(r => r.id === NEW_CHECK).state, 'QUEUED');
  assert.equal(result.tally.failing, 1, 'a differently named shard cannot replace test-fast');
  assert.equal(checks.isGreen(result.tally), false);
  assert.equal(jobsCalls(result.calls).length, 1);
  assert.equal(result.calls.filter(a => a[1].endsWith(`/actions/runs/${RUN}`)).length, 1);
  for (const row of rows) {
    const job = capture.captured.all_attempt_job_pages[0].jobs.find(j => String(j.id) === row.job_id);
    assert.ok(job, `job-owned identity for ${row.id}`);
    assert.equal(row.run_attempt, job.run_attempt);
  }
  assert.equal(rows.filter(r => r.bucket === 'cancel').length,
    capture.derived.check_runs.filter(r => r.conclusion === 'cancelled').length);
});

for (const queuedCapture of [true, false]) test(`actual differently named shard retains aggregate failure (${queuedCapture ? 'queued capture' : 'later success'})`, () => {
  const result = conservative(scenario({ matching: false, state: queuedCapture ? 'queued' : 'success', queuedCapture }));
  assert.deepEqual(result.observation.rows.map(r => r.run_attempt), [1, 2]);
});

for (const state of ['success', 'failure', 'queued', 'in_progress']) test(`controlled matching ${state} retry uses actual attempts without changing original outcomes`, () => {
  const data = scenario({ state });
  const result = complete(collect(data));
  assert.deepEqual(result.observation.rows.map(r => [r.id, r.run_attempt]), [[NEW_CHECK, 2]]);
  assert.equal(result.tally.failing, state === 'failure' ? 1 : 0);
  assert.equal(result.tally.pending, ['queued', 'in_progress'].includes(state) ? 1 : 0);
  assert.equal(checks.isGreen(result.tally), state === 'success');
  assert.equal(data.raw[0].conclusion, 'failure');
  assert.equal(capture.captured.old_job_snapshot.conclusion, 'failure');
});

for (const state of ['success', 'queued', 'in_progress']) test(`controlled ${state} replacement retains raw cancelled original and existing cancellation accounting`, () => {
  const result = complete(collect(scenario({ state, cancelled: true })));
  assert.equal(result.observation.rows.length, 2);
  assert.equal(result.observation.rows[0].state, 'CANCELLED');
  assert.deepEqual(result.observation.rows.map(r => r.run_attempt), [1, 2]);
  assert.equal(result.tally.cancelled, 0);
  assert.equal(result.tally.superseded, 1);
  assert.equal(result.tally.pending, state === 'success' ? 0 : 1);
  assert.equal(checks.isGreen(result.tally), state === 'success');
});

test('a missing replacement cannot erase the actual failed aggregate', () => {
  const data = scenario();
  data.raw.pop();
  const result = conservative(data);
  assert.equal(result.observation.rows[0].run_attempt, 1);
});

const badPages = [
  ['absent listing', () => null],
  ['absent pages', () => []],
  ['wrong envelope', p => p[0]],
  ['missing total', p => { delete p[0].total_count; return p; }],
  ['wrong total', p => { p[0].total_count++; return p; }],
  ['negative total', p => { p[0].total_count = -1; return p; }],
  ['fractional total', p => { p[0].total_count = 77.5; return p; }],
  ['missing jobs', p => { delete p[0].jobs; return p; }],
  ['nonarray jobs', p => { p[0].jobs = {}; return p; }],
  ['null job', p => { p[0].jobs[0] = null; return p; }],
  ['missing page', p => [{ total_count: 77, jobs: p[0].jobs.slice(0, 40) }]],
  ['inconsistent totals', p => [{ total_count: 77, jobs: p[0].jobs.slice(0, 40) }, { total_count: 78, jobs: p[0].jobs.slice(40) }]],
  ['empty extra page', p => [...p, { total_count: 77, jobs: [] }]],
  ['duplicate page', p => [...p, p[0]]],
  ['duplicate job across pages', p => [{ total_count: 78, jobs: p[0].jobs.slice(0, 40) },
    { total_count: 78, jobs: p[0].jobs.slice(39) }]],
  ['conflicting duplicate ID', p => { p[0].jobs.push({ ...p[0].jobs.find(j => j.id === NEW), run_attempt: 1 }); p[0].total_count++; return p; }],
  ['missing requested job', p => { p[0].jobs = p[0].jobs.filter(j => j.id !== NEW); p[0].total_count--; return p; }],
];
for (const [label, mutate] of badPages) test(`optional ${label} leaves complete factual failures`, () => {
  const data = scenario(); data.pages = mutate(data.pages);
  const result = conservative(data);
  assert.equal(jobsCalls(result.calls).length, 1, 'failed optional proof is memoized for this observation');
});

for (const jobsError of ['transport', 'json', 'throw']) test(`optional ${jobsError} failure retains raw CI without core unavailability`, () => {
  const result = conservative({ ...scenario(), jobsError });
  assert.equal(jobsCalls(result.calls).length, 1);
  assert.deepEqual(result.observation.rows.map(r => r.run_attempt), [null, null]);
});

test('one unavailable optional listing preserves all 77 raw rows and cancellations for that poll', () => {
  const result = complete(collect({ raw: clone(capture.derived.check_runs), jobsError: 'transport' }));
  assert.equal(jobsCalls(result.calls).length, 1);
  assert.equal(result.observation.rows.length, 77);
  assert.ok(result.observation.rows.every(r => r.run_attempt === null));
  assert.equal(result.tally.failing, 1);
  assert.equal(result.tally.cancelled, capture.derived.check_runs.filter(r => r.conclusion === 'cancelled').length);
  assert.equal(checks.isGreen(result.tally), false);
});

const badJob = [
  ['wrong job ID', j => { j.id++; }],
  ['unsafe job ID', j => { j.id = Number.MAX_SAFE_INTEGER + 1; }],
  ['string job ID', j => { j.id = String(j.id); }],
  ['wrong run ID', j => { j.run_id++; }],
  ['string run ID', j => { j.run_id = String(j.run_id); }],
  ['wrong head', j => { j.head_sha = 'f'.repeat(40); }],
  ['wrong name', j => { j.name = 'different shard'; }],
  ['missing attempt', j => { delete j.run_attempt; }],
  ['zero attempt', j => { j.run_attempt = 0; }],
  ['negative attempt', j => { j.run_attempt = -1; }],
  ['fractional attempt', j => { j.run_attempt = 1.5; }],
  ['string attempt', j => { j.run_attempt = '2'; }],
  ['future attempt', j => { j.run_attempt = 3; }],
  ['unsafe attempt', j => { j.run_attempt = Number.MAX_SAFE_INTEGER + 1; }],
  ['wrong check ID', j => { j.check_run_url = j.check_run_url.replace(String(NEW_CHECK), String(NEW_CHECK + 1)); }],
  ['missing check URL', j => { delete j.check_run_url; }],
  ['foreign check repository', j => { j.check_run_url = j.check_run_url.replace(REPO, 'foreign/repo'); }],
  ['foreign check origin', j => { j.check_run_url = j.check_run_url.replace('api.github.com', 'evil.example'); }],
  ['HTTP check origin', j => { j.check_run_url = j.check_run_url.replace('https:', 'http:'); }],
  ['check URL credentials', j => { j.check_run_url = j.check_run_url.replace('https://', 'https://user@'); }],
  ['check URL query', j => { j.check_run_url += '?identity=other'; }],
  ['check URL fragment', j => { j.check_run_url += '#other'; }],
  ['wrong API job locator', j => { j.url = j.url.replace(String(NEW), String(OLD)); }],
  ['foreign API job repository', j => { j.url = j.url.replace(REPO, 'foreign/repo'); }],
  ['foreign API job origin', j => { j.url = j.url.replace('api.github.com', 'evil.example'); }],
  ['missing API job URL', j => { delete j.url; }],
  ['wrong run locator', j => { j.run_url = j.run_url.replace(String(RUN), String(RUN + 1)); }],
  ['foreign run repository', j => { j.run_url = j.run_url.replace(REPO, 'foreign/repo'); }],
  ['missing run locator', j => { delete j.run_url; }],
  ['foreign HTML repository', j => { j.html_url = j.html_url.replace(REPO, 'foreign/repo'); }],
  ['foreign HTML origin', j => { j.html_url = j.html_url.replace('github.com', 'evil.example'); }],
  ['wrong HTML job', j => { j.html_url = j.html_url.replace(String(NEW), String(OLD)); }],
  ['wrong HTML run', j => { j.html_url = j.html_url.replace(String(RUN), String(RUN + 1)); }],
  ['conflicting HTML attempt', j => { j.html_url = j.html_url.replace('/job/', '/attempts/1/job/'); }],
  ['HTML query', j => { j.html_url += '?other'; }],
  ['HTML credentials', j => { j.html_url = j.html_url.replace('https://', 'https://user@'); }],
  ['missing HTML URL', j => { delete j.html_url; }],
];
for (const [label, mutate] of badJob) test(`${label} cannot prove a matching replacement`, () => {
  const data = scenario(); mutate(data.pages[0].jobs.find(j => j.id === NEW));
  conservative(data);
});

test('two job IDs claiming the same check identity cannot supply lineage', () => {
  const data = scenario(), job = data.pages[0].jobs.find(j => j.id === NEW);
  data.pages[0].jobs[0].check_run_url = job.check_run_url;
  conservative(data);
});

test('check IDs and job IDs are joined through check_run_url rather than assumed equal', () => {
  const data = scenario();
  for (const [index, id] of [[0, OLD], [1, NEW]]) {
    data.raw[index].id += 500000;
    data.pages[0].jobs.find(j => j.id === id).check_run_url = `https://api.github.com/repos/${REPO}/check-runs/${data.raw[index].id}`;
  }
  const result = complete(collect(data));
  assert.equal(result.observation.rows.length, 1);
  assert.equal(result.observation.rows[0].id, NEW_CHECK + 500000);
  assert.equal(result.observation.rows[0].job_id, String(NEW));
  assert.equal(checks.isGreen(result.tally), true);
});

test('complete multiple-page listing supplies one shared map for all checks', () => {
  const data = scenario();
  data.pages = [{ total_count: 77, jobs: data.pages[0].jobs.slice(0, 40) }, { total_count: 77, jobs: data.pages[0].jobs.slice(40) }];
  const result = complete(collect(data));
  assert.equal(result.tally.failing, 0);
  assert.equal(jobsCalls(result.calls).length, 1);
});

test('multiple ambiguous runs each fetch once and a later observation refreshes both', () => {
  const data = scenario();
  const secondRun = RUN + 1, secondJob = NEW + 1000, secondCheck = NEW_CHECK + 2000;
  const row = { ...clone(data.raw[1]), id: secondCheck, name: 'independent job',
    details_url: `https://github.com/${REPO}/actions/runs/${secondRun}/job/${secondJob}`,
    check_suite: { id: capture.derived.workflow.check_suite_id + 1 } };
  const job = { ...clone(data.pages[0].jobs.find(j => j.id === NEW)), id: secondJob, name: row.name,
    run_id: secondRun, html_url: row.details_url,
    url: `https://api.github.com/repos/${REPO}/actions/jobs/${secondJob}`,
    run_url: `https://api.github.com/repos/${REPO}/actions/runs/${secondRun}`,
    check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${secondCheck}` };
  data.raw.push(row);
  data.runs = { [secondRun]: { id: secondRun, check_suite_id: row.check_suite.id,
    run_number: capture.derived.workflow.run_number + 1, workflow_id: 999 } };
  data.pagesByRun = { [RUN]: data.pages, [secondRun]: [{ total_count: 1, jobs: [job] }] };
  for (const pollId of ['first', 'second']) {
    const result = complete(collect({ ...data, pollId }));
    assert.equal(jobsCalls(result.calls).length, 2);
    assert.equal(result.tally.failing, 0);
    assert.equal(result.observation.rows.find(r => r.id === secondCheck).run_attempt, 2);
  }
  data.pagesByRun[RUN] = null;
  assert.equal(conservative({ ...data, pollId: 'third' }).calls.filter(a => /\/jobs\?/.test(a[1])).length, 2);
});

test('initial workflow attempt1 retains its path without optional jobs metadata', () => {
  const data = scenario(); data.raw.pop(); data.runs = { [RUN]: { run_attempt: 1 } }; data.jobsError = 'throw';
  const result = conservative(data);
  assert.equal(result.observation.rows[0].run_attempt, 1);
  assert.equal(jobsCalls(result.calls).length, 0);
});

test('a lone plain-URL job cannot inherit latest attempt2 when optional proof is absent', () => {
  const data = scenario(); data.raw = [data.raw[1]]; data.jobsError = 'transport';
  const result = complete(collect(data));
  assert.equal(result.observation.rows[0].run_attempt, null);
  assert.equal(result.observation.rows[0].job_id, null);
  assert.equal(result.observation.rows[0].state, 'SUCCESS', 'raw status remains factual despite unproven optional lineage');
  assert.equal(jobsCalls(result.calls).length, 1);
});

for (const state of ['success', 'queued', 'in_progress']) test(`explicit attempt URLs preserve the existing ${state} fast path without a listing`, () => {
  const data = scenario({ state });
  data.raw.forEach((r, i) => { r.details_url = r.details_url.replace('/job/', `/attempts/${i + 1}/job/`); });
  data.runs = { [`${RUN}/attempts/1`]: { run_attempt: 1 }, [`${RUN}/attempts/2`]: { run_attempt: 2 } };
  data.jobsError = 'throw';
  const result = complete(collect(data));
  assert.equal(result.tally.failing, 0);
  assert.equal(result.tally.pending, state === 'success' ? 0 : 1);
  assert.equal(checks.isGreen(result.tally), state === 'success');
  assert.equal(jobsCalls(result.calls).length, 0);
  assert.equal(result.calls.filter(a => /\/attempts\/[12]$/.test(a[1])).length, 2);
});

test('an explicit attempt mismatch stays unproven without falling through to optional lookup', () => {
  const data = scenario();
  data.raw[0].details_url = data.raw[0].details_url.replace('/job/', '/attempts/1/job/');
  data.runs = { [`${RUN}/attempts/1`]: { run_attempt: 2 } };
  const result = conservative(data);
  assert.equal(result.observation.rows.find(r => r.id === OLD_CHECK).run_attempt, null);
  assert.equal(jobsCalls(result.calls).length, 1, 'only the other plain URL needs lineage');
});

for (const [label, patch] of [
  ['unknown workflow attempt', { run_attempt: null }], ['wrong suite', { check_suite_id: 1 }],
  ['wrong workflow head', { head_sha: 'b'.repeat(40) }], ['wrong workflow ID', { workflow_id: 0 }],
  ['foreign workflow repository', { repository: { full_name: 'foreign/repo' } }],
  ['foreign head repository', { head_repository: { full_name: 'foreign/repo' } }],
]) test(`${label} refuses enrichment before optional lookup`, () => {
  const data = scenario(); data.runs = { [RUN]: patch };
  assert.equal(jobsCalls(conservative(data).calls).length, 0);
});

for (const [label, mutate] of [
  ['missing timestamp', d => { d.raw[1].started_at = ''; }],
  ['backwards timestamp', d => { d.raw[1].started_at = '2000-01-01T00:00:00Z'; }],
  ['conflicting suite', d => { d.raw[1].check_suite.id++; }],
  ['independent App', d => { d.raw[1].app = { id: 401, slug: 'independent' }; }],
  ['conflicting check locator', d => { d.raw[1].html_url = d.raw[0].details_url; }],
]) test(`${label} cannot manufacture matching authority`, () => {
  const data = scenario(); mutate(data); conservative(data);
});

test('matching retries cannot hide independent Apps or commit status failures', () => {
  const data = scenario();
  data.raw.push({ ...clone(data.raw[0]), id: 99, app: { id: 401, slug: 'independent' }, details_url: '' });
  data.statuses = [{ id: 11, context: 'test-fast', state: 'failure' },
    { id: 12, context: 'security', state: 'failure' }];
  const result = complete(collect(data));
  assert.equal(result.tally.failing, 3);
  assert.equal(checks.isGreen(result.tally), false);
  assert.deepEqual(result.observation.rows.map(r => r.id), [NEW_CHECK, 99, 11, 12]);
});

for (const [label, patch, transport] of [
  ['check transport', { failChecks: true }, true], ['status transport', { failStatuses: true }, true],
  ['incomplete check coverage', { checkPages: [{ total_count: 2, check_runs: [] }] }, false],
  ['foreign status head', { statusPages: [{ total_count: 0, statuses: [], sha: 'b'.repeat(40) }] }, false],
  ['checked head movement', { move: true }, false],
]) test(`mandatory ${label} retains existing unavailable/incomplete semantics`, () => {
  const result = collect({ ...scenario(), ...patch });
  assert.equal(result.observation.complete, false);
  assert.equal(result.observation.availability, 'unavailable');
  assert.equal(result.observation.rows, null);
  assert.equal(result.observation.transport_unavailable === true, transport);
  assert.equal(checks.isGreen(result.tally), false);
});

function setupOnly() {
  const file = path.join(__dirname, 'phase53-z11-ci-check-identity.test.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const end = source.indexOf('\ntest(');
  assert.ok(end > 0);
  let registrations = 0;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:test' ? { test: () => { registrations++; } } : originalRequire(name);
  loaded._compile(source.slice(0, end) + '\nmodule.exports = { fixture, publish, wait, ci, pendingBoard, HEAD, TICKET };\n', file);
  assert.equal(registrations, 0, 'the old suite must never register or execute');
  assert.equal(require.cache[file], undefined);
  return loaded.exports;
}
const setup = setupOnly();

function ordinary(t) {
  const f = setup.fixture(t);
  const file = path.join(f.root, 'bin/gh');
  const source = fs.readFileSync(file, 'utf8');
  const anchor = " const e = a[1];";
  assert.equal(source.split(anchor).length, 2);
  const extension = `
 if (/\\/actions\\/runs\\/\\d+\\/jobs\\?per_page=100&filter=all$/.test(e)) {
  if (d.jobsError === 'transport') process.exit(1);
  if (d.jobsError === 'json') { process.stdout.write('{malformed'); process.exit(0); }
  emit(d.jobPages); process.exit(0);
 }
 const attempt = e.match(/\\/actions\\/runs\\/(\\d+)\\/attempts\\/(\\d+)$/);
 if (attempt) { emit(d.explicitRuns && d.explicitRuns[attempt[1] + '/attempts/' + attempt[2]]); process.exit(0); }
`;
  fs.writeFileSync(file, source.replace(anchor, anchor + extension), { mode: 0o755 });
  return f;
}

function ordinaryData(data) {
  const text = JSON.stringify(data).split(REPO).join('acme/demo').split(HEAD).join(setup.HEAD);
  const d = JSON.parse(text);
  return { checkPages: d.checkPages || [{ total_count: d.raw.length, check_runs: d.raw }],
    jobPages: d.pages, runs: { [RUN]: { ...capture.derived.workflow, head_sha: setup.HEAD,
      repository: { full_name: 'acme/demo' }, head_repository: { full_name: 'acme/demo' } }, ...d.runs },
    statusPages: d.statusPages || [{ sha: setup.HEAD, total_count: (d.statuses || []).length, statuses: d.statuses || [] }],
    move: d.move, failChecks: d.failChecks, failStatuses: d.failStatuses, jobsError: d.jobsError,
    direct: d.direct || [] };
}

function assertPublication(f, p) {
  assert.equal(p.ok, true, p.reason);
  const file = path.join(f.graphDir, 'delivery-state.json');
  const metadata = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state-meta.json')));
  assert.ok(metadata.generation > 0);
  assert.equal(metadata.binding.observation_generation, metadata.generation);
  assert.equal(metadata.binding.state_digest, hash(fs.readFileSync(file)));
  assert.equal(metadata.binding.observation_digest.length, 64);
  assert.deepEqual(p.ci_observations[setup.TICKET], setup.ci(p));
  return metadata.generation;
}

for (const kind of ['success', 'queued', 'in_progress', 'missing', 'unrelated', 'unproven', 'independent', 'status']) {
  test(`ordinary publisher and fresh waiter agree on controlled ${kind} replacement`, { timeout: 180000 }, t => {
    const f = ordinary(t);
    const data = scenario({ state: ['queued', 'in_progress'].includes(kind) ? kind : 'success', matching: kind !== 'unrelated' });
    if (kind === 'missing') data.raw.pop();
    if (kind === 'unproven') data.pages = null;
    if (kind === 'independent') data.raw.push({ ...clone(data.raw[0]), id: 99, app: { id: 401, slug: 'external' }, details_url: '' });
    if (kind === 'status') data.statuses = [{ id: 88, context: 'test-fast', state: 'failure' }];
    const mapped = ordinaryData(data);
    setup.pendingBoard(f);
    f.update(mapped);
    const before = f.calls().length;
    const p = setup.publish(f, `z17-${kind}`);
    const generation = assertPublication(f, p);
    const observed = setup.ci(p), expected = complete(collect(data));
    const mappedRows = JSON.parse(JSON.stringify(expected.observation.rows).split(REPO).join('acme/demo').split(HEAD).join(setup.HEAD));
    assert.deepEqual(observed.rows, mappedRows);
    const summary = checks.classify(observed.rows);
    assert.equal(p.state[setup.TICKET].checks.failing, summary.failing);
    assert.equal(p.state[setup.TICKET].checks.pending, summary.pending);
    assert.equal(jobsCalls(f.calls().slice(before)).length, 1);
    setup.pendingBoard(f);
    f.update(mapped);
    const start = f.calls().length;
    const waited = setup.wait(f).watched[0].checks;
    const current = events.readPublished({ graphDir: f.graphDir });
    assert.ok(assertPublication(f, current) > generation);
    assert.deepEqual(waited.rows, mappedRows);
    for (const key of ['total', 'failing', 'pending', 'cancelled']) assert.equal(waited[key], summary[key], key);
    assert.deepEqual(checks.classify(waited.rows), summary);
    assert.equal(checks.isGreen(waited), kind === 'success');
    assert.deepEqual(current.ci_observations[setup.TICKET].rows, waited.rows);
    assert.notEqual(setup.ci(current).poll_id, observed.poll_id);
    assert.equal(checks.compatibleCiObservation(observed, { head: setup.HEAD, pollId: setup.ci(current).poll_id }), false);
    assert.equal(checks.compatibleCiObservation(observed, { head: 'b'.repeat(40) }), false);
    assert.ok(jobsCalls(f.calls().slice(start)).length >= 1);
    assert.equal(f.calls().slice(start).filter(a => a[0] === 'pr' && a[1] === 'checks').length, 0);
  });
}

test('publication byte/hash tampering refuses reuse and a cold waiter obtains a fresh failure', { timeout: 180000 }, t => {
  const f = ordinary(t);
  setup.pendingBoard(f);
  f.update(ordinaryData(scenario()));
  const previous = setup.publish(f, 'old-success');
  setup.pendingBoard(f);
  const file = path.join(f.graphDir, 'delivery-state.json');
  fs.appendFileSync(file, '\n');
  assert.equal(events.readPublished({ graphDir: f.graphDir }).ok, false);
  const data = scenario(); data.pages = null;
  f.update(ordinaryData(data));
  const result = setup.wait(f).watched[0].checks;
  assert.equal(result.failing, 1);
  assert.equal(checks.isGreen(result), false);
  assert.notEqual(setup.ci(events.readPublished({ graphDir: f.graphDir })).poll_id, setup.ci(previous).poll_id);
});

test('fresh waiter cannot reuse old-head success and core outages retain direct fallback behavior', { timeout: 180000 }, t => {
  const f = ordinary(t);
  setup.pendingBoard(f);
  f.update(ordinaryData(scenario()));
  const previous = setup.publish(f, 'old-green');
  setup.pendingBoard(f);
  f.update({ ...ordinaryData(scenario()), move: true,
    direct: [{ name: 'test-fast', state: 'QUEUED', bucket: 'pending', link: '', startedAt: '', workflow: '' }] });
  const stale = setup.wait(f).watched[0].checks;
  assert.equal(stale.pending, 1);
  assert.equal(checks.isGreen(stale), false);
  const moved = events.readPublished({ graphDir: f.graphDir });
  assert.equal(moved.state[setup.TICKET].checks.unavailable, true);
  assert.equal(moved.ci_observations[setup.TICKET], undefined);
  setup.pendingBoard(f);
  const direct = [{ name: 'test-fast', state: 'FAILURE', bucket: 'fail', link: '', startedAt: '', workflow: '' }];
  f.update({ ...ordinaryData(scenario()), failChecks: true, direct });
  const start = f.calls().length;
  const result = setup.wait(f).watched[0].checks;
  assert.equal(result.failing, 1);
  assert.deepEqual(result.rows, direct);
  assert.ok(f.calls().slice(start).some(a => a[0] === 'pr' && a[1] === 'checks'));
  assert.equal(checks.compatibleCiObservation(setup.ci(previous), { pollId: 'new-poll' }), false);
});

function inventory(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix + entry.name, file = path.join(directory, relative), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, relative);
    const row = { path: relative, mode: stat.mode & 0o777, directory: entry.isDirectory() };
    return entry.isDirectory() ? [row, ...inventory(directory, relative + '/')] : [{ ...row, digest: hash(fs.readFileSync(file)) }];
  });
}

test('real isolated builder reproduces complete inventory and independently loaded staged attempt consumer', { timeout: 180000 }, t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'z17-package-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const shipped = path.join(ROOT, 'plugins/shipyard'), before = inventory(shipped);
  const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(tmp, 'package'));
  assert.deepEqual(inventory(shipped), before, 'isolated builder cannot mutate tracked package');
  const actual = inventory(candidate);
  assert.deepEqual(actual, before);
  const owned = new Set(['host/plugins/delivery-pipeline/scripts/check-state.cjs', '.codex-plugin/plugin.json', 'package-build.json']);
  const priorMirrors = {
    'ci-wait.cjs': { mode: 493, digest: 'a22edb2ce48790bae6bc8526405fdd86cd8818c76126d6e72decece58af962b4' },
    'codex-runtime-host.cjs': { mode: 420, digest: 'f684acac76b9ae49ffcb7c890ff47cf7964d90558556dddb377381f49c1a9968' },
    'role-artifact.cjs': { mode: 420, digest: '52e676c0d76e5e81a68a1040f03eac03b773211bde36204b271a934160e8a4cd' },
  };
  const previous = actual.filter(r => !owned.has(r.path)).map(row => {
    const name = Object.keys(priorMirrors).find(name => row.path === `host/plugins/delivery-pipeline/scripts/${name}`);
    if (!name) return row;
    const canonical = path.join(SCRIPTS, name), mirror = path.join(candidate, row.path);
    assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(canonical));
    assert.equal(row.directory, false);
    assert.equal(row.mode, fs.statSync(canonical).mode & 0o777);
    assert.equal(row.mode, priorMirrors[name].mode);
    return { ...row, ...priorMirrors[name], directory: false };
  });
  assert.equal(previous.filter(r => Object.values(priorMirrors).some(prior => prior.digest === r.digest)).length, 3);
  assert.equal(hash(JSON.stringify(previous)), capture.parent.other_package_inventory_sha256);
  const mirror = path.join(candidate, 'host/plugins/delivery-pipeline/scripts/check-state.cjs');
  assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(path.join(SCRIPTS, 'check-state.cjs')));
  assert.equal(fs.statSync(mirror).mode & 0o777, fs.statSync(path.join(SCRIPTS, 'check-state.cjs')).mode & 0o777);
  const digest = crypto.createHash('sha256');
  for (const row of actual.filter(r => !r.directory && !['.codex-plugin/plugin.json', 'package-build.json'].includes(r.path))) {
    digest.update(row.path + '\0').update(fs.readFileSync(path.join(candidate, row.path)));
  }
  const sourceDigest = digest.digest('hex');
  const bytes = fs.readFileSync(path.join(candidate, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(bytes), identity = JSON.parse(fs.readFileSync(path.join(candidate, 'package-build.json')));
  const version = require('../../plugins/delivery-pipeline/.claude-plugin/plugin.json').version;
  assert.equal(manifest.version, `${version}+codex.${sourceDigest.slice(0, 16)}`);
  assert.equal(identity.version, manifest.version);
  assert.equal(identity.digest, crypto.createHash('sha256').update(sourceDigest).update('\0').update(bytes).digest('hex'));
  assert.equal(require.cache[mirror], undefined);
  const staged = require(mirror);
  assert.notEqual(staged, checks);
  const real = complete(collect({ raw: clone(capture.derived.check_runs), pages: clone(capture.captured.all_attempt_job_pages) }, staged), staged);
  assert.equal(real.observation.rows.find(r => r.id === OLD_CHECK).run_attempt, 1);
  assert.equal(real.observation.rows.find(r => r.id === NEW_CHECK).run_attempt, 2);
  assert.equal(real.tally.failing, 1);
  for (const state of ['success', 'queued', 'in_progress']) {
    const source = complete(collect(scenario({ state })));
    const shippedResult = complete(collect(scenario({ state }), staged), staged);
    assert.deepEqual(shippedResult.observation, source.observation);
    assert.deepEqual(shippedResult.tally, source.tally);
  }
  conservative({ ...scenario(), pages: null }, staged);
  conservative(scenario({ matching: false }), staged);
  const child = spawnSync(process.execPath, ['-e', `
    const c = require(process.argv[1]);
    const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (!c.compatibleCiObservation(o, { head: o.checked_head, pollId: o.poll_id })) process.exit(2);
    process.stdout.write(JSON.stringify({ rows: o.rows, tally: c.classify(o.rows), complete: true }));
  `, mirror], { input: JSON.stringify(real.observation), encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(Buffer.byteLength(child.stdout) + Buffer.byteLength(child.stderr) <= 8 * 1024 * 1024);
  assert.deepEqual(JSON.parse(child.stdout), { rows: real.observation.rows, tally: real.tally, complete: true });
});

test('actual selector preserves all parent36 rows and appends z17 alone as shard37 and expected check40', () => {
  const selector = require('./shard-files.cjs');
  const manifest = selector.readManifest();
  assert.equal(hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.equal(manifest.shards.length, 16);
  assert.equal(capture.parent.source, '4f9da2383097a4c206a61741fbd24ac69646990c');
  assert.equal(capture.parent.shards.length, 36);
  const final = selector.appendShard(manifest, selector.unitTasks(selector.unitFiles()));
  assert.ok(final.shards.length >= 37);
  assert.deepEqual(final.shards.slice(0, 36), capture.parent.shards);
  assert.deepEqual(final.shards.slice(0, 16), manifest.shards);
  assert.equal(hash(JSON.stringify(final.shards.slice(0, 28))), 'd25784320d6e89ddf07aa22ce3487b65b2b1a476e0f7a816e034ca7f88b1c025');
  assert.deepEqual(final.shards[36], ['phase53-z17-ci-job-attempts.test.cjs']);
  assert.equal(hash(JSON.stringify(final.shards.slice(0, 37))), '5bf00ad885a7e3e264b1dcdb8ad32fedb9d7d7d4ccd23928a1d7b4c184bba84c');
  for (let i = 0; i < final.shards.length; i++)
    assert.deepEqual(selector.selectTaskShard(`${i + 1}/${final.shards.length}`), final.shards[i]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z17-future-shard-'));
  try {
    for (const file of selector.unitFiles()) fs.writeFileSync(path.join(directory, file), '');
    const future = 'phase53-z99-future.test.cjs';
    fs.writeFileSync(path.join(directory, future), '');
    const appended = selector.appendShard(final, selector.unitTasks(selector.unitFiles(directory)));
    assert.deepEqual(appended.shards.slice(0, final.shards.length), final.shards);
    assert.deepEqual(appended.shards.at(-1), [future]);
    for (let i = 0; i < appended.shards.length; i++)
      assert.deepEqual(selector.selectTaskShard(`${i + 1}/${appended.shards.length}`, directory, final), appended.shards[i]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  assert.deepEqual([...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):\n/gm)].map(m => m[1]), ['shards', 'unit', 'rest', 'test-fast']);
  assert.equal(final.shards.slice(0, 37).length + 3, 40, 'historical 37 unit rows plus three checks; no remote CI credit');
});

test('all captured inputs and historical failed/cancelled outcomes remain immutable', () => {
  assert.equal(JSON.stringify(capture), originalCapture);
  assert.equal(capture.captured.old_job_snapshot.run_attempt, 1);
  assert.equal(capture.captured.old_job_snapshot.conclusion, 'failure');
  assert.ok(capture.captured.all_attempt_job_pages[0].jobs.some(j => j.conclusion === 'cancelled'));
});
