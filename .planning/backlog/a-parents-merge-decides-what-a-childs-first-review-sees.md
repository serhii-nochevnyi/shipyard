# A parent's merge decides what the child's FIRST review is measured against

**Found:** 2026-09-08, with PR #50 (T-26-15) green + `conform` and the guard
answering `merge`, while T-26-03's executor was still working in a worktree cut
from that same parent branch.
**Scope:** none of the current tickets. It is an ordering rule the cascade
assumes and nothing enforces.

## The situation

In epic-stacked delivery a dependent ticket's PR is opened against its primary
parent's BRANCH, deliberately without waiting for the parent to merge. The
guard's merge gate (`sentinel.cjs mergeOne`) verifies the PR in front of it and
knows nothing about a child that has no PR yet. `state-sync.cjs:462` computes

    s.reapable = s.status === 'merged'
      && openFromBranch.length === 0 && openOntoBranch.length === 0;

and `openOntoBranch` counts OPEN PRs targeting the branch. A child still with an
executor has none, so it contributes nothing — to reapability, and to nothing
else either. The gate is right about its own subject and blind to this one.

## What it costs, and why it is about REVIEW rather than git

Merging the parent first is not a hard failure here: this repository has
`deleteBranchOnMerge=false`, so the parent branch survives the squash and a
later `gh pr create --base <parent branch>` still resolves. The reaper is the
only thing that deletes it, and it refuses while an open PR points at it.

The cost is what the child's first `arch-review` reads. After the parent
merges, `state-sync` recomputes the child's base to the EPIC, which now holds
the parent's work as a SQUASHED commit while the child's branch holds the same
work as its original commits. The merge base is therefore the pre-parent epic
tip, and the child's very first PR diff contains the parent's entire change on
top of its own. A judgment role then pays to read, and reason about, a diff
that was already judged and merged — and the child's `conform` verdict covers
content the child's author never wrote.

Open the child's PR FIRST and the same review is clean: the base is the parent
branch, the diff is exactly the child's slice, and the post-merge retarget plus
one `base-merge` round moves it afterwards — which is the documented cascade
cost this repo already accepts and already has a remedy for.

## Fix (unowned) — and it is NOT deferring the parent's merge

The first draft of this note argued for deferring the parent's `merge` until the
child had a PR, and the stop gate refused the run for leaving two actionable
items listed. Checking the premise under that pressure showed it was false, so
the correction belongs here rather than in a summary.

**The child's PR base is a choice, not a consequence.** `deleteBranchOnMerge` is
`false` on this repository, so a squashed parent's branch SURVIVES at exactly
the commit the child was cut from — verified after merging #50 and #51:

    e1ffc11  refs/heads/ticket/T-26-15-…
    d2cfb7c  refs/heads/ticket/T-25-02-…

`tickets.json`'s `pr_base` still names the parent branch; only
`delivery-state[id].base` is recomputed by `state-sync` after the merge. The
publish step passes a base to `gh pr create` explicitly, so the child's opening
diff can be measured against the parent branch whatever the board now says. The
parent's merge and the child's clean first review are therefore INDEPENDENT —
there was nothing to defer.

So the fix is a rule at the publish step, not a new deferral in the front:

- when a child's `pr_base` names a parent ticket branch that still exists on
  origin, open the PR against THAT branch even if the parent has since merged
  and `delivery-state[id].base` has moved to the epic;
- `state-sync` then reports the base as moved and the documented `base-merge`
  round retargets it — after `arch-review` has already judged the child's own
  slice;
- and if the parent branch is GONE (a repo with `deleteBranchOnMerge: true`, or
  the reaper ran), fall back to the epic and say so in the dispatch line, because
  there the inflated diff is unavoidable and the reviewer should know why it is
  reading work that was already merged.

That last branch is the one worth a test: the two repositories the conveyor
targets may differ in the setting, and the behaviour must not depend on which
one a reader happened to check.

## The residual risk, stated plainly

A child whose PR is opened against a merged parent branch carries commits that
reach the epic twice — once squashed, once original. Git resolves identical
content, but this is the same shape as the cascade conflicts that cost 3.9% of
one session's tokens. Measure it on the next such child before generalising the
rule above; it is written as a preference, not as a proven saving.
