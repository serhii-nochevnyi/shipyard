# `log-event` does not refresh the front; `dispatch-record` does — and the loop must know which

**Found:** 2026-09-08, by the stop gate firing on a board seven minutes old
after a push it had every right to call fiction.
**Scope:** none of the current tickets. It is a sentence missing from
`deliver.md`'s main-loop contract, plus one cheap guard.

## What happened

The main loop's cheap way to re-read the board is `node front.cjs`, which
recomputes the buckets from `delivery-state.json` — the CACHED state. Only
`state-sync.cjs` re-derives that state from GitHub.

Two writers sit either side of that line and nothing says so:

- `dispatch-record.cjs mark|clear` calls `refreshFront`, so the overlay it
  writes IS reflected by a following `front.cjs`. Reading the front straight
  after a mark is correct, and the loop does it constantly.
- `log-event.cjs attempt … outcome=pushed` writes only the journal. The world
  moved — a push re-runs checks, and after a merge it retargets children — and
  the cached state knows nothing about it. A following `front.cjs` then reports
  buckets computed before the push.

Having done the first correctly a dozen times in one session, the same shape was
applied to the second: journal the push, resolve the review thread, read
`front.cjs`, conclude "0 actionable". The conclusion happened to be right, and
was not derived from anything real.

**The stop gate caught it, by exactly the rule it was built with**: a
`merge`/`attempt … pushed` timestamped after the front's `generated_at` is proof
the board is behind reality, whatever its age. It named the event, the ticket and
the timestamp. This is the mechanism working as designed — worth recording as
evidence FOR the journal-evidence rule, which was added because an age-based rule
went silent at the moment its answer mattered.

## The rule

**Any writer that moves GitHub obliges a `state-sync` before the front is read
again.** Concretely: a push, a merge, a thread resolve, an undraft, a PR open.
Dispatch marks are the exception, and they are the exception because
`dispatch-record` refreshes the overlay itself.

## The guards worth having

- **In `front.cjs`:** it already loads `delivery-state.json`; have it read the
  journal's tail the way `stop-gate.cjs` does and print one line —
  `⚠ a merge/push is journalled after this state was derived; run state-sync` —
  when the board it is about to print is provably behind. The stop gate proves
  this is computable in a ~75ms budget, and the front is the thing the loop
  actually reads.
- **In `deliver.md`:** state the pairing where the loop meets it, in the step
  that journals an attempt, not in a principles section. One sentence: after
  `log-event.cjs attempt … pushed`, the next board read is `state-sync.cjs`,
  never `front.cjs`.

Note what NOT to do: making `log-event.cjs` refresh the front itself would be
wrong. It is deliberately a dumb append-only writer that several roles call from
worktrees, and a front refresh from a worktree cwd is the class of defect
`graph-dir.cjs` exists to prevent. The obligation belongs to the loop, and the
warning belongs to the reader.
