'use strict';

// The actionable front IS the run's stop condition, so its edge cases are the
// ones that cost whole sessions: a PR waiting on CI must not read as a fixpoint,
// and it must not read as "block here" either.

const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const { computeFront, formatFront, ciEstimates, needsHuman, checkpointParentOf, epicKey } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
));

const checks = (failing = 0, pending = 0, total = 3) => ({ total, failing, pending, none_reported: total === 0 });

// ── the epic records state-sync.cjs publishes ───────────────────────────────
//
// Built in ITS shape (`epicInfo[epicKey(phase, repo)]`) and filed under ITS key,
// which is imported rather than spelled again: a fixture that invents a key of
// its own proves only that the test agrees with itself.
//
// The DEFAULT is the trap this ticket exists for — an epic that exists and is 0
// commits ahead of its base, which state-sync calls `landed: true` because
// nothing of the phase is outside the base. That is equally true of an epic
// whose whole diff went in and of one freshly cut with nothing in it yet, so it
// is a readiness fact and never, on its own, evidence that a phase shipped.
const epicRecord = (phase, over = {}) => ({
  phase: String(phase),
  repo: null,
  branch: `epic/${phase}-x`,
  base: 'main',
  exists: true,
  ahead: 0,
  pr: null,
  landed: true,
  landed_reason: `epic epic/${phase}-x is 0 commits ahead of main — its whole diff is in`,
  ...over,
});
// A phase that DID land: its integration PR is merged. This is the positive
// evidence, and the only difference from the record above.
const landedEpic = (phase, over = {}) =>
  epicRecord(phase, { pr: { number: 900 + Number(phase), state: 'MERGED' }, ...over });
// A phase still being delivered: its epic is ahead of the base with an open
// integration PR.
const openEpic = (phase, over = {}) => epicRecord(phase, {
  ahead: 7,
  landed: false,
  pr: { number: 800 + Number(phase), state: 'OPEN' },
  landed_reason: `epic epic/${phase}-x is 7 commit(s) ahead of main`,
  ...over,
});
const epicsOf = (...records) => Object.fromEntries(records.map((r) => [epicKey(r.phase, r.repo), r]));

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
  // …and when it IS the only thing left, the sanctioned move is `ci-wait.cjs` —
  // a foreground wait that returns on the first PR to settle. `gh pr checks
  // --watch` is never named again: it blocks the session with no budget, no
  // record and no way for the loop to read what happened.
  const out = formatFront(idle).join('\n');
  assert.ok(/ci-wait\.cjs/.test(out), out);
  assert.ok(!/watch is legal/.test(out), 'the old wording sanctioned the very thing this repo removed');
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

suite('front — a conform verdict is bound to the head it judged');

// The trailer records WHICH diff arch-review judged. Landing a PR whose head has
// moved since is landing a diff nobody reviewed: the observed sequence is
// verdict → undraft → a bot review lands on the undrafted PR → review-fix pushes
// → CI goes green again → the stale trailer still reads `conform`. The board must
// owe the verdict again, not offer the merge.

const conformAt = (head) => ({ ...conform, head });

test('a trailer whose head is not the PR head owes arch-review again', () => {
  const f = computeFront(
    { T: {} },
    { T: { ...landed, gate: conformAt('abc123'), head_sha: 'def456' } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.actionable.merge, [], 'a verdict for another diff must not be a merge');
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
  // The reason has to name both SHAs, or the remedy ("re-judge this head") is a
  // guess: a bare "no conform trailer" is false — there IS one, for other code.
  assert.ok(/abc123/.test(f.why.T) && /def456/.test(f.why.T), f.why.T);
  assert.ok(/arch-review/.test(f.why.T), f.why.T);
});

test('the same head is conform — the ordinary path is unchanged', () => {
  const f = computeFront(
    { T: {} },
    { T: { ...landed, gate: conformAt('abc123'), head_sha: 'abc123' } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.actionable.merge, ['T']);
});

test('a stale trailer is absent for the merge_human branch too, not just for merge', () => {
  // The `merge_scope !== 'stacked'` branch reads the same gate. A stale verdict
  // leaking through here would tell a human "green + conform" about a diff the
  // architecture verdict never covered.
  const f = computeFront(
    { T: {} },
    { T: { ...landed, merge_scope: 'integration', pr_base: 'main', gate: conformAt('abc123'), head_sha: 'def456' } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.waiting.merge_human, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('a pre-head-binding trailer on a pre-head-binding board is still conform', () => {
  // Backwards compatibility, and only in this direction: with no head on either
  // side there is nothing to compare, so the verdict of the previous release
  // stands. This is the case that must not regress a board mid-upgrade.
  const f = computeFront({ T: {} }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['T']);
});

test('but a headless trailer on a board that KNOWS the head is absent', () => {
  // Fail-closed: the board carries a head, the trailer does not, so nothing can
  // say which diff was judged. It bites only a PR verdicted before the upgrade
  // and not merged before it — one re-review, never a silent merge.
  const f = computeFront({ T: {} }, { T: { ...landed, head_sha: 'def456' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
  assert.ok(/predates head binding/.test(f.why.T), f.why.T);
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

// An UNKNOWN integration state is a blocker like any other here, and that is the
// point: `state-sync.cjs` used to map a failed `gh api compare` onto zero commits
// ahead, so the child of a merged cross-phase parent arrived with `ready: true`
// and this function correctly filed it under `execute` — a base missing its own
// declared dependency, handed to an executor. The board's job is to carry the
// verdict, so the fix is upstream; this pins that the front does carry it, with
// the reason a person needs, rather than needing a bucket of its own.
test('a cross-phase child whose integration state was never observed is parked, not executable', () => {
  const f = computeFront(
    { C: { depends_on: ['P'] } },
    {
      P: { status: 'merged' },
      C: {
        status: 'pending',
        ready: false,
        blocked_by: ['P'],
        blocked_reasons: { P: 'integration state unknown (gh compare failed: API rate limit exceeded) — retried next sync' },
      },
    }
  );
  assert.deepStrictEqual(f.actionable.execute, [], 'nothing may start on a base nobody has seen');
  assert.deepStrictEqual(f.parked.blocked, ['C']);
  assert.ok(/integration state unknown/.test(f.why.C), f.why.C);
  assert.ok(/retried next sync/.test(f.why.C), 'the park is provisional, and says so');
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
    'T-02-01': { phase: '2' },                              // left behind: phase 2's own epic went in
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
  const f = computeFront(tickets, state, { epics: epicsOf(landedEpic(2), openEpic(14)) });
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
  const epics = epicsOf(landedEpic(2), openEpic(14));
  const out = formatFront(computeFront(tickets, state, { epics })).join('\n');
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

test('a non-checkpoint parent holds the child too — as waiting.parent, not as a person\'s move', () => {
  // The OTHER shared test, and the disagreement it hid. `sentinel.cjs` has
  // answered `wait-parent` here since it was written; the board offered the very
  // same ticket as a merge. The loop dispatched nothing (the bucket is the
  // guard's), the guard declined the work the board offered, `ci-wait.cjs`
  // refused because something was "actionable", and the stop gate blocked over
  // it — round after round on the proving ground.
  const t = { P: { branch: 'ticket/P' }, C: { primary_parent: 'P', branch: 'ticket/C' } };
  const f = computeFront(t, cpState('pr-open'), { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, [], 'the front must never offer what the guard refuses');
  assert.deepStrictEqual(f.waiting.parent, ['C'], 'it is held behind a parent that is still moving');
  assert.deepStrictEqual(f.waiting.human, [], 'and nobody is waited FOR: the guard drives the parent itself');
  assert.strictEqual(f.parent_of.C, 'P', 'the board names the parent, so ci-wait.cjs need not re-derive it');
  assert.ok(/\bP\b/.test(f.why.C), f.why.C);
});

suite('front — a parent that is still moving is a bucket, not work');

// D4. The guard's `wait-parent` had no counterpart on the board, so a held child
// read as `finalize`/`fix`/`merge`: work the main loop would not take (the bucket
// belongs to the guard) and the guard would not do either. Everything downstream
// then read the board wrong — `ci-wait.cjs` refused ("something is actionable"),
// and the stop gate blocked on a front whose only content was a wait.
const mvTickets = { P: { branch: 'ticket/P' }, C: { primary_parent: 'P', branch: 'ticket/C' } };
// A parent whose own CI is still running, and a child green + conform behind it.
const mvState = (childOver = {}) => ({
  P: { status: 'pr-open', pr: 1, draft: false, checks: checks(0, 2), branch: 'ticket/P' },
  C: {
    status: 'pr-open', pr: 2, draft: false, checks: checks(), gate: conform,
    merge_scope: 'stacked', pr_base: 'ticket/P', branch: 'ticket/C', ...childOver,
  },
});

test('a board whose only move is a moving parent has nothing actionable and is not a fixpoint', () => {
  const f = computeFront(mvTickets, mvState(), { autoMerge: true });
  assert.strictEqual(f.actionable_count, 0, 'nothing here is the run\'s to start');
  assert.deepStrictEqual(f.waiting.parent, ['C']);
  assert.deepStrictEqual(f.waiting.ci, ['P'], 'the parent is the pipeline being waited for');
  assert.strictEqual(f.counts.parent, 1, 'counted, so a board summary cannot omit it');
  assert.strictEqual(f.fixpoint, false, 'a parent still moving is never an ending');
});

test('a RED child of a moving parent is held as well — the guard orders it that way', () => {
  // `dutyItems` tests `parentIsMoving` BEFORE the failing-checks branch: fixing a
  // child now buys a green the base move undoes. The board must order it the
  // same way or the two disagree on exactly the tickets that cost CI twice.
  const f = computeFront(mvTickets, mvState({ checks: checks(2, 0) }), { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, [], 'not fix work while the base is about to move');
  assert.deepStrictEqual(f.waiting.parent, ['C']);
});

test('the reason names the parent AND what it is doing', () => {
  const f = computeFront(mvTickets, mvState(), { autoMerge: true });
  assert.ok(/\bP\b/.test(f.why.C), f.why.C);
  assert.ok(/check/.test(f.why.C), `it says what the parent is doing: ${f.why.C}`);
});

test('a PARKED parent is not a moving parent — the child is offered again', () => {
  // `parentIsMoving`'s exact semantics, parked half: the guard reads its own
  // PARKED set (flag + escalations + drift verdicts), so the board must build
  // the same set or the two disagree the moment a human parks a parent.
  const f = computeFront(mvTickets, mvState(), { autoMerge: true, parked: ['P'] });
  assert.deepStrictEqual(f.waiting.parent, [], 'nothing is moving behind a parked parent');
  assert.deepStrictEqual(f.actionable.merge, ['C']);
});

test('a CHECKPOINT parent still routes to waiting.human, not to waiting.parent', () => {
  // The two holds are different facts with different remedies: a person holds
  // the key in one, the guard drives the parent in the other.
  const f = computeFront(cpTickets, cpState('pr-open'), { autoMerge: true });
  assert.deepStrictEqual(f.waiting.parent, [], 'a checkpoint parent is not a parent being DRIVEN');
  assert.ok(f.waiting.human.includes('C'), 'the child waits on the person holding the parent');
  // …and the parent itself is that person's, which is why it is here too: the
  // fixture's P is green and out of draft, so its own checkpoint is what is left.
  assert.ok(f.waiting.human.includes('P'), f.why.P);
});

test('the held child is the guard\'s share, so the board never calls it clear', () => {
  const f = computeFront(mvTickets, mvState(), { autoMerge: true });
  assert.deepStrictEqual(f.sentinel.waiting_parent, ['C']);
  assert.strictEqual(f.sentinel.clear, false, 'the guard has to come back when the parent lands');
});

test('formatFront renders it under waiting, and the verdict names ci-wait.cjs', () => {
  const out = formatFront(computeFront(mvTickets, mvState(), { autoMerge: true })).join('\n');
  assert.ok(/waiting: [^\n]*parent: C/.test(out), out);
  assert.ok(/fixpoint: NO/.test(out), out);
  assert.ok(/ci-wait\.cjs/.test(out), 'the one legitimate wait is a script, not a `--watch`');
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
  // Phase 2 shipped without these four — its own epic went in. That is now the
  // fixture's job to SAY: the merged phase-14 ticket beside them used to be the
  // whole reason they read as left behind, and a higher number landing is not a
  // fact about phase 2.
  const f = computeFront(tickets, state, { epics: epicsOf(landedEpic(2), openEpic(14)) });
  assert.deepStrictEqual(
    f.actionable.execute, ['T-14-02', 'T-02-01'],
    'unblocking power must never promote a phase that shipped without the ticket'
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

suite('front — left behind is evidence, not arithmetic');

// The flag used to be `phase(id) < max(phase of any merged ticket)`, which is a
// claim about NUMBERS. Measured on 2026-09-07: three phase-26 tickets merged into
// their epic, so the board called phase 24's live, high-risk, pre-authorized head
// `ALL 1 actionable item(s) are in phases already moved past` and the stop gate's
// all-left-behind hatch exited 0 over it. Every test here is one reading of "its
// own phase landed without it" that the arithmetic got wrong in one direction or
// the other.

test('a phase delivered out of order is not left behind by a newer one', () => {
  // ROADMAP §22: this repository shipped phase 22 before 21 on purpose. Phase 21
  // is the live work, and the only thing 22's landing proves is that 22 landed.
  const tickets = {
    'T-21-01': { phase: '21' },
    'T-21-02': { phase: '21', depends_on: ['T-21-01'] },
    'T-22-01': { phase: '22' },
  };
  const state = {
    'T-21-01': { status: 'pending', ready: true },
    'T-21-02': held('T-21-01'),
    'T-22-01': { status: 'merged' },
  };
  const f = computeFront(tickets, state, { epics: epicsOf(openEpic(21), landedEpic(22)) });
  assert.deepStrictEqual(f.actionable.execute, ['T-21-01'], 'the live phase is work');
  assert.strictEqual(
    f.left_behind_count, 0,
    'phase 21 is being delivered — 21 < 22 is arithmetic, not an abandonment'
  );
  // …and the verdict a run reads must not offer the all-left-behind exit either.
  assert.ok(
    formatFront(f).some((l) => /1 item\(s\) are actionable RIGHT NOW/.test(l)),
    'the fixpoint line must demand motion, not a decision'
  );
});

test("a ticket its own phase's epic landed without IS left behind", () => {
  const tickets = { 'T-20-01': { phase: '20' }, 'T-20-02': { phase: '20' } };
  const state = {
    'T-20-01': { status: 'merged' },
    'T-20-02': { status: 'pr-open', pr: 4, draft: true, checks: checks() },
  };
  const f = computeFront(tickets, state, { epics: epicsOf(landedEpic(20)) });
  assert.deepStrictEqual(f.actionable.finalize, ['T-20-02'], 'still listed — the fixpoint must not lie');
  assert.strictEqual(f.left_behind_count, 1, 'the phase integrated without it');
  assert.ok(f.parked.done.includes('T-20-01'), 'and the merged one is the evidence, not a casualty');
});

test('an epic freshly cut from its base has landed nothing at all', () => {
  // `exists` + 0 ahead is `landed: true`, and it is exactly as true of an empty
  // new epic as of one whose whole diff is in. Reading that alone as evidence
  // would flag an entire phase at the instant its delivery began — a worse
  // defect than the arithmetic it replaces, and reachable on every phase.
  const tickets = { 'T-27-01': { phase: '27' }, 'T-27-02': { phase: '27' } };
  const state = {
    'T-27-01': { status: 'pending', ready: true },
    'T-27-02': { status: 'pending', ready: true },
  };
  const f = computeFront(tickets, state, { epics: epicsOf(epicRecord(27)) });
  assert.strictEqual(f.left_behind_count, 0, 'no integration event has happened yet');
});

test('a phase whose epic branch does not exist yet has not shipped', () => {
  // Every decomposed phase has an `epics` entry from the moment it is planned,
  // long before its branch is cut — and a missing branch is `landed: true` for
  // the honest reason that nothing of the phase is outside the base.
  const tickets = { 'T-28-01': { phase: '28' } };
  const state = { 'T-28-01': { status: 'pending', ready: true } };
  const f = computeFront(tickets, state, {
    epics: epicsOf(epicRecord(28, {
      exists: false,
      landed_reason: 'epic epic/28-x does not exist — nothing from this phase is outside main',
    })),
  });
  assert.strictEqual(f.left_behind_count, 0, 'an unstarted phase is not one that moved on');
});

test('an epic reaped after its integration PR merged still proves the landing', () => {
  // The mirror of the case above: the branch is gone, but the merged epic PR is
  // the integration event and it is what the record still carries.
  const tickets = { 'T-19-01': { phase: '19' } };
  const state = { 'T-19-01': { status: 'pr-open', pr: 3, draft: true, checks: checks() } };
  const f = computeFront(tickets, state, {
    epics: epicsOf(landedEpic(19, {
      exists: false,
      landed_reason: 'epic epic/19-x does not exist — nothing from this phase is outside main',
    })),
  });
  assert.strictEqual(f.left_behind_count, 1, 'the phase landed and this ticket was not in it');
});

test('a merged TICKET is not the phase landing — it may have merged into a parent', () => {
  // The tempting second signal, and it re-creates this ticket's defect. A
  // `merged` status means the PR went into ITS OWN base, and in a stack that
  // base is legitimately a parent TICKET branch; `pr_base` — the only field
  // that tells the two apart — is recorded for OPEN PRs alone, so a merged
  // entry cannot say which it was. Here the epic is freshly cut (level with its
  // base, no integration PR), the parent is green and ready, and a child was
  // squash-merged into the parent by hand: counting that child would call the
  // parent left behind and let the stop gate exit over it.
  const tickets = {
    'T-27-01': { phase: '27' },
    'T-27-02': { phase: '27', depends_on: ['T-27-01'], primary_parent: 'T-27-01' },
  };
  const state = {
    'T-27-01': { status: 'pr-open', pr: 4, draft: true, checks: checks() },
    'T-27-02': { status: 'merged' },
  };
  const f = computeFront(tickets, state, { epics: epicsOf(epicRecord(27, { pr: null })) });
  assert.deepStrictEqual(f.actionable.finalize, ['T-27-01'], 'the parent is live work');
  assert.strictEqual(f.left_behind_count, 0, 'nothing has been observed to integrate');
});

test('an unanswered comparison is not evidence, even beside a merged epic PR', () => {
  // T-26-03 made `landed` tri-state precisely so a failed compare stops reading
  // as a zero nobody measured. A merged epic PR does not overrule it: commits
  // pushed to the epic after that merge are exactly what the compare would have
  // seen, and this file must not guess on a fact whose measurement failed.
  const tickets = { 'T-23-01': { phase: '23' } };
  const state = { 'T-23-01': { status: 'pr-open', pr: 5, draft: true, checks: checks() } };
  const f = computeFront(tickets, state, {
    epics: epicsOf(landedEpic(23, {
      ahead: null,
      landed: null,
      landed_reason: 'gh compare failed: rate limited',
    })),
  });
  assert.strictEqual(f.left_behind_count, 0, 'unknown is not landed — it is retried');
});

test('a phase whose epic is still ahead of its base is nobody\'s casualty', () => {
  const tickets = { 'T-24-05': { phase: '24' } };
  const state = { 'T-24-05': { status: 'pending', ready: true } };
  const f = computeFront(tickets, state, { epics: epicsOf(openEpic(24)) });
  assert.strictEqual(f.left_behind_count, 0, '7 commits outside the base is a phase in flight');
});

test('with no epic observation at all, nothing is left behind', () => {
  // front.cjs's own CLI and `dispatch-record.cjs refreshFront` cannot ask GitHub,
  // so they pass none. The hatch this count feeds (stop-gate.cjs) must never fire
  // on a fact nobody measured: with no evidence the run keeps driving.
  const tickets = { 'T-20-01': { phase: '20' }, 'T-20-02': { phase: '20' } };
  const state = {
    'T-20-01': { status: 'merged' },
    'T-20-02': { status: 'pr-open', pr: 4, draft: true, checks: checks() },
  };
  assert.strictEqual(computeFront(tickets, state, {}).left_behind_count, 0, 'absence of evidence is not evidence');
  assert.strictEqual(
    computeFront(tickets, state, { epics: {} }).left_behind_count, 0,
    'an empty observation reads the same as none — direct-to-main has no epics at all'
  );
});

test("another repository's epic does not speak for this one", () => {
  // One epic NAME per phase, but a separate branch and integration PR per repo —
  // which is why the record is keyed by both. A phase that landed in the API repo
  // says nothing about its own web-repo half.
  const tickets = {
    'T-30-01': { phase: '30', repo: 'acme/api' },
    'T-30-02': { phase: '30', repo: 'acme/web' },
  };
  const state = {
    'T-30-01': { status: 'pr-open', pr: 1, draft: true, checks: checks() },
    'T-30-02': { status: 'pr-open', pr: 2, draft: true, checks: checks() },
  };
  const f = computeFront(tickets, state, {
    epics: epicsOf(landedEpic(30, { repo: 'acme/api' }), openEpic(30, { repo: 'acme/web' })),
  });
  assert.strictEqual(f.left_behind_count, 1, 'one repo integrated, the other is still ahead');
  assert.deepStrictEqual(
    f.actionable.finalize, ['T-30-02', 'T-30-01'],
    'and the left-behind half sorts last within the bucket'
  );
});

test('a board of nothing but left-behind work still says so, in the new words', () => {
  const tickets = { 'T-20-01': { phase: '20' }, 'T-20-02': { phase: '20' } };
  const state = {
    'T-20-01': { status: 'merged' },
    'T-20-02': { status: 'pr-open', pr: 4, draft: true, checks: checks() },
  };
  const f = computeFront(tickets, state, { epics: epicsOf(landedEpic(20)) });
  const line = formatFront(f).find((l) => /^fixpoint:/.test(l));
  assert.ok(/ALL 1 actionable item\(s\)/.test(line), line);
  assert.ok(/own epic\s+already landed without them/.test(line.replace(/\s+/g, ' ')), line);
  assert.ok(/decision, not motion/.test(line), 'the two exits are still named');
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

suite('front — a ticket an agent already holds is waiting, never work to start');

// The board had no state for DISPATCHED AND RUNNING, so a ticket handed to an
// agent read exactly like one nobody had touched — nothing is pushed yet, so the
// live state still says `execute`. The stop gate then refused turns over work in
// flight five times in one session, across both owners' buckets. These pin the
// three properties that make the new bucket safe: it is not actionable, it is not
// a park, and it is not an ending.

const dispatchState = () => ({
  A: { status: 'pending', ready: true },
  B: { status: 'pr-open', pr: 2, draft: true, checks: checks() },
});

test('a dispatched ticket leaves the actionable set for waiting.dispatched', () => {
  const f = computeFront({ A: {}, B: {} }, dispatchState(),
    { dispatched: { A: { role: 'executor', at: new Date().toISOString() } } });
  assert.deepStrictEqual(f.waiting.dispatched, ['A']);
  assert.deepStrictEqual(f.actionable.execute, [], 'nobody else may start it');
  assert.deepStrictEqual(f.parked.blocked, [], 'and nobody has given up on it either');
  assert.deepStrictEqual(f.actionable.finalize, ['B'], 'the rest of the front is untouched');
});

test('the why-message names both ways the record lifts', () => {
  // The sentence comes from the store that decides when it lifts, not from this
  // render site. A reader who does not know it expires by itself reaches for
  // `clear` — and a `clear` that becomes routine clears work that has not
  // returned.
  const f = computeFront({ A: {} }, { A: { status: 'pending', ready: true } },
    { dispatched: { A: { role: 'executor', at: new Date().toISOString() } } });
  assert.ok(/executor/.test(f.why.A), f.why.A);
  assert.ok(/state moves/.test(f.why.A), 'the state trigger');
  assert.ok(/\d+m/.test(f.why.A), 'and the timeout');
});

test('dispatched is NOT a fixpoint — the round has to collect the result', () => {
  const f = computeFront({ A: {} }, { A: { status: 'pending', ready: true } },
    { dispatched: { A: { role: 'executor', at: new Date().toISOString() } } });
  assert.strictEqual(f.actionable_count, 0, 'there is nothing to start');
  assert.strictEqual(f.fixpoint, false, 'which is not the same as being finished');
  const out = formatFront(f).join('\n');
  assert.ok(/with an agent right now/.test(out), out);
  assert.ok(!/watch is legal here/.test(out), 'there is no CI queue to watch — that sentence belongs elsewhere');
});

test('counts still cover every ticket exactly once', () => {
  const f = computeFront({ A: {}, B: {} }, dispatchState(), { dispatched: { A: 'executor' } });
  assert.strictEqual(Object.values(f.counts).reduce((a, b) => a + b, 0), 2);
  assert.strictEqual(f.counts.dispatched, 1);
});

test('a park outranks a dispatch, and a merge outranks both', () => {
  // A park is a DECISION; a dispatch is a transient. And whoever was working on a
  // ticket that has already landed, it is in — so a stale record must not hide a
  // merged ticket from the `done` tally.
  const escalated = computeFront({ A: {} }, { A: { status: 'pr-open', pr: 1, draft: true, checks: checks() } },
    { dispatched: { A: 'review-fix' }, escalated: { A: { kind: 'escalation', reason: 'a human must decide' } } });
  assert.deepStrictEqual(escalated.parked.blocked, ['A'], 'the escalation still shows');
  assert.deepStrictEqual(escalated.waiting.dispatched, []);

  const merged = computeFront({ A: {} }, { A: { status: 'merged' } }, { dispatched: { A: 'pr-sentinel' } });
  assert.deepStrictEqual(merged.parked.done, ['A']);
  assert.deepStrictEqual(merged.waiting.dispatched, []);
  assert.strictEqual(merged.fixpoint, true, 'a record over landed work never blocks an ending');
});

test('the guard\'s own dispatches keep the board from calling it clear', () => {
  // `sentinel: clear` is one of the two conditions deliver.md reads as "you may
  // enter completion". A guard mid-round whose tickets have left `duty` must not
  // produce that line.
  const state = { A: { status: 'pr-open', pr: 1, checks: checks(1, 0) } };
  const guarded = computeFront({ A: {} }, state, { dispatched: { A: 'ci-fix' } });
  assert.deepStrictEqual(guarded.sentinel.duty, [], 'it left the duty list');
  assert.deepStrictEqual(guarded.sentinel.dispatched, ['A'], 'because the guard has it');
  assert.strictEqual(guarded.sentinel.clear, false);
  assert.ok(/already with an agent/.test(formatFront(guarded).join('\n')));

  // …and an EXECUTOR dispatch says nothing about the guard, which owns no part
  // of that ticket.
  const mine = computeFront({ A: {} }, { A: { status: 'pending', ready: true } }, { dispatched: { A: 'executor' } });
  assert.deepStrictEqual(mine.sentinel.dispatched, []);
  assert.strictEqual(mine.sentinel.clear, true, 'no open PR needs guarding');
});

test('a dispatched wave and a running CI queue are reported as two different waits', () => {
  const f = computeFront(
    { A: {}, B: {} },
    { A: { status: 'pending', ready: true }, B: { status: 'pr-open', pr: 2, checks: checks(0, 2) } },
    { dispatched: { A: 'executor' } }
  );
  const out = formatFront(f).join('\n');
  assert.ok(/waiting: ci: B \| dispatched: A/.test(out), out);
  assert.ok(/1 ticket\(s\) are with an agent right now, and 1 PR\(s\) are running CI/.test(out), out);
});

suite('front — a PR where nothing ran is not a green PR');

// Б3. `none_reported` used to count as green all the way into `actionable.merge`,
// so a PR in a repo whose CI never registered was squashed into the epic with no
// test having run. state-sync warns about it in a line nobody reads at 3am; the
// honest bucket is `waiting.merge_human`, unless the project SAYS it has no CI.

const noCi = { total: 0, failing: 0, pending: 0, none_reported: true };
const noCiLanded = { ...landed, checks: noCi };

test('green + conform + stacked, but nothing ran → waiting.merge_human', () => {
  const f = computeFront({ T: {} }, { T: { ...noCiLanded } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, [], 'nothing verified this branch');
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  // The remedy is a decision, so the reason has to name both halves of it.
  assert.ok(/merge_without_ci/.test(f.why.T), f.why.T);
  assert.ok(/register/.test(f.why.T), f.why.T);
  assert.strictEqual(f.fixpoint, true, 'nobody owes work — a person holds this one');
});

test('...and the same PR merges when the project says it has no CI (the control)', () => {
  const f = computeFront({ T: {} }, { T: { ...noCiLanded } }, { autoMerge: true, mergeWithoutCi: true });
  assert.deepStrictEqual(f.actionable.merge, ['T']);
  assert.deepStrictEqual(f.waiting.merge_human, []);
});

test('a pipeline that reported is untouched (the second control)', () => {
  const f = computeFront({ T: {} }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['T']);
});

test('a certified draft where nothing ran is held too, not finalized', () => {
  // `finalize` would be dispatched every round to do the one mechanical thing
  // left (ready the PR) — the "every round re-proposes the same impossible
  // action" loop. The guard withholds that `undraft`, so the board must not
  // offer it.
  const f = computeFront({ T: {} }, { T: { ...noCiLanded, draft: true } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.finalize, []);
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.ok(/merge_without_ci/.test(f.why.T), f.why.T);
});

test('an UNCERTIFIED draft where nothing ran is still finalize work', () => {
  // The architecture verdict and the review threads are real work whatever CI
  // did, so only the two landing actions are withheld.
  const f = computeFront({ T: {} }, { T: { ...noCiLanded, draft: true, gate: undefined } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
  assert.deepStrictEqual(f.waiting.merge_human, []);
});

test('with auto-merge off nothing is withheld — the human merges it either way', () => {
  // Readying a PR nobody may auto-merge is a courtesy to the person who will,
  // and the duty's `checks_note` already tells them what "green" meant. Holding
  // the draft here would leave a PR nobody can land.
  const f = computeFront({ T: {} }, { T: { ...noCiLanded, draft: true } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('a checkpoint outranks the no-CI hold — a person holds that one for another reason', () => {
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { ...noCiLanded } }, { autoMerge: true });
  assert.deepStrictEqual(f.waiting.human, ['T']);
  assert.deepStrictEqual(f.waiting.merge_human, []);
});

suite('front — a check state that could not be READ is neither empty nor green');

// The fourth state. An unreadable `gh pr checks` (a 503, a rate limit, an old
// `gh` rejecting `--json bucket`) used to reach the board as `none_reported`,
// which routes to `waiting.merge_human` and asks a person to confirm that this
// repo has no CI — about a reading that never happened. Then it reached the board
// as a synthetic pending row, which waits for the right reason while claiming one
// check is running on a PR nobody read. `unavailable` is the fact as itself: no
// work is owed, nobody is asked anything, and the next sync looks again.
//
// The assertions below deliberately discriminate from BOTH predecessors: the
// bucket alone was already `waiting.ci` under the synthetic row, so the tally and
// the why-message are what pin this behaviour rather than the routing.
const unread = (note = 'gh: HTTP 503: Service Unavailable') =>
  ({ total: 0, failing: 0, pending: 0, none_reported: false, unavailable: true, note });
const unreadLanded = { ...landed, checks: unread() };

test('green + conform + stacked, but the checks were never read → waiting.ci', () => {
  const f = computeFront({ T: {} }, { T: { ...unreadLanded } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, [], 'nothing read this branch');
  assert.deepStrictEqual(f.waiting.ci, ['T']);
  assert.deepStrictEqual(f.waiting.merge_human, [], 'nobody is asked to confirm a reading that did not happen');
  assert.ok(/checks unreadable/.test(f.why.T), f.why.T);
  assert.ok(/HTTP 503/.test(f.why.T), 'the cause gh printed is what makes the message actionable');
  assert.ok(/retried next sync/.test(f.why.T), f.why.T);
  assert.ok(!/still running/.test(f.why.T), 'no phantom check: the synthetic row said exactly that');
  assert.strictEqual(f.fixpoint, false, 'waiting on CI is never a fixpoint');
});

test('the same PR is not actionable in ANY bucket', () => {
  // `finalize` is the one that would otherwise fire (a green, out-of-draft PR
  // with an unrecorded gate is finalize work), so assert the whole board.
  const f = computeFront(
    { T: {}, D: {} },
    { T: { ...unreadLanded, gate: undefined }, D: { ...unreadLanded, pr: 10, draft: true } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(Object.values(f.actionable).flat(), []);
  assert.deepStrictEqual(f.waiting.ci.slice().sort(), ['D', 'T']);
});

test('a note the board never carried still names the state', () => {
  // `note` is only ever written beside the flag, but a board can be hand-edited
  // or written by an older release — the why-message must not read "undefined".
  const f = computeFront({ T: {} }, { T: { ...landed, checks: { ...unread(), note: undefined } } }, { autoMerge: true });
  assert.deepStrictEqual(f.waiting.ci, ['T']);
  assert.ok(/checks unreadable: gh pr checks did not answer/.test(f.why.T), f.why.T);
});

test('an OBSERVED empty list is untouched — it is still the human\'s merge (the control)', () => {
  // `gh` exits 1 both for a failing check and for a PR with no checks at all, so
  // an exit-1 answer of `[]` is the ordinary no-CI path, not an error. The two
  // states must not converge again: this one names the setting, that one does not.
  const f = computeFront({ T: {} }, { T: { ...noCiLanded } }, { autoMerge: true });
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.deepStrictEqual(f.waiting.ci, []);
  assert.ok(/merge_without_ci/.test(f.why.T), f.why.T);
});

test('merge_without_ci does NOT lift an unreadable answer', () => {
  // The setting is a person saying "this repository has no CI". It says nothing
  // about a call that failed, and reading it as consent for one would put the
  // merge gate right back where Б3 found it.
  const f = computeFront({ T: {} }, { T: { ...unreadLanded } }, { autoMerge: true, mergeWithoutCi: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.ci, ['T']);
});

test('a failing check outranks it — a tally that WAS read is the louder fact', () => {
  // Unreachable from state-sync (an unavailable answer has zero tallies), but the
  // branch order is the contract with sentinel.cjs's duty, and a hand-written or
  // half-migrated board must not lose a red.
  const f = computeFront({ T: {} }, { T: { ...landed, checks: { ...unread(), failing: 2 } } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
});

test('a MOVED BASE outranks it too, and the position is deliberate', () => {
  // The permanent case is an old `gh` that cannot answer `--json bucket` at all,
  // so routing to `waiting.ci` first would freeze base-merge for every round of
  // the run — and `merge_state` comes from a different call, which no `pr checks`
  // failure says anything about. `sentinel.cjs`'s duty holds the same order.
  const f = computeFront(
    { T: {} },
    { T: { ...unreadLanded, merge_state: 'BEHIND', behind_by: 3 } },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.actionable.fix, ['T']);
  assert.ok(/base moved/.test(f.why.T), f.why.T);
});

test('a human_checkpoint ticket waits on the READING, and is never offered as a merge', () => {
  // The opposite order from the no-CI hold, and for a mechanical reason: the
  // checkpoint branch is `needsHuman(t) && green`, and `green` is now false here.
  // Reached after this branch, that guard would fall through to the merge branch
  // below it and the board would offer to squash a checkpoint PR nobody approved.
  // So the checkpoint is not LOST, it is deferred: `waiting.ci` resolves by
  // looking again, and the moment the reading succeeds the checkpoint answers.
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { ...unreadLanded } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, [], 'the one answer that would be unrecoverable');
  assert.deepStrictEqual(f.waiting.ci, ['T']);
  assert.deepStrictEqual(f.waiting.human, []);
});

suite('front — the project config is read AT MOST ONCE per board');

// Reviewer-found on PR #44. `heldForNoCi` resolved `merge_without_ci` EAGERLY to
// build noCiHold's options object, so every `computeFront` opened the project's
// config file — twice on a board with two no-CI PRs. What made it worth a test
// rather than a shrug is that the comment beside the resolver already promised
// the opposite: the file asserted a behaviour the code did not have. These pin
// the promise so it cannot rot back, and they measure the READ, not the clock.
//
// The promise CHANGED SHAPE with the concurrency cap (ADR-005 D11), and the
// change is stated here rather than quietly absorbed. `merge_without_ci` is
// conditional — it can only alter a board that actually holds a PR with no
// reported checks — so it could be resolved on first need or never. A CAPACITY
// number is not conditional: every board reports `capacity`, because the run
// builds its wave from `capacity.free`, so on an ordinary board there is now
// one read where there were none.
//
// What is pinned instead is the invariant that actually protects the file:
// ONE read per computeFront, shared by both knobs, however many PRs or tickets
// the board holds — and still ZERO for a caller that pins both, which is the
// path state-sync.cjs and the CLI take.
const cfgMod = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs'
));

// front.cjs requires pipeline-config.cjs lazily, INSIDE the resolver, so the
// spy goes on the cached module object it looks the export up on.
function configReadsDuring(fn) {
  const real = cfgMod.loadConfig;
  let reads = 0;
  cfgMod.loadConfig = (...args) => { reads += 1; return real(...args); };
  try { fn(); } finally { cfgMod.loadConfig = real; }
  return reads;
}

test('an ordinary board reads it exactly once — for the cap, not for merge_without_ci', () => {
  const reads = configReadsDuring(() => {
    const f = computeFront(
      { A: {}, B: {}, C: {} },
      {
        A: { ...landed }, B: { ...landed },
        C: { status: 'pr-open', pr: 11, draft: true, checks: checks() },
      },
      { autoMerge: true }
    );
    assert.deepStrictEqual(f.actionable.merge.slice().sort(), ['A', 'B']);
    // Nothing here reports `none_reported`, so merge_without_ci still cannot
    // change an answer and still resolves nothing. The one read is the cap's.
    assert.strictEqual(f.capacity.max > 0, true, 'a readable config yields a positive cap');
  });
  assert.strictEqual(reads, 1, 'the cap is unconditional; merge_without_ci is not, and shares the read');
});

test('pinning only the cap leaves merge_without_ci resolving nothing on an ordinary board', () => {
  // The two knobs are independent: pinning the cap must not drag the other one
  // into a read it does not need.
  const reads = configReadsDuring(() => {
    computeFront({ A: {} }, { A: { ...landed } }, { autoMerge: true, maxConcurrentAgents: 3 });
  });
  assert.strictEqual(reads, 0);
});

test('a board with no-CI PRs reads it ONCE, however many of them there are', () => {
  const reads = configReadsDuring(() => {
    const f = computeFront(
      { A: {}, B: {} },
      { A: { ...noCiLanded }, B: { ...noCiLanded } },
      { autoMerge: true }
    );
    assert.deepStrictEqual(f.waiting.merge_human.slice().sort(), ['A', 'B']);
  });
  assert.strictEqual(reads, 1, 'resolved on first need, memoized for the rest of the call');
});

test('a caller that pins BOTH knobs reads nothing, even with a no-CI PR', () => {
  // The path state-sync.cjs and the front CLI take: they have already paid for
  // the config, so they hand both answers in and computeFront opens no file.
  const reads = configReadsDuring(() => {
    const f = computeFront({ T: {} }, { T: { ...noCiLanded } },
      { autoMerge: true, mergeWithoutCi: true, maxConcurrentAgents: 4 });
    assert.deepStrictEqual(f.actionable.merge, ['T']);
    assert.strictEqual(f.capacity.max, 4);
  });
  assert.strictEqual(reads, 0, 'a passed option always wins, so there is nothing to look up');
});

test('pinning only merge_without_ci still costs the cap\'s single read, never two', () => {
  const reads = configReadsDuring(() => {
    const f = computeFront({ A: {}, B: {} }, { A: { ...noCiLanded }, B: { ...noCiLanded } },
      { autoMerge: true, mergeWithoutCi: true });
    assert.deepStrictEqual(f.actionable.merge.slice().sort(), ['A', 'B']);
  });
  assert.strictEqual(reads, 1);
});

test('with auto-merge off merge_without_ci is not consulted either', () => {
  // The hold is gated on autoMerge, and that is the cheapest fact of the three,
  // so it is settled before anything goes looking for a file. The cap's read
  // still happens — it is unconditional — and it is the ONLY one.
  const reads = configReadsDuring(() => {
    computeFront({ T: {} }, { T: { ...noCiLanded, draft: true } });
  });
  assert.strictEqual(reads, 1);

  const pinned = configReadsDuring(() => {
    computeFront({ T: {} }, { T: { ...noCiLanded, draft: true } }, { maxConcurrentAgents: 2 });
  });
  assert.strictEqual(pinned, 0, 'and nothing at all once the cap is pinned');
});

// The predicate is shared with sentinel.cjs, which passes the resolved VALUE
// rather than a resolver. Both spellings must mean the same thing or the board
// and the guard disagree about the PR in front of them.
test('noCiHold takes the setting as a value or as a thunk, with one meaning', () => {
  const { noCiHold } = require(path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
  ));
  const held = (mergeWithoutCi) => noCiHold(noCi, { autoMerge: true, mergeWithoutCi });
  assert.strictEqual(held(false), true, 'value: not allowed → held');
  assert.strictEqual(held(() => false), true, 'thunk: same');
  assert.strictEqual(held(true), false, 'value: allowed → not held');
  assert.strictEqual(held(() => true), false, 'thunk: same');
  assert.strictEqual(held(undefined), true, 'absent is not permission (sentinel passes cfg.merge_without_ci raw)');
  // And the thunk is never called when a cheaper fact already settles it.
  let called = 0;
  const counting = () => { called += 1; return true; };
  assert.strictEqual(noCiHold(noCi, { autoMerge: false, mergeWithoutCi: counting }), false);
  assert.strictEqual(noCiHold(checks(), { autoMerge: true, mergeWithoutCi: counting }), false);
  assert.strictEqual(called, 0, 'auto-merge off and a reported pipeline both answer without it');
});

// Reviewer-found on PR #44 (round 2). The lazy fallback resolved the project
// from `process.cwd()`, but `dispatch-record.cjs refreshFront` is documented to
// run from a ticket worktree — which has no `.planning/` of its own — and it
// REWRITES delivery-front.json from what it computes. So on a project that had
// explicitly opted in, every dispatch mark demoted the PRs the guard was
// entitled to land: the board/guard disagreement, reintroduced by the fallback
// written to prevent it. It resolves through graph-dir.cjs now, the same way
// base-merge and scope-gate do.
test('the fallback resolves the PROJECT, not the cwd — a worktree reads the project setting', () => {
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'front-wt-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(project, 'f.txt'), 'x\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  // .planning/ is written AFTER the commit and never tracked: that is the
  // proving ground's own layout, and it is what makes a worktree graphless.
  fs.mkdirSync(path.join(project, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(project, '.planning', 'graph', 'tickets.json'),
    JSON.stringify({ tickets: { T: {} } }));
  fs.writeFileSync(path.join(project, '.planning', 'config.json'),
    JSON.stringify({ delivery_pipeline: { merge_without_ci: true } }));
  const wt = path.join(root, 'wt');
  git(project, 'worktree', 'add', '-q', '-b', 'ticket/T', wt);
  assert.ok(!fs.existsSync(path.join(wt, '.planning')), 'fixture: the worktree must carry no graph of its own');

  const cwd = process.cwd();
  try {
    process.chdir(wt);
    const f = computeFront({ T: {} }, { T: { ...noCiLanded } }, { autoMerge: true });
    assert.deepStrictEqual(f.actionable.merge, ['T'],
      'the project said it has no CI; a caller standing in a worktree must read the same answer as the guard');
    assert.deepStrictEqual(f.waiting.merge_human, []);
  } finally {
    process.chdir(cwd);
  }
});

suite('front — CHANGES_REQUESTED with no thread left is a person\'s, not a fixer\'s');

// A reviewer who requested changes in a summary comment — or a bot whose threads
// were all resolved while its verdict stood — leaves ZERO threads. The board
// called that "review not settled" and offered it as `finalize`, the guard sent
// review-fix, and review-fix returned having done nothing: the signature
// repeated until the attempt budget escalated the ticket. Nobody owed work; a
// person held the key. One predicate, two readers, like checkpointParent.

const crState = (over = {}) => ({
  T: {
    ...landed, review_decision: 'CHANGES_REQUESTED', ...over,
  },
});

test('threads 0 → waiting.human, and the reason names what a person must do', () => {
  const f = computeFront({ T: {} }, crState({ unresolved_count: 0 }), { autoMerge: true });
  assert.deepStrictEqual(f.waiting.human, ['T']);
  assert.strictEqual(f.actionable_count, 0, 'a fixer has nothing to service here');
  assert.ok(/re-review or dismiss/.test(f.why.T), f.why.T);
});

test('threads 1 → unchanged: the review work is still the run\'s', () => {
  const f = computeFront({ T: {} }, crState({ unresolved_count: 1 }), { autoMerge: true });
  assert.deepStrictEqual(f.waiting.human, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('an UNKNOWN thread count is not zero — the board does not park on a guess', () => {
  const f = computeFront({ T: {} }, crState(), { autoMerge: true });
  assert.deepStrictEqual(f.waiting.human, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('and a checkpoint still outranks it — that person is being waited for already', () => {
  const f = computeFront(
    { T: { human_checkpoint: true } }, crState({ unresolved_count: 0 }), { autoMerge: true }
  );
  assert.deepStrictEqual(f.waiting.human, ['T']);
  assert.ok(/human_checkpoint/.test(f.why.T), f.why.T);
});

suite('front — a base that moved is base-merge work, and says so');

// The remedy for a moved base was reachable by prose alone: `mergeOne` refused
// with a message, the duty had no action for it, and the board offered the merge
// the gate was about to refuse. Both readers now name the same fix, through the
// same predicate.

test('GitHub\'s own BEHIND verdict is fix work whose reason names base-merge.cjs', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, merge_state: 'BEHIND' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
  assert.deepStrictEqual(f.actionable.merge, [], 'the guard would refuse that merge');
  assert.ok(/base-merge/.test(f.why.T), f.why.T);
});

test('a commit count alone is enough — a stale-but-clean branch reports CLEAN', () => {
  // mergeStateStatus only says BEHIND where branch protection requires
  // up-to-date branches; elsewhere the compare is the only witness.
  const f = computeFront({ T: {} }, { T: { ...landed, merge_state: 'CLEAN', behind_by: 3 } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
  assert.ok(/3 commit/.test(f.why.T), f.why.T);
});

test('DIRTY is the same duty with a different word — conflicts, not staleness', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, merge_state: 'DIRTY' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
  assert.ok(/conflict/.test(f.why.T), f.why.T);
});

test('a red PR is still ci-fix work first — the failing check is the louder fact', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, checks: checks(2, 0), merge_state: 'BEHIND' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
  assert.ok(/failing check/.test(f.why.T), f.why.T);
});

test('CLEAN and zero behind is untouched (the control)', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, merge_state: 'CLEAN', behind_by: 0 } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['T']);
  assert.deepStrictEqual(f.actionable.fix, []);
});



// ── the concurrency cap: a wave is cut to what the session can afford ────────
//
// ADR-005 D11. No choice of TIER addresses this: the model policy is per
// dispatch and a spend limit is per session, so the missing axis is how many
// dispatches are open at once. On 2026-09-07 a run held nine opus/xhigh
// executors and a fable guard in flight, hit the limit, and six agents died
// mid-ticket — five tickets lost their commits.
//
// The cap is a gate on DISPATCH, so its failure direction is to dispatch LESS.
// It is also a TRUNCATION of an order, never a filter: nothing leaves
// `actionable`, which is exactly what keeps the fixpoint honest — a capped board
// still reports its work, and `fixpoint` stays NO because `actionable_count`
// never moved. deliver.md builds the wave from `capacity.free`; the remainder is
// taken next round.
suite('front — capacity');

const fs = require('fs');
const os = require('os');

// N root tickets, all ready, no parents: every sort key ties except the id, so
// the order is `T-26-01 … T-26-0N` and a truncation of it is deterministic.
const boardIds = (n) => Array.from({ length: n }, (_, i) => `T-26-${String(i + 1).padStart(2, '0')}`);
const readyBoard = (n) => {
  const ids = boardIds(n);
  return {
    ids,
    tickets: Object.fromEntries(ids.map((id) => [id, {}])),
    state: Object.fromEntries(ids.map((id) => [id, { status: 'pending', ready: true }])),
  };
};
const fixpointLine = (f) => formatFront(f).find((l) => /^fixpoint:/.test(l));
const capacityLine = (f) => formatFront(f).find((l) => /^capacity:/.test(l));

// A project computeFront can resolve the cap FROM, for the cases that exercise
// the fallback rather than the caller's own number. `SHIPYARD_GRAPH_DIR` is
// graph-dir.cjs's first-priority answer, so it pins the resolution regardless of
// where the test process happens to be standing — and it is restored after, or
// every later test in this file would inherit the fixture.
function projectWith(configText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-front-cap-'));
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {} }));
  if (configText !== undefined) fs.writeFileSync(path.join(dir, '.planning', 'config.json'), configText);
  return dir;
}
function inProject(dir, fn) {
  const prev = process.env.SHIPYARD_GRAPH_DIR;
  process.env.SHIPYARD_GRAPH_DIR = path.join(dir, '.planning', 'graph');
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SHIPYARD_GRAPH_DIR;
    else process.env.SHIPYARD_GRAPH_DIR = prev;
  }
}

test('7 actionable, cap 4, nothing in flight → free 4, and all 7 stay actionable in the same order', () => {
  const { ids, tickets, state } = readyBoard(7);
  const f = computeFront(tickets, state, { maxConcurrentAgents: 4 });
  assert.deepStrictEqual(f.capacity, { max: 4, in_flight: 0, free: 4 });
  // The cap does not reorder and does not hide: the first 4 of a good order is
  // still a good order, and the run — not the board — takes them.
  assert.deepStrictEqual(f.actionable.execute, ids);
  assert.strictEqual(f.actionable_count, 7);
  assert.strictEqual(f.fixpoint, false);
});

test('4 of the 7 with an agent → free 0, fixpoint NO, and the reason names capacity, not work', () => {
  const { ids, tickets, state } = readyBoard(7);
  const dispatched = Object.fromEntries(ids.slice(0, 4).map((id) => [id, 'executor']));
  const f = computeFront(tickets, state, { maxConcurrentAgents: 4, dispatched });
  assert.deepStrictEqual(f.capacity, { max: 4, in_flight: 4, free: 0 });
  assert.deepStrictEqual(f.actionable.execute, ids.slice(4));
  assert.strictEqual(f.fixpoint, false, 'a capped front is never a finished one');
  const line = fixpointLine(f);
  assert.ok(/capacity/.test(line), line);
  // The old wording ordered the run to dispatch NOW, which under a full cap is
  // an order to do the thing that killed the 2026-09-07 wave.
  assert.ok(!/actionable RIGHT NOW/.test(line), line);
});

test('every dispatch role counts against the cap — the guard is an agent too', () => {
  // "It is an agent, it holds tickets, and this session's failure included one."
  // So `in_flight` counts the raw dispatch records, not the actionable buckets:
  // a pr-sentinel and a ci-fix cost a session exactly what an executor costs.
  const { ids, tickets, state } = readyBoard(5);
  const dispatched = { [ids[0]]: 'pr-sentinel', [ids[1]]: 'ci-fix', [ids[2]]: 'review-fix' };
  const f = computeFront(tickets, state, { maxConcurrentAgents: 4, dispatched });
  assert.strictEqual(f.capacity.in_flight, 3);
  assert.strictEqual(f.capacity.free, 1);
});

test('more agents out than the cap allows is free 0, never a negative budget', () => {
  const { ids, tickets, state } = readyBoard(7);
  const dispatched = Object.fromEntries(ids.slice(0, 6).map((id) => [id, 'executor']));
  const f = computeFront(tickets, state, { maxConcurrentAgents: 4, dispatched });
  assert.deepStrictEqual(f.capacity, { max: 4, in_flight: 6, free: 0 });
});

test('formatFront prints the capacity line only when the cap binds', () => {
  const wide = readyBoard(7);
  const bound = computeFront(wide.tickets, wide.state, { maxConcurrentAgents: 4 });
  const line = capacityLine(bound);
  assert.ok(line, formatFront(bound).join('\n'));
  assert.ok(/4 agents/.test(line), line);
  assert.ok(/0 in flight/.test(line), line);
  assert.ok(/3 actionable item\(s\) wait for the next round/.test(line), line);

  // Room for everything on the board: nothing waits, so there is nothing to
  // explain and the line would only add noise to a healthy round.
  const small = readyBoard(2);
  const roomy = computeFront(small.tickets, small.state, { maxConcurrentAgents: 4 });
  assert.strictEqual(capacityLine(roomy), undefined, formatFront(roomy).join('\n'));
  assert.ok(/actionable RIGHT NOW/.test(fixpointLine(roomy)), fixpointLine(roomy));
});

test('a caller cannot express a cap of 0 — only an unreadable policy can', () => {
  // 0 is the one value that means "dispatch nothing", and it is reserved for the
  // case below. A caller passing 0 (or a NaN it computed) is treated as having
  // passed nothing, so the project's own policy answers instead of a value that
  // would silently freeze the run.
  const { tickets, state } = readyBoard(3);
  const dir = projectWith(JSON.stringify({ pipeline: { max_concurrent_agents: 2 } }));
  for (const bad of [0, -3, NaN, 'four', null]) {
    const f = inProject(dir, () => computeFront(tickets, state, { maxConcurrentAgents: bad }));
    assert.strictEqual(f.capacity.max, 2, `${String(bad)} → ${f.capacity.max}`);
  }
});

test('with no caller value the cap comes from the project config', () => {
  const { tickets, state } = readyBoard(3);
  const configured = inProject(projectWith(JSON.stringify({ pipeline: { max_concurrent_agents: 1 } })),
    () => computeFront(tickets, state, {}));
  assert.strictEqual(configured.capacity.max, 1);
  assert.strictEqual(configured.capacity.free, 1);

  // An ABSENT config is not an unreadable one: nobody has configured this yet,
  // which is the ordinary state of a new project, and the measured default is
  // the right answer there.
  const bare = inProject(projectWith(undefined), () => computeFront(tickets, state, {}));
  assert.strictEqual(bare.capacity.max, 4);
});

test('an unparseable config authorizes NO dispatch — the cap fails towards dispatching less', () => {
  // T-26-02's rule, applied to capacity: an invalid config permits no mutation,
  // and a dispatch is a mutation. The permissive reading — "fall back to the
  // default so the run keeps moving" — would let a wave out under a policy
  // nobody can read, which is exactly the direction a spend gate must never
  // fail in.
  const { ids, tickets, state } = readyBoard(3);
  const f = inProject(projectWith('{ "pipeline": '), () => computeFront(tickets, state, {}));
  assert.deepStrictEqual(f.capacity, { max: 0, in_flight: 0, free: 0 });
  // Still named, though: the cap truncates a wave, it never hides a ticket.
  assert.deepStrictEqual(f.actionable.execute, ids);
  assert.strictEqual(f.fixpoint, false);
  const line = capacityLine(f);
  assert.ok(/no policy is in effect/.test(line), line);
  assert.ok(!/0 in flight/.test(line), `"0 agents, 0 in flight" explains nothing: ${line}`);

  // …and the OPERATIVE line must say the same thing. deliver.md acts on the
  // fixpoint sentence, so the ordinary capacity wording here would order the
  // loop to collect agents that do not exist and recompute a board that cannot
  // change — a spin, on a board whose remedy is a person's.
  const fx = fixpointLine(f);
  assert.ok(/no policy is in effect/.test(fx), fx);
  assert.ok(/A person fixes the file/.test(fx), fx);
  assert.ok(!/collect the agents/.test(fx), `nothing is out to collect: ${fx}`);
});

test('the cap never turns an actionable board into a fixpoint, and never blocks an empty one', () => {
  // The invariant, and the reason the fixpoint FORMULA is untouched: the cap
  // moves nothing out of `actionable`, so `actionable_count > 0` still forces
  // NO on its own. A cap implemented as a filter would have flipped this.
  const { ids, tickets, state } = readyBoard(4);
  const all = Object.fromEntries(ids.map((id) => [id, 'executor']));
  const full = computeFront(tickets, state, { maxConcurrentAgents: 4, dispatched: all });
  assert.strictEqual(full.capacity.free, 0);
  assert.strictEqual(full.fixpoint, false, 'four agents are still out');

  // …and with nothing to dispatch, capacity is not a reason to keep a run alive.
  // Even a zero cap (an unreadable policy) leaves an empty board a fixpoint:
  // there is no wave to cut.
  const empty = inProject(projectWith('{ oops'), () => computeFront({}, {}, {}));
  assert.strictEqual(empty.capacity.max, 0);
  assert.strictEqual(empty.fixpoint, true);
  assert.strictEqual(capacityLine(empty), undefined);
});

test('formatFront survives a front written before capacity existed', () => {
  // `delivery-front.json` on disk outlives an upgrade, and formatFront is handed
  // whatever state-sync last wrote. An absent field must not throw.
  const { tickets, state } = readyBoard(2);
  const f = computeFront(tickets, state, { maxConcurrentAgents: 4 });
  delete f.capacity;
  const out = formatFront(f);
  assert.ok(out.some((l) => /^fixpoint: NO/.test(l)), out.join('\n'));
  assert.strictEqual(out.find((l) => /^capacity:/.test(l)), undefined);
});

done();
