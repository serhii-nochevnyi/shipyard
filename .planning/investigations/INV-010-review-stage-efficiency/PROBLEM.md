---
status: open          # open | closed — Gate 1 sets `closed`
closed:               # YYYY-MM-DD, filled in at Gate 1
adr:                  # path to .planning/architecture/ADR-NNN-*.md, filled in at Gate 1
---

# Problem — review-stage efficiency in cascaded PRs

## What we are solving

Decide when, on what input, and how often the conveyor launches a model review of a ticket PR, so that a review is not spent on a state that the cascade is about to invalidate. The review in scope is the architecture review (`arch-review`); the integrator is included only where its input overlaps a ticket review. Four questions need a decision:

- **When a review launches.** After green CI, after the ticket's base has stopped moving, or once per stack.
- **What a review judges.** The ticket's own diff or the whole PR against its current base.
- **When a verdict carries or is reused.** Carry across a base move and reuse on an identical input.
- **Whether model and effort follow diff size.** Chosen per diff size or kept fixed.

## For whom

Operators running `/shipyard:deliver` on Claude Code and Codex subscriptions, both in this repository and on target projects with epic-stacked cascades.

## Current pain

- **Phase 44 (8 tickets).** Nine architecture reviews ran for eight merged PRs. Each sibling squash-merge moved the epic, so every remaining sibling needed a base merge, a fresh CI run and a full re-review (INV-008 intake N54). Reviews were about 11% of the phase's child-run consumption, and the orchestrator re-read every result.
- **Phase 43.** Base merges that only brought in already-judged sibling squashes discarded the verdict seven times, about 23 architecture-review launches for 13 tickets (T-43-13 plan, D-03).
- **Environment failures.** A reviewer's sandbox `EPERM` before any assertion produced a blocking `violation` despite green exact-head CI, and the only way forward is another full review (N57).
- **Draft PRs.** The Claude arch-review host refuses a draft PR, while the command undrafts only after a `conform` verdict, so the order in `deliver.md` does not work (N46).
- **Integrator.** The integrator re-judged a combined diff whose tickets were each already reviewed, and three of four results were refused on an identity field (N44).

## What success will be

- In an epic-stacked cascade, the phase averages no more than about one architecture-review launch per merged ticket (today 1.1–1.8). Repair rounds that follow a real `violation` are counted separately and stay allowed.
- No gate is weakened: exact-head CI, `merge-gate` conform bound to the reviewed head, unresolved-thread and human checkpoints, and a fresh review whenever the ticket's own change or its governing inputs change.
- Both runtimes are covered: the Claude role host and the Codex delivery host follow the same rules on their own native grids.
- Any saving is shown by the phase-44 observation data on matched cohorts, not by a promised percentage.

## What is definitely out of scope

- A change to the ADR-014 model grids made by this investigation. Model and effort by diff size may be studied as an option, but adopting it needs a separate ADR-014 amendment and an approved experiment (ADR-021 effort-experiment protocol).
- Removing or sampling architecture review, auto-merging `human_checkpoint` tickets, or accepting a verdict for a head it did not judge.
- Re-deciding what is already accepted: the ADR-020 own-diff carry (T-43-13) and the ADR-021 exact-input reuse (phase-45 C1). They are inputs, and this investigation fixes only how they combine with launch timing.
