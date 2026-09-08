# A cross-phase dependency is satisfied on main and never reaches the child's tree

**Found:** 2026-09-08, answering whether merging phase 24's epic would let the
integrator's finding be fixed in the next PRs.
**Scope:** none of the current tickets. It is a gap in the epic lifecycle, not
in any one script's logic.

## What happens

The conveyor knows a cross-phase parent must LAND on the default branch:
`state-sync.cjs` blocks the child with `cross-phase parent must land on main
first (phase N epic still ahead)`, and `deliver.md` says branches do not cascade
between phases. All of that is correct.

Nothing then brings that landing INTO the child's epic. `epic-branch.sh` has
`ensure`, `pr`, `status` and `retarget`; there is no command that merges the
base into an existing epic, and no step of `deliver.md` calls for one. An epic
is cut from the default branch once, at the start of its phase, and never learns
anything afterwards.

Measured on this repository, 2026-09-08, with three epics open at once:

    epic/25 behind main: 27 commits
    epic/26 behind main: 27 commits
    epic/26 contains baseMoved: 0 occurrences   (epic/24: 4)
    epic/26 contains reviewStandsAlone: 0       (epic/24: 3)
    epic/25 contains gate-trailer.cjs: absent   (phase 24 shipped it)

So the readiness rule and the worktree disagree. Once phase 24's epic lands on
main, `state-sync` will report T-26-15 and T-25-02 as READY — and their
worktrees, cut from `epic/26` and `epic/25`, will not contain the code those
tickets are written against. T-26-15's whole job is to write three fields that
two predicates read; in its own base, neither predicate exists.

## Why it is the expensive class

It is the same shape as the diamond-child defect already in this backlog
(`diamond-child-base-is-materially-incomplete.md`), one level up: a dependency
declared satisfied by a fact that does not reach the place the work happens. It
fails the same silent way — the executor writes something plausible, the scope
gate passes because it only measures paths, the did-work gate passes because
there IS a commit, and the defect surfaces later as code referring to symbols
its own base never had.

It also scales with the thing this repository does most: run several phases at
once. With one phase in flight it cannot happen.

## Shape of the fix (unowned)

`epic-branch.sh` gains a `refresh <epic> [base-ref]`: fetch, `git merge
origin/<base>` into the epic (never rebase — the epic has open PRs stacked on
it), push, and refuse with the conflicting paths rather than resolving. Then
Step 0 of delivery calls it for every epic in scope whose base has moved, and
`state-sync` reports `epic behind base by N` beside the existing
`epic … has N commit(s) but no PR` line, so the operator sees it before an
executor is dispatched into a stale tree.

The ordering constraint that makes it safe: refresh the epic BEFORE cutting any
ticket worktree from it, and never while a ticket PR is mid-merge — the git lock
`epic-branch.sh` already takes covers that.

One caution for whoever takes it: a refresh moves the base under every open
ticket PR in that phase, so each becomes BEHIND and needs its own base-merge
round. That is the documented cascade cost, not a new one, but it means a
refresh is worth doing at a phase boundary rather than continuously.
