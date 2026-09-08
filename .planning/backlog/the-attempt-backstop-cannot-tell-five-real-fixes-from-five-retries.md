# The attempt backstop cannot tell five real fixes from five retries

Measured 2026-09-09 on T-27-08 (PR #71), which reached 4 of `max_attempts: 5`
while never once repeating itself.

## The record

```
attempts=4 next_n=5
n=1 role=ci-fix     signature=2570b45482b75a7e head=0d2e216 outcome=pushed
n=2 role=review-fix signature=none              head=a10cf41 outcome=pushed
n=3 role=review-fix signature=none              head=d6ea7ae outcome=pushed
n=4 role=review-fix signature=opus…2b16fef      outcome=pushed
```

Four pushes, four different heads, four DISTINCT and independently verified
findings, each with its own mutation check:

1. the inherited base-drift base-merge (the only one with a CI signature);
2. `NUMERIC_KNOBS` in a test claiming to be read from the module's defaults while
   being a separately hand-typed literal — real drift risk, fixed by exporting
   the one array;
3. two `front.cjs` config-refusal sentences saying "nothing may be merged" while
   the same board can still offer `waiting.merge_human`, a human's manual merge
   the refusal never withholds;
4. `gsd-tune.cjs`'s `CONFIG_REFUSAL` check ordered AFTER the empty-drift
   `process.exit(0)`, so a machine whose global defaults already agreed printed
   the refusal and exited 0.

That is healthy convergence — a reviewer finding something real each round on a
ticket that touches four config readers. The counter treats it identically to
four attempts at the same wrong hypothesis, and one more finding would exhaust
the budget on a PR that has never been red for the same reason twice.

## Why the mechanism that CAN tell them apart never sees these rounds

Phase 24 replaced attempt-based routing for exactly this reason. `deliver.md`
says it outright: "A repeat escalates the STRATEGY, not the tier... `--attempt`
and `--previous-failed` no longer route a repair tier. What routes it is
`--signature-state`, whose verdict comes from `failure-signature.cjs verdict`."
The verdict distinguishes `first` / `progress` / `repeat` / `flake_candidate` /
`plan_defect` — precisely repetition from progress.

But a signature is computed from a FAILING CI LOG. Three of these four rounds
have `signature=none` because they came from REVIEW THREADS, not from a red
check. So the mechanism built to tell repetition from progress is structurally
blind to the rounds that are consuming the budget, and the crude counter it was
built to replace is the only thing still governing them.

The attempt backstop is deliberate and must stay — `deliver.md` names the case
it exists for ("a signature that oscillates between two values is never the same
as the last one, so it never reads `repeat`... it dodges both rules and nothing
else would ever stop it. This is not dead code — do not remove it"). The gap is
not that the backstop exists; it is that a review round is charged against it
with no way to be judged by it.

## Shapes worth considering, none of them free

- **Sign a review round the way a CI round is signed.** A thread's identity
  (file + rule + the reviewer's own comment id) is available and stable, so
  `failure-signature.cjs` could compute a signature for a review finding too.
  Then `verdict` sees every round, a genuinely repeated thread reads `repeat`,
  and four distinct findings read `first` four times. This is the fix that
  matches the existing design rather than working around it.
- **Do not charge a round whose finding is NEW.** Cheaper, and weaker: it needs
  the same identity to decide "new", so it collapses into the first shape.
- **Raise `max_attempts` for a ticket touching N independent readers.** Rejected
  as a knob that hides the question — the count is not the problem, the blindness
  is.

Do NOT simply exempt `review-fix` from the counter. A reviewer can loop as
readily as a fixer, and this repository has already recorded one Copilot
suggestion that was a regression and was correctly refused rather than complied
with; an unbounded review loop is exactly what the backstop is for.

Related: [[a-clean-merge-can-duplicate-a-block-two-branches-added-alike]].
