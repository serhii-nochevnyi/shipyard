# ADR-002 — The conveyor stops interrupting itself

- **Status**: accepted
- **Date**: 2026-09-04
- **Supersedes**: nothing. Extends ADR-001 (verdicts, not effort) and the rule
  recorded in `CLAUDE.md`: prose rules get skipped, mechanical gates hold.

## Context

Phases 20–23 made the night survivable: signatures, verdicts, a dispatch state,
a stop gate that asks the run rather than the clock, a foreground CI waiter.
A full read of the resulting implementation (2026-08-30, against the v0.45.0
code and the pdffiller proving-ground journals) found that the remaining
interruptions are no longer missing mechanisms. They are mechanisms that
disagree with each other about the same fact, or that decide from a datum that
was never the right one. Seventeen findings, in two families.

**The run interrupts itself** (A1–A10):

- A1/A8 — the dispatch record and the escalation park both expire through
  `escalation-record.fingerprint`, which hashes the CI tallies. Every finished
  check therefore lifts a guard's dispatch and every retarget-triggered CI
  re-run lifts a human's park. The front re-offers work that is in flight, the
  stop gate blocks over it, and a PR a person was asked to judge is re-dispatched
  to review-fix.
- A2/A3 — `stop-gate.cjs` blocks once per turn (`stop_hook_active`), while a
  stacked cascade needs one round per ticket; and `movedSince` counts journal
  events of any age, so a global hook blocks the first stop of every later
  session in a repository whose last run ended on a merge.
- A4 — `sentinel.cjs` answers `wait-parent` for a child whose parent is still
  moving; `front.cjs` has no such bucket and files the child under `finalize`.
  `ci-wait.cjs` then refuses (something is actionable), the stop gate blocks,
  and the guard declines the work the front offered. `deliver.md` documents a
  `waiting.parent` bucket that does not exist.
- A5 — a dispatch is marked BEFORE the agent is launched, so a launch that never
  happened is a 90-minute hole the stop gate's `dispatched` hatch walks through.
- A6/A7 — `computeVerdict` declares `plan_defect` at K distinct signatures
  without checking that no green separated them (the file header claims it
  does), and counts `unknown` as distinct; the attempt counter lives only in the
  session, so `attempts > max` restarts at 1 in every resumed run.
- A9 — `ci-wait.cjs` cannot tell a stalled pipeline from an unreachable `gh`,
  clears every ticket's empty-window record when any PR settles, and escalates
  after 3×15 min regardless of the CI's observed length.
- A10 — `CHANGES_REQUESTED` with zero unresolved threads dispatches review-fix,
  which has nothing to resolve, until the attempts run out.

**The run lands the wrong thing** (Б1–Б7):

- Б1 — the `gate_status: arch-review=conform` trailer is not bound to a head:
  a review-fix push after undraft keeps the verdict of a diff that no longer
  exists.
- Б2 — three scripts classify check states by three hand-written lists; the
  states outside them (`WAITING`, `REQUESTED`, `STALE`, `STARTUP_FAILURE`, and
  `ACTION_REQUIRED` in two of the three) read as green.
- Б3 — `none_reported` is green in `front.cjs`, so a PR with no CI auto-merges.
- Б4 — `reviewers.cjs feedback` returns a bot's whole comment history and
  `changes_requested` is `some()` over every historical review.
- Б5 — `gh pr merge --squash` runs without `--match-head-commit`.
- Б6 — a squash-merged stack re-runs full CI once per child (design cost, not
  a defect).
- Б7 — a DIRTY/BEHIND refusal names no owner and no bucket; the fix-round
  workflow has no `needsBaseMerge`, so the remedy the references document is
  reachable only by prose.

Plus six places where prose and code contradict each other (front.cjs:627
sanctions `--watch`; pr-sentinel.md step 4 tells the guard to `--watch`;
failure-signature.cjs:27 vs :292; the `allowed` merge set spans every phase in
the repo; children are retargeted from cached state; `waiting.parent`).

## Decision

- **D1 — A record is lifted only by a fact its OWNER moves.** Three stores
  expire against "the PR moved", and they need three different meanings of it.
  A guard's dispatch ends when the guard's OUTPUT exists (a push, a merge, a
  draft change, a base change) — never when CI ticks. A human's park ends when
  the HUMAN's fields change (review decision, draft, head). Only `ci-wait.cjs`
  is legitimately interested in check tallies, because a tally change is the
  event it waits for. One store, one fingerprint; the shared hash is retired
  from every consumer that was wrong to use it.
- **D2 — The stop gate blocks as often as the cascade needs, and never for a
  run that has ended.** `stop_hook_active` caps one block per TURN; the cascade
  needs one per ROUND, so the gate keeps a per-session ledger and re-blocks
  when the board advanced since its last block, under a hard cap. Journal
  evidence of a moved world counts only when it is younger than the resync
  ceiling. A dispatch that has outlived a plausible launch is not an agent at
  work and does not open the CI-only hatch.
- **D3 — One vocabulary for check state, from gh's own `bucket`.** `gh pr
  checks --json bucket,state` already classifies every state into
  pass/fail/pending/skipping/cancel. One module reads it; every consumer
  imports it; anything unclassified is pending, never green.
- **D4 — Every wait the guard imposes is a bucket the front knows and an owner
  the loop can name.** `parentIsMoving` moves out of `sentinel.cjs` into a
  module both scripts import; the front gains `waiting.parent`; the CI waiter
  watches the parent's PR when that is what the child is waiting for; a
  DIRTY/BEHIND base is a `base-merge` duty with a workflow flag, not a refusal
  with no address.
- **D5 — A gate verdict is bound to the head it judged.** The trailer carries
  `head=<sha>`; `state-sync` records `head_sha`; a trailer whose head is not
  the PR's current head is absent for `duty`, `merge` and the front alike. One
  script writes the trailer, so no prompt assembles it by hand.
- **D6 — Merge verifies what the cache cannot know.** No reported checks is not
  green — it is `merge_human`. The merge pins the head it verified
  (`--match-head-commit`). The stack is the PHASE's stack, not every ticket
  branch in the repository. Children are retargeted from live PR data, not from
  the last sync.
- **D7 — Review feedback is the CURRENT state, and a verdict with nothing to
  resolve belongs to a person.** Bot comments count from the last push; the
  review decision is the last state per reviewer; `CHANGES_REQUESTED` with zero
  unresolved threads routes to `waiting.human`, not to review-fix.
- **D8 — `plan_defect` requires K distinct signatures with NO green between
  them, and the attempt counter survives the session.** The distinct window
  resets on a green or a merge; `unknown` never counts as distinct;
  `attempt-history.cjs --json` reports `next_n` so the ladder and the backstop
  read one number.
- **D9 — The CI waiter distinguishes a stall from an outage, keeps per-ticket
  records, and sizes its window from the observed CI.** A `gh` failure is not an
  empty window; a settle clears only the settled ticket's record; the window
  defaults from `ci_estimates` when the front carries them.
- **D10 — Prose names only what the scripts implement.** Every contradiction in
  the list above is removed from the side that is wrong; the dispatch mark
  follows the launch, not precedes it.
- **Deferred — Б6.** Squash-stacking's per-child CI round is a design cost this
  ADR records and does not pay: the alternative (`--merge` for children, or
  retargeting to the epic after the first green) changes the shape of the
  history every downstream reader depends on. Revisit with field data on the
  proving ground's CI wall time per cascade.

## Consequences

Ten tickets, one phase. Everything that touches `sentinel.cjs`/`front.cjs`
lands as one stacked chain because those two files are the seam every finding
crosses; the three stores, the stop gate and the CI waiter land beside it.
Every ticket ships a unit test in `tests/unit/` that fails on the current code.
The conveyor's tick rate is untouched: no change adds a `gh` call to the bulk
sync window except one scalar (`headRefOid`).
