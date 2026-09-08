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

## Fix (unowned)

Give the front and the guard the one fact they lack: a parent whose child is
not merged and has no PR yet, while that child is `waiting.dispatched`, should
have its `merge` DEFERRED rather than offered. Concretely, as a shared
predicate of the shape `checkpointParent` already has, and for the same reason
(the board must never offer what the guard would regret):

    childWithNoPrYet(parentTicket, tickets, state)
      -> any ticket whose primary_parent is this one, whose status is not
         merged, and which has no PR — with `waiting.dispatched` making it
         imminent rather than hypothetical.

Then `merge` routes to a `waiting.parent`-style deferral with a `why` that
names the child, and the guard's duty says the same, so the two cannot
disagree. It must be a DEFERRAL and never a park: nobody owes work, and it
lifts by itself the moment the child's PR appears.

One caution for whoever takes it: the deferral must not outlive the child's
dispatch. A dispatch record expires after 90m, and an executor that dies would
otherwise hold a parent behind a PR that will never open — so the condition has
to read the LIVE dispatch overlay, not the ticket's static graph position.

## What was done in the meantime

The merge of #50 was held until T-26-03's PR existed, by hand and with the
reason stated. That is a sequencing choice inside the window the gate already
permits, not an override of it — but it is exactly the class of rule this
repository has learned prose cannot hold, which is why it is written down here
as a ticket rather than remembered.
