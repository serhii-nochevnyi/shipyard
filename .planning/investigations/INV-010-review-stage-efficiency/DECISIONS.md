# Decisions

## Cascade review uses the accepted carry and reuse plus disjoint-aware merge-candidate gating (A + B2)
**Why:** Phase 44 stayed near one review per ticket only because the operator finalized siblings one at a time. Its one extra review was a base move that the T-43-13 carry covers. Gating turns that practice into a conveyor rule without weakening any gate, and it lives in the shared duty layer, so both runtimes get it.

The rule has three parts:
- `sentinel.cjs duty` and `front.cjs` keep offering ci-fix, base-merge and review-fix to every sibling.
- They offer `arch-review` only to the next merge candidate(s) per base. The priority is deterministic: depth, then unlock count, then ticket id.
- A sibling may be reviewed early only when its `files_modified` do not overlap those of any open sibling ranked ahead of it. Overlap is taken from the graph (`path-owner.cjs`), not from judgement.

Other green siblings get a non-actionable `wait-turn` state. The precedence is exact-input reuse (C1), then identity carry (T-43-13), then a fresh launch. A carried verdict is never a reuse source.

**What was rejected:**
- A alone, because overlapping siblings would still be re-judged once per earlier merge.
- C (own-patch review input), because the first review would lose sight of base interactions.
- D (batched per-ticket verdicts), because of the new schema and receipt shape and the 60k-token packet bound.
- E (size-routed model), which stays a separately gated study.

**Scope fence:** this does not change T-43-13 or C1 contracts, the ADR-014 grids, or what a review judges. It adds no carry beyond T-43-13's identity proof.

## The Claude arch-review host reviews a draft PR and records `isDraft` as an input
**Why:** Today the guard sends green drafts to review, but the host refuses them (N46). Keeping draft as the "not yet certified" state means bots and humans do not see the PR before a verdict. Head and branch identity stay strict, `isDraft` enters the C1 manifest, and undraft stays unreachable without conform.
**What was rejected:** undrafting before review, which exposes an uncertified PR and changes when bots review.
**Scope fence:** only the draft check in the identity comparison changes; no other live-PR identity check is relaxed.

## A merge candidate waiting on a person releases its siblings; the integrator keeps judging the full combination
**Why:** A ranked candidate held by `human_checkpoint`, `wait-human` or `CHANGES_REQUESTED` with zero threads must not freeze the epic. The rule reuses the existing `wait-parent` exception for a parent waiting on a person. The integrator is the only architectural interaction check, and N44 must be fixed (R13) before any reduction of its scope is considered.
**What was rejected:** a fixed timeout, which is arbitrary and can hold siblings for hours; reducing the integrator to cross-ticket interfaces only (R-15).
**Scope fence:** integrator per-subset splitting (R11) and its `base` identity fix (R13) keep their owners.

## Review launches are journalled by cause and measured on matched cohorts
**Why:** The tracked journal has no arch-review rows for phases 40–44, so the success metric cannot be computed from it (R-8). The following are journalled with ticket, head, base tree and cause:
- every arch-review launch, reuse, carry and re-owe;
- every R10 environment-only adjudication.

The cause is one of `first`, `after-violation`, `after-base-move`, `after-input-change` or `environment`. The metric "launches per merged ticket" counts `first` and `after-base-move`. Repairs after a real violation and adjudications are reported separately. Cohorts are keyed by runtime, siblings per epic and stack depth. Results stay `inconclusive` without matched cohorts.
**What was rejected:** counting every launch together, which mixes useful repairs with stale re-reviews.
**Scope fence:** no savings percentage is promised. Parent-session consumption is measured separately.

## Consequences recorded for other owners
**Why:** Several of these rules touch files owned elsewhere, and drift-check shares the same stale-on-base-move problem.
- Drift-check (phase-45 D4) follows the same candidate timing.
- Codex runs arch-review through `codex-delivery-host.cjs` without the Claude host's identity checks. The duty-layer gating and the `gate-trailer.cjs` carry apply to both runtimes; host-side draft handling and reuse are Claude-first, and the Codex part is a named gap.
- The gating and journalling deltas collide with R3 and D1 (`sentinel.cjs`, `front.cjs`) and need one serialized owner when tickets are created.
**What was rejected:** building a Codex arch-review identity host inside this change.
**Scope fence:** T-43-13's A3 reproduction is settled by its own RED step.
