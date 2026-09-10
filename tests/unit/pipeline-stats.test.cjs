'use strict';

// pipeline-stats.cjs is the tool built to MEASURE the conveyor, which makes a
// wrong number here a wrong number about everything else. It had no unit suite
// at all until this file, and the defect it was measured making is the reason
// one is warranted: for phase 27 it printed
//
//   [since 2d] 8 human_checkpoint ticket PR(s) were merged by a person, as the
//   contract requires (the guard refuses them): … T-27-02#64, T-27-03#66, …
//
// while the journal said, for three of those eight:
//
//   {"event":"merge","ticket":"T-27-02","pr":64,"by":"sentinel","preauthorized":true}
//
// The predicate asked whether the PR was MERGED and the ticket a
// `human_checkpoint`, and never asked WHO — justified by a comment stating that
// a guarded merge of a checkpoint is "impossible by construction", which was
// true when it was written and stopped being true when `delivery.preauthorized`
// shipped: `needsHuman()` returns false for a pre-authorized ticket, so the
// guard merges it after re-verifying every other gate. Prose asserting a
// behaviour the code no longer has — arriving through the one door re-reading
// the file cannot close, because what changed was three files away.
//
// So the assertions here are about ATTRIBUTION, and each one is negative as well
// as positive: a count that names everybody on both lines satisfies any
// positive-only assertion while still crediting the guard's merges to a person.
//
// The script is exercised as a SUBPROCESS against a stub `gh`, the way
// ci-wait.test.cjs does it: the subject is our arithmetic over the journal, not
// GitHub, and the numbers must be reproducible without a network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-stats.cjs'
);

const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString();
const recently = iso(Date.now() - DAY); // inside the default 14d warning window

// A checkpoint ticket and its merged PR. The branch is what matchTicketPr keys
// on first, so ticket and PR row carry the same one.
const ticket = (id, over = {}) => ({
  [id]: {
    phase: '27',
    risk: 'high',
    human_checkpoint: true,
    branch: `ticket/${id}-x`,
    title: `${id} something`,
    ...over,
  },
});
const mergedPr = (id, number) => ({
  number,
  state: 'MERGED',
  isDraft: false,
  headRefName: `ticket/${id}-x`,
  baseRefName: 'epic/27-x',
  createdAt: iso(Date.now() - 2 * DAY),
  mergedAt: recently,
  url: `https://example.invalid/pull/${number}`,
  title: `${id}: something`,
});

// The guard's own record, as `sentinel.cjs merge` writes it — `preauthorized` is
// present only when it is WHY the merge was allowed.
const guardMerge = (id, pr, preauthorized) => JSON.stringify({
  ts: recently, event: 'merge', ticket: id, pr, base: 'epic/27-x', by: 'sentinel',
  ...(preauthorized ? { preauthorized: true } : {}),
});

// gh is called twice per repo: the bulk window (`--state all`) and the cheap
// open-only review-decision pass. Anything else exits non-zero, which the script
// already tolerates — `pr view` for merged-by attribution is only reached for
// UNGUARDED merges, and a checkpoint is never one of those.
function stubGh(dir, prs) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'),
    '#!/bin/sh\n' +
    'case "$*" in\n' +
    '  *"--state open"*) echo "[]" ;;\n' +
    `  *"--state all"*) cat <<'J'\n${JSON.stringify(prs)}\nJ\n    ;;\n` +
    '  *) echo "stub gh: unhandled: $*" >&2; exit 1 ;;\n' +
    'esac\n', { mode: 0o755 });
  return bin;
}

// tickets → journal lines → PR rows, in one temp project.
function project({ tickets, journal, prs, config, configRaw }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stats-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'tickets.json'), JSON.stringify({ tickets }));
  fs.writeFileSync(path.join(g, 'delivery-log.jsonl'), journal.map((l) => `${l}\n`).join(''));
  if (config !== undefined || configRaw !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      configRaw !== undefined ? configRaw : JSON.stringify(config, null, 2),
    );
  }
  const bin = stubGh(dir, prs);
  return { dir, bin };
}

function run(fixture, args = []) {
  const { dir, bin } = project(fixture);
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), dir };
}
const asJson = (fixture) => {
  const r = run(fixture, ['--json']);
  return { code: r.code, json: JSON.parse(r.out) };
};

// The line, not the whole report: an assertion over the full output cannot tell
// which line named a ticket, and "which line" is the entire subject here.
const lineWith = (out, re) => out.split('\n').filter((l) => re.test(l));
const one = (out, re, what) => {
  const hits = lineWith(out, re);
  assert.strictEqual(hits.length, 1, `expected exactly one ${what} line, got ${hits.length}:\n${out}`);
  return hits[0];
};

// Three merged by the guard under pre-authorization (the user signed off on each
// at decomposition time on 2026-09-08), one merged by a person — the exact shape
// phase 27 had when the report credited all four to a person.
const THREE_AND_ONE = {
  tickets: {
    ...ticket('T-27-02'), ...ticket('T-27-03'), ...ticket('T-27-04'),
    ...ticket('T-27-09'),
  },
  journal: [
    guardMerge('T-27-02', 64, true),
    guardMerge('T-27-03', 66, true),
    guardMerge('T-27-04', 68, true),
    // T-27-09 has no merge event at all: nothing of the guard's ran, a person
    // pressed the button. That absence is the only evidence there is, and it is
    // enough.
  ],
  prs: [mergedPr('T-27-02', 64), mergedPr('T-27-03', 66), mergedPr('T-27-04', 68), mergedPr('T-27-09', 71)],
};

// A checkpoint the guard merged with NO pre-authorization recorded. Not a
// counting question: either the gate was bypassed or a pre-authorization went
// unrecorded, and both are worth a person's attention.
const UNAUTHORIZED = {
  tickets: { ...ticket('T-27-10') },
  journal: [guardMerge('T-27-10', 72, false)],
  prs: [mergedPr('T-27-10', 72)],
};

suite('pipeline-stats — a checkpoint merge is attributed to whoever made it');

test('the guard\'s pre-authorized merges are counted apart from the human ones', () => {
  const { code, out } = run(THREE_AND_ONE);
  assert.strictEqual(code, 0, `pipeline-stats exited ${code}:\n${out}`);

  const human = one(out, /merged by a person/, 'human-merge');
  const guard = one(out, /pre-authorization/, 'pre-authorized-merge');

  // Positive: the counts are right and they are TWO lines, not one.
  assert.ok(/\b1\b/.test(human), `the human line must count one, got: ${human}`);
  assert.ok(/\b3\b/.test(guard), `the pre-authorized line must count three, got: ${guard}`);

  // Negative, and this is the half that discriminates: on base a single line
  // claimed all four were a person's, which satisfies every positive assertion
  // about "the human line names T-27-09".
  for (const id of ['T-27-02', 'T-27-03', 'T-27-04']) {
    assert.ok(!human.includes(id), `${id} was merged by the guard; the human line must not claim it: ${human}`);
    assert.ok(guard.includes(id), `${id} was merged by the guard under pre-authorization and must be named: ${guard}`);
  }
  assert.ok(human.includes('T-27-09'), `T-27-09 was merged by a person and must be named: ${human}`);
  assert.ok(!guard.includes('T-27-09'), `T-27-09 has no guard merge event; the guard line must not claim it: ${guard}`);

  // Neither legitimate case is a warning.
  assert.strictEqual(
    lineWith(out, /^⚠/).length, 0,
    `both cases are correct behaviour and must not be flagged:\n${out}`
  );
});

test('the attribution is per-ticket in --json too, not only in the prose', () => {
  const { code, json } = asJson(THREE_AND_ONE);
  assert.strictEqual(code, 0, 'the json path exits 0');
  const row = (id) => json.tickets.find((r) => r.ticket === id);
  for (const id of ['T-27-02', 'T-27-03', 'T-27-04']) {
    assert.strictEqual(row(id).checkpoint_preauthorized_merge, true, `${id} is a pre-authorized guard merge`);
    assert.strictEqual(row(id).checkpoint_human_merge, false, `${id} was not merged by a person`);
    assert.strictEqual(row(id).checkpoint_unauthorized_merge, false, `${id} carries its pre-authorization`);
  }
  assert.strictEqual(row('T-27-09').checkpoint_human_merge, true, 'T-27-09 has no guard merge event');
  assert.strictEqual(row('T-27-09').checkpoint_preauthorized_merge, false, 'T-27-09 claims no pre-authorization');
});

test('a guard merge of a checkpoint with no pre-authorization is a WARNING', () => {
  const { code, out } = run(UNAUTHORIZED);
  assert.strictEqual(code, 0, `pipeline-stats exited ${code}:\n${out}`);

  const warn = one(out, /^⚠.*pre-authoriz/, 'unauthorized-checkpoint-merge');
  assert.ok(warn.includes('T-27-10'), `the warning must name the ticket: ${warn}`);
  assert.ok(/#?72/.test(warn), `the warning must name the PR: ${warn}`);

  // And it must not ALSO be reported as one of the two legitimate cases — folded
  // into the neutral line is exactly how it was invisible before.
  assert.strictEqual(
    lineWith(out, /merged by a person/).length, 0,
    `the guard merged this one; no line may say a person did:\n${out}`
  );
  assert.strictEqual(
    lineWith(out, /under pre-authorization/).length, 0,
    `there was no pre-authorization to count:\n${out}`
  );

  const { json } = asJson(UNAUTHORIZED);
  const row = json.tickets.find((r) => r.ticket === 'T-27-10');
  assert.strictEqual(row.checkpoint_unauthorized_merge, true, 'the row carries the warning case');
  assert.strictEqual(row.checkpoint_human_merge, false, 'and neither of the two neutral ones');
  assert.strictEqual(row.checkpoint_preauthorized_merge, false, 'and neither of the two neutral ones');
});

test('a hand-written merge event with no `by` is still a human merge', () => {
  // The dedupe block in pipeline-stats.cjs exists because journals in the wild
  // carry merge records a run wrote by hand. Such a record proves a merge
  // happened, never that the GUARD made it, so the discriminator is `by:
  // "sentinel"` and not the presence of the event — otherwise a hand-written
  // line would silently move a human merge into the guard's column.
  const { out } = run({
    tickets: { ...ticket('T-27-09') },
    journal: [JSON.stringify({ ts: recently, event: 'merge', ticket: 'T-27-09', pr: 71 })],
    prs: [mergedPr('T-27-09', 71)],
  });
  const human = one(out, /merged by a person/, 'human-merge');
  assert.ok(human.includes('T-27-09'), `an event with no actor attributes nothing to the guard: ${human}`);
  assert.strictEqual(lineWith(out, /^⚠.*pre-authoriz/).length, 0, `and it is not the warning case:\n${out}`);
});

suite('pipeline-stats — ladder coverage is windowed and explicit');

test('dispatch routing fields are grouped without turning missing observations into zeroes', () => {
  const recentComplete = {
    ts: recently, event: 'dispatch', ticket: 'T-01-01', role: 'executor',
    model: 'sonnet', effort: 'high', effort_applied: 'high',
    reason: 'tier=level:routine(sonnet) effort=row(high)', task_level: 'routine',
    runtime: 'claude', backend: 'workflow', observed_model: 'claude-sonnet-5',
    observed_effort: 'high',
  };
  const recentPartial = {
    ts: recently, event: 'dispatch', ticket: 'T-01-02', role: 'arch-review',
    model: 'opus', effort: 'xhigh', reason: 'tier=floor(opus) effort=row(xhigh)',
  };
  const old = {
    ts: iso(Date.now() - 30 * DAY), event: 'dispatch', ticket: 'T-01-03', role: 'executor',
    model: 'opus', effort: 'high', reason: 'tier=floor(opus) effort=row(high)',
    task_level: 'complex', runtime: 'claude', backend: 'workflow', observed_model: 'claude-opus-5',
  };
  const { code, json } = asJson({
    tickets: {}, journal: [JSON.stringify(recentComplete), JSON.stringify(recentPartial), JSON.stringify(old)], prs: [],
    config: { delivery_pipeline: { model_ladder: 'adaptive' } },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(json.ladder.mode, 'adaptive');
  assert.strictEqual(json.ladder.policy_valid, true);
  assert.strictEqual(json.ladder.dispatches, 2, 'default window excludes the old dispatch');
  assert.deepStrictEqual(json.ladder.by_role, { executor: 1, 'arch-review': 1 });
  assert.deepStrictEqual(json.ladder.by_task_level, { routine: 1 });
  assert.deepStrictEqual(json.ladder.by_runtime, { claude: 1 });
  assert.deepStrictEqual(json.ladder.by_backend, { workflow: 1 });
  assert.deepStrictEqual(json.ladder.by_agent_file, {});
  assert.deepStrictEqual(json.ladder.by_effort, { high: 1, xhigh: 1 });
  assert.deepStrictEqual(json.ladder.by_effort_applied, { high: 1 });
  assert.deepStrictEqual(json.ladder.by_observed_model, { 'claude-sonnet-5': 1 });
  assert.deepStrictEqual(json.ladder.by_observed_effort, { high: 1 });
  assert.strictEqual(json.ladder.missing_model, 0);
  assert.strictEqual(json.ladder.missing_task_level, 1);
  assert.strictEqual(json.ladder.missing_runtime, 1);
  assert.strictEqual(json.ladder.missing_backend, 1);
  assert.strictEqual(json.ladder.missing_agent_file, 0, 'runtime is unknown, so Codex file coverage is unknown too');
  assert.strictEqual(json.ladder.missing_observed_model, 1);
  assert.strictEqual(json.ladder.missing_observed_effort, 1);
});

test('an invalid policy is visible in the ladder report', () => {
  const { code, json } = asJson({
    tickets: {}, journal: [JSON.stringify({ ts: recently, event: 'dispatch', ticket: 'T-01-01', role: 'executor' })],
    prs: [], configRaw: '{"delivery_pipeline":{"model_ladder":"adaptive"',
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(json.ladder.policy_valid, false);
  assert.ok(json.ladder.policy_error && json.ladder.policy_error.file);
  assert.strictEqual(json.ladder.mode, 'conservative', 'invalid policy cannot enable a treatment');
});

test('Codex agent-file coverage is required only when the runtime is known', () => {
  const complete = {
    ts: recently, event: 'dispatch', ticket: 'T-01-01', role: 'arch-review',
    model: 'sonnet', effort: 'high', runtime: 'codex', backend: 'codex-agent',
    agent_file: 'shipyard-arch-review-critical', observed_model: 'gpt-6-astra',
  };
  const partial = {
    ts: recently, event: 'dispatch', ticket: 'T-01-02', role: 'arch-review',
    model: 'sonnet', effort: 'high', runtime: 'codex', backend: 'codex-agent',
  };
  const { code, json } = asJson({ tickets: {}, journal: [JSON.stringify(complete), JSON.stringify(partial)], prs: [] });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(json.ladder.by_agent_file, { 'shipyard-arch-review-critical': 1 });
  assert.strictEqual(json.ladder.missing_agent_file, 1);
});

done();
