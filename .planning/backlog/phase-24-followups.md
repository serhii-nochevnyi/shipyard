# Phase 24 follow-ups

## front.cjs still calls computeFront "pure" after the lazy config read (T-24-05, #44)

Found by arch-review on PR #44; left unfixed there on purpose — amending one
sentence would have meant a new head, a stripped `gate_status:` trailer and a
second fable-tier re-judge.

`front.cjs` (the comment above the `ci_estimates` option) says computeFront "is a
pure function over its inputs and reads no file". Since T-24-05 the lazy
`merge_without_ci` resolver ~40 lines above it can read `.planning/config.json`.
The rule the sentence encodes is still the right one — the resolver is lazy, and
it resolves the PROJECT through `graph-dir.cjs` rather than a cwd — but the
sentence as written is now false, and this repo's own standing lesson is that
prose contradicting the code teaches the reader to ignore the code.

Two amended sentences: say that the ONE file the function may read is the
project config, only when a no-CI PR is actually on the board, and only through
`graph-dir.cjs`.

`tests/unit/front.test.cjs`'s purity test is a source regex over
`computeFront.toString()`, so it cannot see the indirect `loadConfig` read and
passes without measuring it. Either narrow what it claims to check, or measure
the read the way the "reads it ONCE" tests already do (they spy on
`cfgMod.loadConfig`).

## pr-sentinel.md lists two human-merge causes; there are now three (T-24-05, #44)

`references/pr-sentinel.md`'s `human`/`human-merge` entry names a
`human_checkpoint` ticket and a PR targeting the integration branch. T-24-05
added a third: a PR where NO checks reported, held unless
`merge_without_ci` says the repo has none. Incomplete rather than contradictory.
Outside T-24-05's `files_modified`; T-24-07 owns pr-sentinel.md but its own
`files_modified` was written before this cause existed.

## The board's D4/D7 half is inert: nothing emits merge_state, behind_by or unresolved_count (T-24-06, #45)

Found by arch-review on PR #45. Not a defect in that PR — Gate 2 kept it out of
`state-sync.cjs` — but the phase ships a half-connected feature.

`computeFront` reads three fields to file a PR under `fix` (a moved base) or
`waiting.human` (CHANGES_REQUESTED with no unresolved thread):

  * `s.merge_state`      — GitHub's `mergeStateStatus`
  * `s.behind_by`        — the `gh api compare` count
  * `s.unresolved_count` — the review-thread count

`state-sync.cjs` writes NONE of them; it writes only `review_decision`
(verified with `grep -a`). No plan in phase 24 declares emitting them — 24-02,
24-04 and 24-11 own state-sync.cjs and none of them does this.

Consequence on the real board: `sentinel.cjs duty` reads these facts LIVE per PR
and answers correctly, while `delivery-front.json` still files a BEHIND PR as
`merge` and a CHANGES_REQUESTED-with-no-threads PR as `finalize`. That is the
board/guard disagreement the shared predicates were introduced to prevent,
reappearing one layer below them — and it is the shape the stop gate turns into
a false block (the board offers what the guard declines).

The predicates themselves are right and need no change: the two readers agree
the moment the fields are fed. What is missing is the feeder, and it has a hard
constraint the ADR already recorded: `mergeStateStatus` and thread counts must
ride the OPEN-only pass, never the bulk `gh pr list` window. That is the
`reviewDecision` lesson — the same 1000 rows cost 41s with it and 7s without,
and state-sync's wall time is the conveyor's tick rate.

Also front.cjs's own prose already names `unresolved_count` as "state's", which
is true of the reader and not yet of the writer.

## From the integrator, 2026-09-07 (verdict `needs-fix` on epic head `35de683`)

The load-bearing finding became **T-26-15** — `state-sync.cjs` writes none of
`merge_state`, `behind_by` or `unresolved_count`, which two of T-24-06's shared
predicates read. Two smaller ones stayed here because they are prose and
comments with no behavioural bite of their own:

**F3 — two comments name a fix that landed before them.** `front.cjs:428` and
`ci-wait.cjs:235` both assign the stop gate's `waiting.parent` half to T-24-09,
which landed FIRST. The gate still reads `waiting.ci` alone. The integrator's
warning is the useful half: that omission is currently LOAD-BEARING, because
`ci-wait` returns instantly on an already-green parent and depends on the gate
letting such a board end. So fix both comments or delete both forward
references — fixing one alone changes behaviour nobody asked to change.

**F4 + F5 — the base-merge duty cannot be dispatched through the Workflow
path.** `deliver.md`'s Workflow dispatch never passes `needsBaseMerge` or the
base, so the argument T-24-06 added to `fix-round.mjs` has no caller. And the
`base_merge` journal event has a writer contract and a docs-smoke exemption
claiming the script "journals itself", with no caller anywhere either. Both are
`deliver.md`'s, which phase 25's chain owns.

**Not run by the integrator, owed before a release:** `make test-codex-shipyard`
and the container targets. `deliver.md` gained paragraphs contrasting the
Workflow and Agent paths, and the Codex generator rewrites the word "Claude" in
prose, so the generated `SKILL.md` must be re-read after regeneration.

**A sweep hazard for whoever re-checks this:** `state-sync.cjs` carries a
deliberate NUL byte at `epicKey`'s separator, so plain `grep` SILENTLY SKIPS it.
Any repeat of these seam sweeps needs `grep -a`, or the one file that decides
what the board can know drops out of the results without a word.
