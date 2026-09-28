---
status: accepted
---
# ADR-022 — review-stage-efficiency

- **Status:** accepted
- **Date:** 2026-09-28
- **Decision owner:** repository maintainer; decisions taken in the INV-010 dialogue
- **Scope:** architecture-review launch timing, draft handling and review telemetry in epic-stacked cascades, on both runtimes. Planned into phase 45 after the phase-43 epic reaches main.
- **Supersedes:** none
- **Related:** ADR-014, ADR-020, ADR-021
- **UI design:** none

## Context

[INV-010](../investigations/INV-010-review-stage-efficiency/) found why architecture reviews go stale in cascades:
- **Every sibling is reviewed as soon as it is green.** The guard offers `arch-review` to every green sibling in the same tick, with no merge-candidate ordering (`sentinel.cjs:600-789`).
- **The installed carry never fires in a cascade.** It requires the head and base trees to be unchanged (`gate-trailer.cjs:494-498`, `:563-568`), so a sibling squash that moves the epic always forces a fresh review. The T-43-13 own-diff carry (ADR-020) and the C1 exact-input reuse (ADR-021) are accepted but not built.
- **Drafts are refused.** The guard sends green drafts to review, and the Claude host refuses them (N46).
- **The metric cannot be computed.** The tracked journal holds no review rows for phases 40–44.

Measurements:
- **Phase 44 (Claude):** 9 reviews for 8 merged PRs. The only extra review was a base move that T-43-13 covers. The phase stayed near one per ticket because siblings were finalized one at a time.
- **Phase 43 (Codex):** 11 reviews on 4 tickets. The repeats come from real violations, repairs and a sandbox `EPERM` (N57).

## Decision

- Architecture review in an epic-stacked cascade combines the accepted ADR-020 identity carry and ADR-021 exact-input reuse with disjoint-aware merge-candidate gating; the precedence is exact-input reuse, then identity carry, then a fresh launch, and a carried verdict is never a reuse source.
- `sentinel.cjs duty` and `front.cjs` keep offering ci-fix, base-merge and review-fix to every sibling but offer `arch-review` only to the next merge candidate or candidates per base, ranked deterministically by depth, unlock count and ticket id; other green siblings get a non-actionable `wait-turn` state.
- A sibling may be reviewed before its turn only when its `files_modified` do not overlap those of any open sibling ranked ahead of it, with overlap read from the graph ownership matcher and never from judgement.
- A ranked candidate that waits on a person (a `human_checkpoint`, `wait-human`, or `CHANGES_REQUESTED` with zero unresolved threads) releases its siblings under the same exception `wait-parent` already has.
- The Claude arch-review host reviews a draft PR: `isDraft` is recorded as an input and enters the ADR-021 reuse manifest, head and branch identity stay strict, and undraft stays unreachable without a conform verdict.
- The integrator keeps judging the full combined phase diff as the architectural interaction check; its `base` identity defect (N44) is fixed before any reduction of its scope is considered.
- Every arch-review launch, reuse, carry, re-owe and environment-only adjudication is journalled with ticket, head, base tree and a cause of `first`, `after-violation`, `after-base-move`, `after-input-change` or `environment`.
- The metric "arch-review launches per merged ticket" counts `first` and `after-base-move` launches; repairs after a real violation and environment adjudications are reported separately, cohorts are keyed by runtime, siblings per epic and stack depth, and results stay `inconclusive` without matched cohorts.
- Drift-check follows the same merge-candidate timing as architecture review.
- The duty-layer gating and the carry apply to Claude and Codex alike; host-side draft handling and reuse are built for the Claude role host first, and the Codex equivalent is a named gap until Codex has an identity-checking arch-review host.

## Consequences

- In an epic-stacked cascade the conveyor now reviews a ticket about once, on the base it will merge into, instead of once per sibling merge. Overlapping siblings are serialized, and disjoint ones still review in parallel.
- Tail siblings with overlapping files wait longer. This is measured as wall time and sentinel rounds per merged ticket, and a treatment that lowers reviews but raises total consumption fails.
- The gating, the draft input and the journalling touch files owned by phase-45 R3, D1, R13 and C1 and by T-43-13. The phase-45 plan gives each delta one serialized owner and sequences the carry and reuse parts after the phase-43 epic.
- The metric becomes computable from the journal, so the ADR-021 observation data can show the effect on matched cohorts.

## Out of scope

- Changing what a review judges (own-patch input), batched stack review, and model or effort by diff size; the last stays a study that needs an ADR-014 amendment and an ADR-021 experiment.
- Any carry beyond the ADR-020 identity proof, any change to the ADR-014 grids, and auto-merging `human_checkpoint` tickets.
- The contracts of T-43-13, C1, R10 and R11, which keep their owners.
