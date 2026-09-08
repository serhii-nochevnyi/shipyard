# drift-gate takes ONE baseRef while a cascade gives every ticket its own

**Found:** 2026-09-08, dispatching the drift judges for T-26-03 and T-25-03.
**Scope:** none of the current tickets. It is a gap in the workflow's args
contract, one level below the defect T-26-13 fixed.

## What happens

`workflows/drift-gate.mjs`'s args contract is:

    tickets: [ { id, planPath, model, effort } ],
    baseRef: "origin/<git.base_branch>",   // one value for the whole run

One `baseRef` for every ticket in the run. In epic-stacked delivery that is
wrong by construction: a root ticket's base is the phase epic, a dependent
ticket's base is its primary parent's BRANCH, and two tickets selected in the
same round routinely have different bases. Here T-26-03's base was
`ticket/T-26-15-…` and T-25-03's was `ticket/T-25-02-…`, in different phases.

Passing the default `origin/main` for both would have been worse than useless:
every commit on the two epics would read as movement "since the plan was
written", so the judges would be handed a diff dominated by work the ticket is
deliberately stacked on top of. The run was therefore split into two workflow
invocations, one per base — correct, and one more agent-dispatch round than the
board needed.

## Why it is the same class as T-26-13

T-26-13 fixed the question "is a drift check needed at all" by judging against
**the ticket's own base** rather than against the default branch. The judge that
runs afterwards still takes a single global base, so the deterministic pre-gate
and the judge it gates can be measuring different things. `drift-needed.cjs`
already resolves the per-ticket base from `delivery-state[id].base` — the value
the workflow needs is computed and available at the call site.

## Shape of the fix (unowned)

Move `baseRef` INTO the ticket entry (`tickets: [ { id, planPath, baseRef,
model, effort } ]`), keeping the top-level value as the fallback for a run whose
tickets do not carry one, so no existing caller breaks. Then Step 2 of delivery
builds it from `delivery-state[id].base` exactly as it builds `worktreePath` and
`prBase` for the executors, and one invocation covers a mixed-base round again.

Worth doing together with the executor-side rule already recorded in
`a-cross-phase-dependency-never-reaches-the-childs-tree.md`: both are the same
sentence — a per-ticket base is a fact the board holds, and every dispatch that
needs it should read it there rather than be handed one value for all.
