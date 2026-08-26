'use strict';

// The actionable front IS the run's stop condition, so its edge cases are the
// ones that cost whole sessions: a PR waiting on CI must not read as a fixpoint,
// and it must not read as "block here" either.

const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const { computeFront, formatFront, ciEstimates, needsHuman, checkpointParentOf } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
));

const checks = (failing = 0, pending = 0, total = 3) => ({ total, failing, pending, none_reported: total === 0 });

suite('front — actionable buckets');

test('a ready pending ticket is executable work', () => {
  const f = computeFront({ 'T-01-01': {} }, { 'T-01-01': { status: 'pending', ready: true } });
  assert.deepStrictEqual(f.actionable.execute, ['T-01-01']);
  assert.strictEqual(f.fixpoint, false);
});

test('a branched ticket with no PR is publish work, not a curiosity', () => {
  const f = computeFront({ 'T-01-02': {} }, { 'T-01-02': { status: 'branched', ready: true, needs_pr: true } });
  assert.deepStrictEqual(f.actionable.publish, ['T-01-02']);
  assert.strictEqual(f.fixpoint, false);
});

test('failing checks are fix work', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, checks: checks(2, 0) } });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
});

test('green + draft is finalize work (threads, arch-review, conform, undraft)', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: true, checks: checks() } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('green, out of draft, review unsettled is still finalize work', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: false, review_decision: null, checks: checks() } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('a PR with no checks reported counts as green rather than stalling the front', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: true, checks: checks(0, 0, 0) } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

suite('front — waiting is not a fixpoint and not a reason to block');

test('pending checks are waiting:ci, NOT actionable, NOT a fixpoint', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, checks: checks(0, 3) } });
  assert.strictEqual(f.actionable_count, 0);
  assert.deepStrictEqual(f.waiting.ci, ['T']);
  assert.strictEqual(f.fixpoint, false, 'a running CI queue is not a fixpoint');
});

test('watching CI is only sanctioned when nothing else is actionable', () => {
  const busy = computeFront(
    { A: {}, B: {} },
    { A: { status: 'pr-open', pr: 1, checks: checks(0, 2) }, B: { status: 'pending', ready: true } }
  );
  assert.ok(formatFront(busy).join('\n').includes('actionable RIGHT NOW'));
  const idle = computeFront({ A: {} }, { A: { status: 'pr-open', pr: 1, checks: checks(0, 2) } });
  assert.ok(formatFront(idle).join('\n').includes('watch is legal here'));
});

test('approved + green + out of draft is a human merge when auto-merge is off', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: false, review_decision: 'APPROVED', checks: checks() } });
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.strictEqual(f.fixpoint, true);
});

test('a checkpoint ticket out of draft waits on the human, not on the run', () => {
  const f = computeFront(
    { T: { human_checkpoint: true } },
    { T: { status: 'pr-open', pr: 7, draft: false, review_decision: null, checks: checks() } }
  );
  assert.deepStrictEqual(f.waiting.human, ['T']);
  assert.strictEqual(f.fixpoint, true);
});

test('a checkpoint ticket that has NOT been worked on is still executable', () => {
  // the failure mode: "there is a human gate" read as "do nothing at all"
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { status: 'pending', ready: true } });
  assert.deepStrictEqual(f.actionable.execute, ['T']);
  assert.strictEqual(f.fixpoint, false);
});

suite('front — auto-merge turns the merge tail into the sentinel\'s work');

const conform = { 'arch-review': 'conform', 'drift-check': 'fresh', checks: 'green' };
const landed = { status: 'pr-open', pr: 9, draft: false, checks: checks(), gate: conform, merge_scope: 'stacked', pr_base: 'epic/01-x' };

test('green + conform + stacked base is a merge the run performs itself', () => {
  const f = computeFront({ T: {} }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['T']);
  assert.strictEqual(f.fixpoint, false, 'an unmerged, mergeable PR is not a fixpoint');
  assert.ok(f.why.T.includes('squash into epic/01-x'));
});

test('the same PR without auto-merge stays a human action (unchanged behaviour)', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, review_decision: 'APPROVED' } });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.strictEqual(f.fixpoint, true);
});

test('a PR pointed at the integration branch is NEVER auto-merged', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, merge_scope: 'integration', pr_base: 'main' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.ok(f.why.T.includes('a human'));
});

test('no gate_status trailer means the conform gate is still owed, not a merge', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, gate: undefined } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
  assert.deepStrictEqual(f.actionable.merge, []);
});

test('CHANGES_REQUESTED blocks the auto-merge even with a conform trailer', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, review_decision: 'CHANGES_REQUESTED' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('a human_checkpoint ticket is never auto-merged, however green', () => {
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.human, ['T']);
});

suite('front — sentinel ownership');

test('fix/finalize/merge are the sentinel\'s duty, execute/publish are not', () => {
  const f = computeFront(
    { A: {}, B: {}, C: {}, D: {} },
    {
      A: { status: 'pending', ready: true },
      B: { status: 'pr-open', pr: 1, checks: checks(1, 0) },
      C: { ...landed, pr: 2 },
      D: { status: 'branched', ready: true, needs_pr: true },
    },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.sentinel.duty.sort(), ['B', 'C']);
  assert.strictEqual(f.sentinel.clear, false);
});

test('a PR waiting on CI keeps the guard posted even with nothing actionable', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 1, checks: checks(0, 2) } });
  assert.deepStrictEqual(f.sentinel.duty, []);
  assert.deepStrictEqual(f.sentinel.waiting_ci, ['T']);
  assert.strictEqual(f.sentinel.clear, false, 'the guard is not done while CI is running');
  assert.ok(formatFront(f).join('\n').includes('sentinel: 0 duty'));
});

test('an all-merged graph leaves no guard behind', () => {
  const f = computeFront({ T: {} }, { T: { status: 'merged' } });
  assert.strictEqual(f.sentinel.clear, true);
  assert.ok(formatFront(f).join('\n').includes('sentinel: clear'));
});

suite('front — parked');

test('blocked tickets are parked with their reason and do not prevent a fixpoint', () => {
  const f = computeFront(
    { T: {} },
    { T: { status: 'pending', ready: false, blocked_by: ['P'], blocked_reasons: { P: 'parent has no branch yet' } } }
  );
  assert.deepStrictEqual(f.parked.blocked, ['T']);
  assert.strictEqual(f.fixpoint, true);
  assert.ok(f.why.T.includes('parent has no branch yet'));
});

test('a run-parked PR leaves the front (otherwise babysit loops forever)', () => {
  const state = { T: { status: 'pr-open', pr: 7, checks: checks(1, 0) } };
  assert.strictEqual(computeFront({ T: {} }, state).actionable_count, 1);
  const f = computeFront({ T: {} }, state, { parked: ['T'] });
  assert.strictEqual(f.actionable_count, 0);
  assert.strictEqual(f.fixpoint, true);
  assert.ok(f.why.T.includes('parked by this run'));
});

test('merged tickets are done, and an all-merged graph is a fixpoint', () => {
  const f = computeFront({ T: {} }, { T: { status: 'merged', pr: 7 } });
  assert.deepStrictEqual(f.parked.done, ['T']);
  assert.strictEqual(f.fixpoint, true);
  assert.ok(formatFront(f).join('\n').includes('fixpoint: YES'));
});

test('counts cover every ticket exactly once', () => {
  const tickets = { A: {}, B: {}, C: {}, D: {} };
  const state = {
    A: { status: 'pending', ready: true },
    B: { status: 'pr-open', pr: 1, checks: checks(0, 1) },
    C: { status: 'merged' },
    D: { status: 'pending', ready: false, blocked_by: ['A'] },
  };
  const f = computeFront(tickets, state);
  const total = Object.values(f.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 4);
});

test('parents come before children, but a left-behind phase never comes first', () => {
  const tickets = {
    'T-02-01': { phase: '2' },                              // left behind: 14 has landed
    'T-14-02': { phase: '14' },                              // live root
    'T-14-07': { phase: '14', primary_parent: 'T-14-02' },   // live child
    'T-14-09': { phase: '14', primary_parent: 'T-14-07' },   // live grandchild
    'T-14-01': { phase: '14' },
  };
  const state = {
    'T-02-01': { status: 'pending', ready: true },
    'T-14-02': { status: 'pending', ready: true },
    'T-14-07': { status: 'pending', ready: true },
    'T-14-09': { status: 'pending', ready: true },
    'T-14-01': { status: 'merged' },
  };
  const f = computeFront(tickets, state, {});
  // Depth orders a stack; it says nothing across phases. Sorting by depth alone
  // put a phase-2 root (depth 0) ahead of every live phase-14 child — observed on
  // a real board right after the sort shipped, with two tickets judged stale six
  // days earlier sitting at the head of `execute`.
  assert.deepStrictEqual(
    f.actionable.execute,
    ['T-14-02', 'T-14-07', 'T-14-09', 'T-02-01'],
    'live stack top-down first, the left-behind phase last'
  );
  // Still listed: the fixpoint must not lie about work that exists.
  assert.ok(f.actionable.execute.includes('T-02-01'));
});

test('when only left-behind work remains, the verdict stops demanding motion', () => {
  const tickets = { 'T-02-01': { phase: '2' }, 'T-14-01': { phase: '14' } };
  const state = {
    'T-02-01': { status: 'pending', ready: true },
    'T-14-01': { status: 'merged' },
  };
  const out = formatFront(computeFront(tickets, state, {})).join('\n');
  // "Ending the run is a defect" is false when the only thing left has been
  // offered and declined every round for days: continuing means taking abandoned
  // work. Observed on a real board, where two such tickets held `fixpoint: NO`
  // by themselves.
  assert.ok(/ALL 1 actionable item/.test(out), out);
  assert.ok(/decision, not motion/.test(out), out);
  assert.ok(!/Ending the run here is a defect/.test(out), 'must not demand motion toward abandoned work');
});

test('live work still demands motion, even alongside left-behind tickets', () => {
  const tickets = { 'T-02-01': { phase: '2' }, 'T-14-02': { phase: '14' }, 'T-14-01': { phase: '14' } };
  const state = {
    'T-02-01': { status: 'pending', ready: true },
    'T-14-02': { status: 'pending', ready: true },
    'T-14-01': { status: 'merged' },
  };
  const out = formatFront(computeFront(tickets, state, {})).join('\n');
  assert.ok(/Ending the run here is a defect/.test(out), out);
});

test('a drift verdict parks the ticket, and expires when the plan is re-planned', () => {
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const script = path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'drift-record.cjs'
  );
  const { activeDrift } = require(script);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-drift-'));
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  // A real conveyor project always has this beside the store; drift-record now
  // refuses without it, because its absence is the signature of a judge writing
  // into its own worktree instead of the project.
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {} }));
  const plan = path.join(dir, 'PLAN.md');
  fs.writeFileSync(plan, '# plan v1\n');

  execFileSync('node', [script, 'mark', 'T-01-01', plan, 'landed under other names'], { cwd: dir });
  const first = activeDrift(dir);
  assert.strictEqual(first['T-01-01'], 'landed under other names');

  // A ready ticket that would otherwise be executable must be parked instead.
  const tickets = { 'T-01-01': { phase: '1' } };
  const state = { 'T-01-01': { status: 'pending', ready: true } };
  const parkedFront = computeFront(tickets, state, { drifted: first });
  assert.strictEqual(parkedFront.actionable.execute.length, 0, 'a drifted ticket must not be executable');
  assert.ok(parkedFront.parked.blocked.includes('T-01-01'));
  assert.ok(/re-plan/i.test(parkedFront.why['T-01-01']), parkedFront.why['T-01-01']);

  // …and re-planning the ticket must lift the park without anyone remembering
  // to clear it. A verdict that outlived its plan would be the worse failure:
  // the run would insist on staleness that had already been fixed.
  fs.writeFileSync(plan, '# plan v2 — re-planned against what shipped\n');
  assert.deepStrictEqual(activeDrift(dir), {}, 'the verdict must expire when the plan changes');
  const freshFront = computeFront(tickets, state, { drifted: activeDrift(dir) });
  assert.deepStrictEqual(freshFront.actionable.execute, ['T-01-01']);
});

test('every actionable bucket names roles the model ladder actually knows', () => {
  const { ROLES } = require(path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs'
  ));
  const { roles } = computeFront({}, {});
  assert.ok(roles && typeof roles === 'object', 'the front must publish its bucket → role mapping');

  // The buckets and the ladder are two vocabularies for the same work
  // (`execute` vs `executor`, `merge` vs `pr-sentinel`). A run that reads the
  // board and logs the BUCKET name gets a role the ladder declines to route —
  // observed in the field as attempts logged under `finalize` and `merge`. The
  // mapping is what makes that unnecessary, so it has to stay true.
  for (const [bucket, list] of Object.entries(roles)) {
    assert.ok(Array.isArray(list), `roles.${bucket} must be an array`);
    for (const r of list) {
      assert.ok(ROLES.includes(r), `roles.${bucket} names "${r}", which is not a pipeline role`);
    }
  }

  // Every bucket the front can put work in must be covered — a new bucket with
  // no entry is exactly how the gap reappears.
  const { actionable } = computeFront({}, {});
  for (const bucket of Object.keys(actionable)) {
    assert.ok(bucket in roles, `bucket "${bucket}" has no entry in the role mapping`);
  }
});

suite('front — a child never lands into an open human_checkpoint parent');

// Field-reported by the runs themselves: three of five escalations in phase 19
// existed only to hold this merge by hand, each citing the sentinel's base check
// by line number. Squashing into a checkpoint parent rewrites the diff a person
// is reading, and the post-merge retarget then sends that child's own children to
// the epic — content actually sitting in a checkpoint branch.
const cpTickets = { P: { human_checkpoint: true, branch: 'ticket/P' }, C: { primary_parent: 'P', branch: 'ticket/C' } };
const cpState = (parentStatus) => ({
  P: { status: parentStatus, pr: 1, draft: false, checks: checks(), branch: 'ticket/P' },
  C: {
    status: 'pr-open', pr: 2, draft: false, checks: checks(), gate: conform,
    merge_scope: 'stacked', pr_base: 'ticket/P', branch: 'ticket/C',
  },
});

test('while the parent PR is open the child waits on the human, not on the run', () => {
  const f = computeFront(cpTickets, cpState('pr-open'), { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, [], 'the front must not offer what the guard refuses');
  assert.ok(f.waiting.human.includes('C'), 'nobody owes work — a person holds the key');
  assert.ok(!f.parked.blocked.includes('C'), 'and it is not parked: no decision is pending on our side');
  assert.ok(/human_checkpoint/.test(f.why.C), f.why.C);
  assert.ok(/\bP\b/.test(f.why.C), 'the reason names WHICH parent');
});

test('once the parent lands, the same child is a merge again', () => {
  const f = computeFront(cpTickets, cpState('merged'), { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['C'], 'the hold is scoped to an OPEN parent');
});

test('a non-checkpoint parent does not hold the child', () => {
  const t = { P: { branch: 'ticket/P' }, C: { primary_parent: 'P', branch: 'ticket/C' } };
  const f = computeFront(t, cpState('pr-open'), { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['C'], 'only a CHECKPOINT parent holds it');
});

suite('front — the standalone CLI is equivalent to state-sync');

// deliver.md advertises `front.cjs` as "re-runnable on its own", and it silently
// was not: state-sync passed the durable parks in and the CLI did not, so the same
// graph produced two different verdicts depending on which command you ran. A
// ticket recorded as drifted read back as actionable — the exact re-offering
// drift-record was written to stop.
test('the CLI honours a recorded drift verdict', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-frontcli-'));
  const graph = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  const plan = path.join(dir, 'T-01-01-PLAN.md');
  fs.writeFileSync(plan, '# a plan that shipped under other names\n');
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-01-01': {} } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'),
    JSON.stringify({ 'T-01-01': { status: 'pending', ready: true, branch: 'ticket/T-01-01-x' } }));

  const cli = (args = []) => spawnSync('node', [path.join(SCRIPTS, 'front.cjs'), ...args], { cwd: dir, encoding: 'utf8' });

  const before = JSON.parse(cli(['--json']).stdout);
  assert.deepEqual(before.actionable.execute, ['T-01-01'], 'executable before the verdict');

  const mark = spawnSync('node',
    [path.join(SCRIPTS, 'drift-record.cjs'), 'mark', 'T-01-01', plan, 'landed', 'as', 'PR', '#410'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(mark.status, 0, `drift mark must succeed (${mark.stderr})`);

  const after = JSON.parse(cli(['--json']).stdout);
  assert.equal(after.actionable_count, 0, 'the CLI must see the same verdict state-sync sees');
  assert.ok(after.parked.blocked.includes('T-01-01'));

  // ...and the same for an escalation, the other durable park.
  const state = { 'T-01-01': { status: 'pr-open', pr: 5, draft: false, checks: { total: 1, failing: 0, pending: 0 } } };
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  fs.rmSync(path.join(graph, 'drift.json'));
  assert.equal(JSON.parse(cli(['--json']).stdout).actionable_count, 1, 'actionable again once drift is gone');

  const esc = spawnSync('node',
    [path.join(SCRIPTS, 'escalation-record.cjs'), 'mark', 'T-01-01', 'the', 'reviewer', 'must', 'decide'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(esc.status, 0, `escalation mark must succeed (${esc.stderr})`);
  const parked = JSON.parse(cli(['--json']).stdout);
  assert.equal(parked.actionable_count, 0, 'the CLI honours the escalation too');
  assert.ok(/the reviewer must decide/.test(parked.why['T-01-01']), 'and reports its reason');
});

suite('front — D4: the actionable order is by unblocking power');

// Unattended, the ORDER decides how much of the graph is still open by morning:
// the head of the list is what a 04:00 round takes, so it has to be the ticket
// that keeps the most work available afterwards.

// A dependent that cannot run yet is exactly the work an unblocking ticket
// frees, so these are parked in `state` but still counted as descendants.
const held = (dep) => ({ status: 'pending', ready: false, blocked_by: [dep] });

test('a root with more unmerged dependents sorts first, beating id order', () => {
  const tickets = {
    'A-root': { phase: '1' },
    'A-kid': { phase: '1', depends_on: ['A-root'] },
    'Z-root': { phase: '1' },
    'Z-k1': { phase: '1', depends_on: ['Z-root'] },
    'Z-k2': { phase: '1', depends_on: ['Z-root'] },
    'Z-k3': { phase: '1', depends_on: ['Z-k1'] },
    'Z-k4': { phase: '1', depends_on: ['Z-k2'] },
    'Z-k5': { phase: '1', depends_on: ['Z-k3'] },
  };
  const state = {
    'A-root': { status: 'pending', ready: true },
    'A-kid': held('A-root'),
    'Z-root': { status: 'pending', ready: true },
    'Z-k1': held('Z-root'), 'Z-k2': held('Z-root'),
    'Z-k3': held('Z-k1'), 'Z-k4': held('Z-k2'), 'Z-k5': held('Z-k3'),
  };
  const f = computeFront(tickets, state, {});
  assert.deepStrictEqual(
    f.actionable.execute, ['Z-root', 'A-root'],
    '5 unmerged dependents outrank 1, whatever the ids say'
  );
});

test('a diamond counts the shared descendant once', () => {
  // The hazard validate-graph.cjs already paid for, mirrored: there a visited
  // set SHARED across recursions cached truncated ancestor closures and rejected
  // valid diamond graphs. Here the symptom would be inflation instead — in
  // A←B, A←C, B←D, C←D, reaching D via both B and C must still count it once.
  const tickets = {
    'Z-dia': { phase: '1' },
    'Z-b': { phase: '1', depends_on: ['Z-dia'] },
    'Z-c': { phase: '1', depends_on: ['Z-dia'] },
    'Z-d': { phase: '1', depends_on: ['Z-b', 'Z-c'] },
    'A-chain': { phase: '1' },
    'A-1': { phase: '1', depends_on: ['A-chain'] },
    'A-2': { phase: '1', depends_on: ['A-1'] },
    'A-3': { phase: '1', depends_on: ['A-2'] },
  };
  const state = {
    'Z-dia': { status: 'pending', ready: true },
    'Z-b': held('Z-dia'), 'Z-c': held('Z-dia'), 'Z-d': held('Z-b'),
    'A-chain': { status: 'pending', ready: true },
    'A-1': held('A-chain'), 'A-2': held('A-1'), 'A-3': held('A-2'),
  };
  const f = computeFront(tickets, state, {});
  // descendants(Z-dia) is 3, which TIES the plain 3-chain and falls through to
  // the id. Double-counting D would make it 4 and put the diamond first.
  assert.deepStrictEqual(
    f.actionable.execute, ['A-chain', 'Z-dia'],
    'the shared descendant must be counted once, not once per path'
  );
});

test('a merged dependent needs no unblocking and is not counted', () => {
  const tickets = {
    'Z-most': { phase: '1' },
    'Z-m1': { phase: '1', depends_on: ['Z-most'] },
    'Z-m2': { phase: '1', depends_on: ['Z-most'] },
    'Z-live': { phase: '1', depends_on: ['Z-most'] },
    'A-two': { phase: '1' },
    'A-1': { phase: '1', depends_on: ['A-two'] },
    'A-2': { phase: '1', depends_on: ['A-1'] },
  };
  const state = {
    'Z-most': { status: 'pending', ready: true },
    'Z-m1': { status: 'merged' }, 'Z-m2': { status: 'merged' },
    'Z-live': held('Z-most'),
    'A-two': { status: 'pending', ready: true },
    'A-1': held('A-two'), 'A-2': held('A-1'),
  };
  const f = computeFront(tickets, state, {});
  // Z-most has three dependents on paper but only one still needs unblocking.
  assert.deepStrictEqual(
    f.actionable.execute, ['A-two', 'Z-most'],
    'counting merged dependents would promote a ticket that frees nothing'
  );
});

test('a parent still sorts before its own stacked child', () => {
  const tickets = {
    'Z-parent': { phase: '1' },
    'A-child': { phase: '1', depends_on: ['Z-parent'], primary_parent: 'Z-parent' },
  };
  const state = {
    'Z-parent': { status: 'pending', ready: true },
    'A-child': { status: 'pending', ready: true },
  };
  const f = computeFront(tickets, state, {});
  // The parent's descendant set strictly contains its unmerged child's, so
  // "drive the parents first" survives the new leading key by construction.
  assert.deepStrictEqual(f.actionable.execute, ['Z-parent', 'A-child']);
});

test('left-behind still sorts last, however much it would unblock', () => {
  const tickets = {
    'T-02-01': { phase: '2' },
    'T-02-02': { phase: '2', depends_on: ['T-02-01'] },
    'T-02-03': { phase: '2', depends_on: ['T-02-01'] },
    'T-02-04': { phase: '2', depends_on: ['T-02-01'] },
    'T-14-02': { phase: '14' },
    'T-14-01': { phase: '14' },
  };
  const state = {
    'T-02-01': { status: 'pending', ready: true },
    'T-02-02': held('T-02-01'), 'T-02-03': held('T-02-01'), 'T-02-04': held('T-02-01'),
    'T-14-02': { status: 'pending', ready: true },
    'T-14-01': { status: 'merged' },
  };
  const f = computeFront(tickets, state, {});
  assert.deepStrictEqual(
    f.actionable.execute, ['T-14-02', 'T-02-01'],
    'unblocking power must never promote a phase the run has already moved past'
  );
  assert.strictEqual(f.left_behind_count, 1, 'and the count is unchanged');
});

test('with descendants and depth tied, the slower repo starts first', () => {
  const tickets = {
    'Z-slow': { phase: '1', repo: 'o/slow' },
    'A-fast': { phase: '1', repo: 'o/fast' },
  };
  const state = {
    'Z-slow': { status: 'pending', ready: true },
    'A-fast': { status: 'pending', ready: true },
  };
  const f = computeFront(tickets, state, { ci_estimates: { 'Z-slow': 300, 'A-fast': 100 } });
  assert.deepStrictEqual(
    f.actionable.execute, ['Z-slow', 'A-fast'],
    'starting the slowest pipeline earliest overlaps its wait with the rest of the front'
  );
  const none = computeFront(tickets, state, {});
  assert.deepStrictEqual(
    none.actionable.execute, ['A-fast', 'Z-slow'],
    'with no journal data the term falls through to the id, and nothing throws'
  );
});

test('sentinel.duty inherits the bucket order, not the state key order', () => {
  const tickets = {
    'A-few': { phase: '1' },
    'Z-many': { phase: '1' },
    'Z-k1': { phase: '1', depends_on: ['Z-many'] },
    'Z-k2': { phase: '1', depends_on: ['Z-many'] },
  };
  const state = {
    'A-few': { status: 'pr-open', pr: 1, draft: true, checks: checks() },
    'Z-many': { status: 'pr-open', pr: 2, draft: true, checks: checks() },
    'Z-k1': held('Z-many'), 'Z-k2': held('Z-many'),
  };
  const f = computeFront(tickets, state, {});
  assert.deepStrictEqual(f.actionable.finalize, ['Z-many', 'A-few']);
  assert.deepStrictEqual(
    f.sentinel.duty, ['Z-many', 'A-few'],
    'the board must not print one order in the buckets and another in the duty line'
  );
});

test('computeFront stays a pure function over its inputs — no filesystem access', () => {
  // The estimate is derived by `ciEstimates` and PASSED IN. Reading the journal
  // from inside computeFront would make the pure classifier depend on a cwd,
  // which is the defect graph-dir.cjs exists to talk about.
  const src = computeFront.toString();
  assert.ok(!/require\(\s*['"](fs|path)['"]\s*\)/.test(src), 'computeFront must not require fs/path');
  assert.ok(
    !/\b(readFileSync|existsSync|readdirSync|writeFileSync|appendFileSync)\b/.test(src),
    'computeFront must not touch the filesystem'
  );
});

suite('front — ciEstimates: a per-repo PR-lifetime proxy from the journal');

const tmpGraph = (prefix) => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const graph = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  return { dir, graph };
};

const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const evAt = (ticket, to, secs) =>
  JSON.stringify({ ts: new Date(T0 + secs * 1000).toISOString(), event: 'status_change', ticket, from: null, to, pr: 1 });

test('the estimate is the per-repo median of merged PR lifetimes', () => {
  const fs = require('fs');
  const { graph } = tmpGraph('shipyard-ciest-');
  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), [
    // this repo (no `repo` field): lifetimes 100, 300, 200 → median 200
    evAt('H-1', 'pr-open', 0), evAt('H-1', 'merged', 100),
    evAt('H-2', 'pr-open', 0), evAt('H-2', 'merged', 300),
    evAt('H-3', 'pr-open', 0), evAt('H-3', 'merged', 200),
    // a sibling repo, even sample count: 100, 200 → median 150
    evAt('S-1', 'pr-open', 0), evAt('S-1', 'merged', 100),
    evAt('S-2', 'pr-open', 0), evAt('S-2', 'merged', 200),
    // opened but never merged: no lifetime to measure, contributes nothing
    evAt('N-1', 'pr-open', 0),
    '',
  ].join('\n'));
  const tickets = {
    'H-1': {}, 'H-2': {}, 'H-3': {},
    'S-1': { repo: 'o/side' }, 'S-2': { repo: 'o/side' },
    'N-1': {},
    'H-next': {},
    'S-next': { repo: 'o/side' },
    'X-next': { repo: 'o/never-seen' },
  };
  const est = ciEstimates(graph, tickets);
  assert.strictEqual(est['H-next'], 200, 'odd sample count → the middle value');
  assert.strictEqual(est['S-next'], 150, 'even sample count → the mean of the middle pair');
  assert.strictEqual(est['X-next'], 0, 'a repo with no merged sample estimates nothing');
  // Grouping is by REPO: a phase spanning two repos has two unrelated pipelines,
  // and a median from one says nothing about the other.
  assert.strictEqual(est['N-1'], 200, "an unmerged ticket still gets its own repo's median");
});

test('a missing journal estimates 0 for everyone and never throws', () => {
  const { graph } = tmpGraph('shipyard-ciest-none-');
  assert.deepStrictEqual(ciEstimates(graph, { A: {}, B: { repo: 'o/x' } }), { A: 0, B: 0 });
});

test('a torn journal line costs one sample, not the estimate', () => {
  const fs = require('fs');
  const { graph } = tmpGraph('shipyard-ciest-torn-');
  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), [
    evAt('H-1', 'pr-open', 0), evAt('H-1', 'merged', 100),
    '{"ts":"2026-08-01T00:00:00.000Z","event":"status_ch',  // a half-written append
    evAt('H-2', 'pr-open', 0), evAt('H-2', 'merged', 300),
    '',
  ].join('\n'));
  // state-sync appends under a lock this read does not take, so a torn tail is
  // reachable; it must cost a sample rather than the whole front.
  assert.strictEqual(ciEstimates(graph, { 'H-1': {}, 'H-2': {}, 'H-3': {} })['H-3'], 200);
});

test("a merged ticket the CURRENT graph does not know does not pollute another repo's median", () => {
  // Invariant: `repoKey` defaults an unknown ticket to the SAME '' bucket a
  // real local ticket uses, so a stale/pruned/foreign journal entry for a
  // ticket id absent from `tickets` must be excluded for lack of a known
  // repo, not silently folded into the local repo's median.
  const fs = require('fs');
  const { graph } = tmpGraph('shipyard-ciest-unknown-');
  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), [
    // the local repo's one legitimate sample: lifetime 100
    evAt('H-1', 'pr-open', 0), evAt('H-1', 'merged', 100),
    // a ticket the journal remembers but the current graph does not — a much
    // longer lifetime that must not be attributed to the local repo just
    // because its repo identity is unknown.
    evAt('GONE-1', 'pr-open', 0), evAt('GONE-1', 'merged', 10000),
    '',
  ].join('\n'));
  const est = ciEstimates(graph, { 'H-1': {}, 'H-next': {} });
  assert.strictEqual(est['H-next'], 100, "the unknown ticket's sample must be excluded, not merged in");
});

suite('front — the CLI and state-sync order the same graph the same way');

test('the CLI derives ci_estimates from the journal, exactly as state-sync does', () => {
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
  const { dir, graph } = tmpGraph('shipyard-frontci-');

  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), [
    evAt('T-01-90', 'pr-open', 0), evAt('T-01-90', 'merged', 3000),
    evAt('T-01-91', 'pr-open', 0), evAt('T-01-91', 'merged', 100),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({
    tickets: {
      'T-01-90': { phase: '1', repo: 'o/slow' },
      'T-01-91': { phase: '1', repo: 'o/fast' },
      'Z-slow': { phase: '1', repo: 'o/slow' },
      'A-fast': { phase: '1', repo: 'o/fast' },
    },
  }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({
    'T-01-90': { status: 'merged' },
    'T-01-91': { status: 'merged' },
    'Z-slow': { status: 'pending', ready: true },
    'A-fast': { status: 'pending', ready: true },
  }));

  const out = spawnSync('node', [path.join(SCRIPTS, 'front.cjs'), '--json'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  // Nothing here is distinguishable except the journal: same phase, no
  // dependencies, no stack. An id-only order would read ['A-fast', 'Z-slow'].
  assert.deepStrictEqual(
    JSON.parse(out.stdout).actionable.execute, ['Z-slow', 'A-fast'],
    'the CLI must order by the journal-derived estimate, not by the id'
  );
});

test('state-sync passes ci_estimates too — one graph, one ordering', () => {
  const fs = require('fs');
  // The CLI half is covered behaviourally above; state-sync itself needs live
  // `gh`, so its half of the same defect is asserted on the source. The defect
  // this guards is recorded in front.cjs's own CLI comment: state-sync passed
  // options the CLI did not, and the same graph produced two different answers
  // depending on which command you ran.
  const src = fs.readFileSync(path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs'
  ), 'utf8');
  assert.ok(/\bciEstimates\b/.test(src), 'state-sync must import ciEstimates from front.cjs');
  assert.ok(
    /ci_estimates:\s*ciEstimates\(/.test(src),
    'state-sync must pass ci_estimates into computeFront, or it and the CLI disagree'
  );
});

suite('front — a park is described by the store that owns it');

// The board is the last thing a human reads before acting at 3am, so a lifting
// rule stated there has to be the rule the store actually applies. It was not:
// the store printed "Moving the PR does NOT lift it" for a plan defect while
// this renderer told the same human the park lifts once the PR moves. The
// wording is now produced once, beside the branch that decides expiry, and the
// renderer's only remaining job is placement.

const ESC_REASON = 'the reviewer must decide whether the endpoint may change';
const DEFECT_REASON = 'the plan assumes a sync endpoint; the API streams';
// The record `activeParks` hands back for a plan defect — the shape front.cjs's
// own CLI passes in, so this fixture is wired the way production is. The kind
// travels as a FIELD; the flat `{ticket: reason}` view keeps it only as a text
// prefix, which is why a renderer must not be fed that view.
const DEFECT_PARK = { kind: 'plan_defect', reason: DEFECT_REASON };
// What the flat view renders for the same record. Used below only to prove that
// a reason which merely LOOKS like it is not treated as one.
const DEFECT_FLAT = `plan_defect — re-decompose: ${DEFECT_REASON}`;
const escState = { T: { status: 'pr-open', pr: 7, draft: true, checks: checks() } };

test('a plan_defect park names re-planning and never claims a PR move lifts it', () => {
  const f = computeFront({ T: {} }, escState, { escalated: { T: DEFECT_PARK } });
  const why = f.why.T;
  assert.ok(f.parked.blocked.includes('T'), 'parked, whatever the wording');
  assert.ok(/plan/i.test(why), `the sentence must send the human to the plan: ${why}`);
  assert.ok(/re-plan|re-decompose/i.test(why), `and name the act that lifts it: ${why}`);
  // Content, not a literal: a rewrite that reintroduces the falsehood must fail
  // here even if every other word changed.
  assert.ok(!/PR moves/.test(why), `the board must not promise what the store refuses: ${why}`);
  assert.ok(why.includes(DEFECT_REASON), 'the recorded reason still travels verbatim');
  assert.ok(/escalation-record\.cjs clear T/.test(why), 'clear is the remedy for every kind');
});

test('an ordinary escalation renders exactly as it did before', () => {
  const f = computeFront({ T: {} }, escState, { escalated: { T: { kind: 'escalation', reason: ESC_REASON } } });
  assert.strictEqual(
    f.why.T,
    `escalated — ${ESC_REASON}. It lifts by itself once the PR moves (a push, a review answer, undrafting); \`escalation-record.cjs clear T\` to take it back.`,
    'the kind that was already right must not move a byte'
  );
});

test('a record with no kind reads as an ordinary escalation', () => {
  // Every record written before kinds existed has no kind, and the reason it
  // carries is free text — a park whose reason merely mentions a plan must not
  // be re-described with the plan_defect rule.
  const f = computeFront({ T: {} }, escState, { escalated: { T: 'the plan owner is on leave' } });
  assert.ok(/PR moves/.test(f.why.T), `the pre-kind rule is unchanged for it: ${f.why.T}`);
  // The bare string IS the legacy shape — the flat `activeEscalations` view, which
  // has already discarded the kind — so it must render the same sentence as the
  // record that spells the kind out.
  const rec = computeFront({ T: {} }, escState, {
    escalated: { T: { kind: 'escalation', reason: 'the plan owner is on leave' } },
  });
  assert.strictEqual(f.why.T, rec.why.T, 'one sentence for one kind, whichever shape carried it');
});

test('an ordinary escalation whose reason LOOKS like a plan defect is still an escalation', () => {
  // The reason is free text a human types. While the kind was recovered from the
  // reason's PREFIX, a human pasting a board line back into `mark` was told that
  // re-planning lifts a park that a PR move actually lifts — the same falsehood
  // this suite exists to delete, one indirection down. Copilot, PR #8.
  const f = computeFront({ T: {} }, escState, {
    escalated: { T: { kind: 'escalation', reason: DEFECT_FLAT } },
  });
  // Byte-exact, because "contains re-plan" cannot distinguish the LIFTING
  // sentence from the reason quoting one: the reason itself says re-decompose.
  assert.strictEqual(
    f.why.T,
    `escalated — ${DEFECT_FLAT}. It lifts by itself once the PR moves (a push, a review answer, undrafting); \`escalation-record.cjs clear T\` to take it back.`,
    'the kind is the record\'s field, never the reason\'s opening words'
  );
});


suite('front — a checkpoint a person already answered is the run\'s to land');

// ADR-001 D6. `delivery.preauthorized` records that the judgement a
// `human_checkpoint` asks for was supplied by a person while the ticket set was
// approved. The two flags stay distinct: human_checkpoint says a human must
// act, preauthorized says the human already did.

test('needsHuman is exported, and only an unquoted true lifts the checkpoint', () => {
  assert.strictEqual(needsHuman({}), false, 'no checkpoint, nobody owed');
  assert.strictEqual(needsHuman({ human_checkpoint: true }), true);
  assert.strictEqual(needsHuman({ human_checkpoint: true, preauthorized: true }), false);
  assert.strictEqual(needsHuman(undefined), false, 'an unknown ticket declares no stop');
  // The polarity is deliberately ASYMMETRIC. A checkpoint is recognised on a
  // truthy value, so a hand-edited `"true"` still stops the run; only a real
  // boolean lifts it. Gate 2 refuses everything else at plan time — if one ever
  // reaches here it must fail towards the human, never away from them.
  assert.strictEqual(needsHuman({ human_checkpoint: 'true' }), true);
  assert.strictEqual(needsHuman({ human_checkpoint: true, preauthorized: 'true' }), true);
  assert.strictEqual(needsHuman({ human_checkpoint: true, preauthorized: 1 }), true);
  assert.strictEqual(needsHuman({ human_checkpoint: true, preauthorized: 'yes' }), true);
  // Pre-authorization without a declared checkpoint authorizes nothing:
  // validate-graph rejects the pair, and the board must not invent a meaning.
  assert.strictEqual(needsHuman({ preauthorized: true }), false);
});

test('a pre-authorized checkpoint, green + conform + stacked, is an actionable merge', () => {
  const f = computeFront(
    { T: { human_checkpoint: true, preauthorized: true } },
    { T: { ...landed } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.actionable.merge, ['T']);
  // The behaviour this REPLACES, pinned as absent: it used to sit in
  // waiting.human however green it was.
  assert.deepStrictEqual(f.waiting.human, []);
  assert.strictEqual(f.fixpoint, false, 'a mergeable PR is not a fixpoint');
});

test('the same ticket WITHOUT the record still waits on a person (the control)', () => {
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.human, ['T'], 'under waiting — never parked');
  assert.deepStrictEqual(f.parked.blocked, []);
});

test('pre-authorization is not a bypass: no conform trailer is still finalize work', () => {
  const f = computeFront(
    { T: { human_checkpoint: true, preauthorized: true } },
    { T: { ...landed, gate: undefined } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T'], 'the architecture verdict is still owed');
});

test('pre-authorization never reaches the integration branch on the board either', () => {
  // The epic → integration PR is never the run's, whatever the config says —
  // and a pre-authorized ticket set must not make it one. `sentinel.cjs merge`
  // refuses the same case; the board must not offer what the guard refuses.
  const f = computeFront(
    { T: { human_checkpoint: true, preauthorized: true } },
    { T: { ...landed, merge_scope: 'integration', pr_base: 'main' } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.ok(/a human/.test(f.why.T), f.why.T);
});

test('a pre-authorized checkpoint that has NOT been worked on is still executable', () => {
  // The oldest failure mode in this file: "there is a human gate" read as "do
  // nothing at all". Lifting the gate must not change the other direction.
  const f = computeFront(
    { T: { human_checkpoint: true, preauthorized: true } },
    { T: { status: 'pending', ready: true } }
  );
  assert.deepStrictEqual(f.actionable.execute, ['T']);
});

suite('front — a child never lands into an OPEN checkpoint parent, authorized or not');

// The reasoning splits, the outcome does not. An un-authorized parent is a diff
// a person is actively reading, and squashing into it rewrites what they are
// reading. A pre-authorized parent has no reader — but it is still the ticket
// the checkpoint names, and landing a child into it first changes what lands
// under that authorization. So the child waits for the parent to MERGE, which
// the guard will do by itself; it is not waiting for a person to decide.

const paTickets = {
  P: { human_checkpoint: true, preauthorized: true, branch: 'ticket/P' },
  C: { primary_parent: 'P', branch: 'ticket/C' },
};

test('while a PRE-AUTHORIZED parent PR is open, its child is not offered for merge', () => {
  const f = computeFront(paTickets, cpState('pr-open'), { autoMerge: true });
  assert.ok(!f.actionable.merge.includes('C'), 'the child is not offered until the parent has landed');
  // The parent in this fixture carries no conform trailer, so pre-authorization
  // hands it to the RUN as finalize work — not a merge, and above all not to a
  // person. That reassignment is the whole shift this ticket makes.
  assert.deepStrictEqual(f.actionable.finalize, ['P'], f.why.P);
  assert.deepStrictEqual(f.waiting.human, ['C'], 'only the child is held; the parent waits on nobody');
  assert.ok(!f.parked.blocked.includes('C'));
  assert.ok(/\bP\b/.test(f.why.C), `the reason names WHICH parent: ${f.why.C}`);
  assert.ok(/pre-authorized/.test(f.why.C), `and says the hold is about order, not a person: ${f.why.C}`);
});

test('once that pre-authorized parent lands, the same child is a merge (the control)', () => {
  const f = computeFront(paTickets, cpState('merged'), { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['C'], 'the hold is scoped to an OPEN parent');
});

test('an UN-authorized parent holds its child in exactly today\'s words', () => {
  const f = computeFront(cpTickets, cpState('pr-open'), { autoMerge: true });
  assert.ok(f.waiting.human.includes('C'));
  assert.ok(/human_checkpoint/.test(f.why.C), f.why.C);
  assert.ok(!/pre-authorized/.test(f.why.C), `an un-authorized hold must not claim one: ${f.why.C}`);
});

test('checkpointParentOf is the shared rule, and it answers over the caller\'s graph', () => {
  // One home, two callers: sentinel.cjs imports this same function rather than
  // keeping the copy that used to live at sentinel.cjs:233. A predicate that
  // reads its graph from arguments is what makes that possible.
  assert.strictEqual(checkpointParentOf('C', paTickets, cpState('pr-open')), 'P');
  assert.strictEqual(checkpointParentOf('C', paTickets, cpState('merged')), null, 'scoped to an OPEN parent');
  assert.strictEqual(checkpointParentOf('P', paTickets, cpState('pr-open')), null, 'a root has no parent');
  assert.strictEqual(
    checkpointParentOf('C', { P: { branch: 'ticket/P' }, C: { primary_parent: 'P' } }, cpState('pr-open')),
    null,
    'only a CHECKPOINT parent holds a child'
  );
});

done();
