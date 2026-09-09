# The project checkout itself can become the stale `.planning/` copy

Measured 2026-09-09, at phase 28's fixpoint, and it is the same root as
`scope-gate` answering from a worktree — one level up, where it is worse.

## What was found

The project checkout `/Volumes/KINGSTON/claude-shipyard` was sitting in
**detached HEAD on the epic tip**, not on `main`:

```
current branch:  (empty)
HEAD:            fa98670   ← origin/epic/28-…
main:            e44537c   == origin/main
```

`git reflog` names the cause without ambiguity:

```
HEAD@{0} checkout: moving from main to origin/epic/28-a-mechanism-…
HEAD@{1} commit: backlog: on Codex the -deep variants became unreachable…
```

So it happened AFTER the orchestrator's last commit, and the only thing running
at that moment was the phase-28 integrator, which reads the epic diff. The
phase-27 integrator made its own scratch worktree and said so ("Scratch worktree
removed"); this one moved the project's own HEAD instead.

**Nothing was lost.** All ten of the session's commits are ancestors of `main`,
`main` equals `origin/main`, and the detached HEAD carried zero unique commits.
Restored with a `git checkout main` after stashing the runtime graph files.

## Why it is a live hazard rather than untidiness

Because the conveyor resolves `.planning/` from the current directory —
`CLAUDE.md` states that `pipeline-config.cjs` "reads `<cwd>/.planning/config.json`
exactly and never walks up" — a detached epic checkout IS a second, older copy
of the declarations, and every graph tool would have believed it. Measured, in
that checkout against `main`:

```
28-06-PLAN.md mentions of the adopted `effort_applied` item:   0   (main: 3)
backlog notes present:                                        29   (main: 33)
```

The epic was cut before those plan amendments, so a `validate-graph.cjs` run
from there would have regenerated `tickets.json` from stale plans — dropping,
among others, the `tests/unit/stop-gate.test.cjs` entry that T-28-01's own
amendment added because its rule breaks that file. Exit 0, no warning, and the
next `scope-gate` would then have refused correct work as out of scope.

## Why this one is worse than the worktree case

`.planning/` being tracked means a live phase has one copy per checkout. Two
instances were already recorded this phase and the last: a gate run from a ticket
worktree reads a FROZEN declaration and calls correct work out of scope; a plan
amended on a ticket branch is INERT because the gates read the project. Both are
about a SIDE checkout being wrong.

This is the PROJECT checkout being wrong — the one every script trusts by
default, the one the stop-gate hook resolves by "newest `generated_at` among the
repository's worktrees", and the one an operator would never think to check.

## Fixes, cheapest first

1. **A tool that reads the graph should say which HEAD it read it from.** The
   same move as `base-merge`/`scope-gate` printing the base ref they measured:
   one line naming the branch (or `detached at <sha>`). A silently substituted
   declaration is a new invisible behaviour, and this phase now has three
   instances of it in three different directions.
2. **`validate-graph.cjs` should refuse, or at minimum warn loudly, on a
   detached HEAD.** Regenerating the machine view of the graph from a checkout
   that is not on the integration branch has no legitimate use this repository
   has found; a refusal there costs nothing and closes the case above.
3. **`references/integrator.md` should require a scratch worktree** rather than
   leaving it to the agent's judgement. Phase 27's integrator did it unprompted
   and phase 28's did not, which is the definition of a rule that is not in
   force. It is also exactly the shape of finding ADR-007 is about: the
   instruction exists as a habit, not as a mechanism.

Also noticed while checking: a scratch worktree from earlier in the session
(`scratchpad/epic25-bump`, on `epic/25-…`) is still registered. It sits outside
the pipeline's worktree root, so `ticket-worktree.sh gc` does not count it and
will never mention it — worth one line in that script's own classification, or
it accumulates invisibly across sessions.
