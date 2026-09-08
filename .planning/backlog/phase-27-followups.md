# Phase 27 follow-ups

## The cap returns to 4 when the EPIC lands, not when T-27-01 did

`delivery_pipeline.max_concurrent_agents` was raised to 8 for this phase (user's
decision, 2026-09-08) because the cap counted dispatch RECORDS and a guard
holding four PRs filled a cap of 4. T-27-01's acceptance criteria said the value
returns to 4 "once this ticket has merged". Measured while delivering, that
sentence is wrong by one step:

```
main: AGENT_CARDINALITY occurrences = 0
epic: AGENT_CARDINALITY occurrences = 5
```

T-27-01 merged into `epic/27`, and the running conveyor executes
`plugins/delivery-pipeline/scripts/front.cjs` out of the PROJECT checkout, which
is on `main`. So the agent-shaped count is not in force for any session until the
epic's integration PR (#67) lands on the default branch. Until then a cap of 4
would still be a record count against a guard.

**Operator's first action after #67 merges:** set
`delivery_pipeline.max_concurrent_agents` back to `4` in `.planning/config.json`.

The general shape is worth keeping beyond this knob: **a conveyor change is in
force when it reaches the branch the conveyor RUNS from, not when its ticket
merges.** Every ticket in this phase changes the conveyor itself, so the same gap
applies to all of them — T-27-02's trailer carry, T-27-07's pin sweep and
T-27-03's merge gate are all merged into the epic and none of them governs this
session's own delivery.

## Two plan defects of my own, found by the executors

1. **T-27-01's plan listed `node --check plugins/delivery-pipeline/workflows/drift-gate.mjs`
   as a verification command.** It cannot pass: the Workflow runtime wraps the
   script body in an async function, so top-level `return` is legal there and
   `node --check` reports `Illegal return statement` by design — the file's own
   header says so. The executor narrowed the check to the wrapped form. Any future
   plan touching a `workflows/*.mjs` must not use a bare `node --check` on it.
2. **T-27-01's PR body claimed the test evidence "lives in `.shipyard-evidence.md`
   in this branch".** It does not: T-26-14 writes that file into the worktree as
   UNTRACKED scratch, so it is in no branch and no reader can follow the pointer.
   Caught by arch-review, wording fixed before the merge. The `prBodyGuide` this
   run passed did not say where the evidence must be QUOTED rather than
   referenced; it should.

## Copilot proposed a regression, and the guard proved it was one

Recorded because it is the counter-example to "bot review is advisory but usually
right". On T-27-03 Copilot flagged twice that `treeBlobs()` interpolates a
slash-containing ref into `git/trees/<ref>` without encoding. The guard checked
instead of complying: encoded and unencoded requests return byte-identical
responses live, and applying `encodeURIComponent(ref)` produces a live 404 and
5 smoke failures against the ticket's own suite, which passes 160/160 unencoded.
Answered on both threads with the evidence and resolved them, no code change.
`deliver.md`'s rule held exactly as written — "disagreement with justification is
a legal review-fix result, blind execution is not."

## CodeRabbit did not engage on any phase-27 PR

Across two guard rounds and five PRs (#63, #64, #65, #66, plus reinit retries),
CodeRabbit answered nothing; `reviewers.cjs reinit` reported "the previous one is
still unanswered — is it installed?" every time. Every review round in this phase
therefore rested on Copilot alone. That is a real narrowing of review coverage
and it is invisible unless someone reads the reinit output — worth a state-sync
`⚠` line of its own, so a phase does not silently ship with half its reviewers.

## The board offers a fix at a child whose failure is its parent's

Measured 2026-09-08, twice in one cascade. T-27-03's CI went red on one
assertion; T-27-04 base-merged that branch and inherited the identical failure
(`✗ a landed parent releases the child on both sides at once`, same single
assertion, runs 34268518770 and 34269493892). `front.cjs` then listed
`fix: T-27-04` as actionable, because failing checks outrank the
parent-still-open bucket.

Taking it would have been wrong twice over: it is the same failure a fixer is
already out on, and the remedy needs `front.cjs` and
`tests/unit/parent-moving.test.cjs`, which are in NEITHER child's
`files_modified` — so the second fixer would hit the exact wall the guard hit on
the first and burn an attempt to reach the same plan-defect verdict.

`parentIsMoving` does not cover this: the parent's base had not moved, so the
child was not deferred. What the board is missing is not a moving base but an
INHERITED failure — the child's red arrived through the merge base rather than
from its own diff. That is computable: the failing check's signature is
identical on both PRs, and `failure-signature.cjs compute` already produces the
hash that would say so.

Parked with `state-sync --parked T-27-04` for the session, which is the honest
channel (it holds only until the parent's fix lands, and it is nobody's
escalation), but a fresh session would re-offer it and dispatch blindly.

Worth its own ticket, and it belongs with T-27-06's family — the front saying
what it knows about itself. Shape: when a child's failing signature equals its
primary parent's, the child is `waiting: parent`, not `fix`, with a why that
names the parent's PR.

## `--parked` on `front.cjs` renders; only `state-sync.cjs` makes it stick

My own error, 2026-09-08, and the stop gate is what caught it — which is the
best possible evidence that the gate earns its place.

Both commands accept `--parked`:

```
front.cjs      [--json] [--parked <T,T>]     # renders a board
state-sync.cjs [--parked <T,T>]              # rebuilds AND WRITES delivery-front.json
```

I parked T-27-04 with the first one. The terminal showed exactly what I wanted —
`front: 0 actionable now` — so the park looked done. It was not: `front.cjs`
computes and prints, and the DURABLE board is written by `state-sync`. The stop
gate reads only `delivery-front.json`, so it still saw `fix: T-27-04` and
refused the stop, correctly, with the run's own rule quoted back at me:
"a parked item leaves the front; an ignored one does not."

The flag is identical, the printed answer is identical, and one of the two is a
no-op for everything that ENFORCES. `deliver.md` does say the front is
"re-runnable on its own" and that state-sync writes the file — but it never says
that parking through the renderer persists nothing, and the two invocations are
listed one line apart in the script list.

Cheap fix, and it is the same shape as this phase's other findings: have
`front.cjs` say what it did. When `--parked` is passed to the renderer, print
one line — `parked: T-27-04 (this render only — `state-sync --parked` writes the
board the stop gate reads)`. No behaviour change, and the trap stops being
invisible.
