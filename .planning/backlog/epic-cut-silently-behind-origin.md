# epic-branch.sh ensure: warn when the local base is ahead of origin

**Found:** 2026-08-25, during the first `/shipyard:deliver` run on this repo.
**Scope:** none of phase 20's tickets — do not smuggle it into one.

## What happened

`epic-branch.sh ensure` cuts the epic from `origin/<base>`. That is correct by
construction: the epic's PR base lives on origin, so cutting from a local ref
would publish a branch nobody else can see the history of.

But it is SILENT when the local base is ahead. On this run `main` was 6 commits
ahead of `origin/main` — the whole GSD-project bootstrap and the decomposition —
so the epic was cut without them, and every ticket worktree came up with no
`.planning/phases/` at all. The executors would have had no plans to read.

Nothing was wrong with the script's rule. What was missing is the sentence it
never said.

## Fix

In `ensure`, after the fetch and before creating the branch:

    git rev-list --count origin/<base>..<base>

Non-zero → say it, loudly, naming the count and that the epic will NOT contain
those commits. Whether it should refuse or merely warn is a judgement: refusing
is safer, warning is kinder to a run that deliberately cuts from a published
base. Leaning refuse, with the message naming `git push origin <base>` as the
remedy — a phase cut off a stale base is expensive to discover later, and this
run discovered it only because a worktree happened to be inspected.

Same principle as `base-merge`/`scope-gate` printing the ref they measured: a
silently substituted base is a new invisible behaviour.
