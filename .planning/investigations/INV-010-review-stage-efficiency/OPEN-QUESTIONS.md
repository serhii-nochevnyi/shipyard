# Open questions

## Decisions (maintainer)
- [ ] Q1: Which combination of options is adopted: A only, A+B (merge-candidate gating, B1 strict or B2 disjoint-aware), A+B+C (own-patch input), or D (batched per-ticket verdicts)? — owner: maintainer; see [OPTIONS.md](OPTIONS.md)
- [ ] Q2: Draft precondition (N46): does the host review a draft, with `isDraft` as a recorded input, or does the conveyor undraft before review? — owner: maintainer / R13
- [ ] Q3: Under merge-candidate gating, how long may a ranked candidate that waits on a human hold its siblings? Reuse the `wait-parent` exception for a parent waiting on a person, or add a timeout? — owner: maintainer
- [ ] Q4: Integrator overlap: does the integrator keep judging the full combined diff, or only cross-ticket interfaces once every ticket has a head-bound verdict? — owner: maintainer / R11
- [ ] Q5: Metric: does an R10 environment-only adjudication count as a review launch, and what is the cohort key for review-timing treatments (tickets per epic, stack depth, repository count, runtime)? — owner: maintainer

## Research-answerable (closed by the research lines and operator data)
- [x] What is launched when, and what is judged, today? — [RESEARCH.md](RESEARCH.md) "Current system state"
- [x] How do T-43-13 carry and C1 reuse combine, and what stays stale after both? Precedence reuse → carry → fresh; carry never feeds reuse. Stale after both: owned-path conflicts and governing-input changes, which must re-owe. — [RISKS.md](RISKS.md) R-1, R-2; [research/constraints.md](research/constraints.md)
- [x] Is the "phase 43: 23/13" baseline from Shipyard phase 43? No: it is the MYD-17835 target-project run. — RESEARCH.md "Measurements"
- [x] Does Codex run arch-review? Yes, through `codex-delivery-host.cjs` with the generated role file (11 phase-43 receipts); the missing piece is an identity-checking phase host. — RESEARCH.md
- [x] What caused phase 44's extra review and phase 43's repeats? Phase 44: one base move (T-44-01 after T-44-07) that the T-43-13 carry would cover. Phase 43: real violations, repairs and a sandbox `EPERM` (N57). — RESEARCH.md "Measurements"
- [x] Model and effort by diff size: study only; adoption needs an ADR-014 amendment and an ADR-021 experiment. — PROBLEM.md; RISKS.md R-13

## Follow-up owned elsewhere (not blocking Gate 1)
- [x] T-43-13's tree-based patch-id reproduction (A3) is settled by its RED step. — owner: T-43-13 executor; recorded in RISKS.md R-12
- [x] Drift-check (D4) shares the stale-on-base-move problem, so its timing follows the rule decided here. — owner: D4; recorded as a consequence in DECISIONS.md

Gate 1 stays open until Q1–Q5 are decided.
