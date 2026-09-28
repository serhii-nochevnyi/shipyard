# Phase 45 queue and readiness

Status: QUEUED — scope captured; NOT EXECUTION-READY.

Investigation INV-008 is open. Its [authenticated-workflow preflight](../../investigations/INV-008-residual-pipeline-efficiency/PREFLIGHT.md) found the installed Codex research and decomposition artifact consumers missing; no researcher was launched, no ADR accepted, and no Gate 1/2 claimed. Phase-40 T-40-12 and T-40-11 remain pending in the local graph. Resume after those contracts are integrated and installed.

Recheck after release 0.66.0: the blocker remained. `origin/main` assigns phase 43 to ADR-020 target-project delivery at scale, so the local optimization phases were renumbered on 2026-09-27: subscription efficiency is phase 44 and this residual phase is phase 45. Both are now roadmap entries on `main`.

Recheck after release 0.67.0 (2026-09-27): phase 40 is merged and released, including T-40-12 (Codex planning-artifact consumer) and T-40-11. Rerun the installed-host preflight before dispatching the INV-008 research lines.

- GSD `phase.add` originally reserved this phase as local phase 44; it was renumbered to 45 when it entered the `main` roadmap.
- Thirty-two bounded or proposed work packages (S1, P1–P5, D1–D6 including proposed D6, R1–R16 and the carried C1–C4), including the separately owned high-risk S1 Stop-gate correctness fix, and their dependencies and acceptance/refusal cases are in [WORK-PACKAGES.md](WORK-PACKAGES.md).
- 2026-09-27: workstream R (stacked-delivery reliability; R11 added after the epic merge) was added from the [phase-40 delivery findings](../../investigations/INV-008-residual-pipeline-efficiency/intake/phase40-delivery-findings.md). T-40-12 and T-40-11 are now merged into `epic/40-build-delivery-seams-and-clean-target-project-prs` and have since landed on `main` in release 0.67.0.
- No global requirements, ticket IDs, delivery PLAN files, PRs or provider experiments were created.
- Phase 44's first pass was delivered in 0.68.0, which gives phase 45 the quota observation it needs for a baseline. Phase-40/42 installed-host capability must be rechecked before phase-45 decomposition or activation.
- 2026-09-28: findings N49–N56 from the phase-44 delivery were added. They extend R10, R12, S1 and C1 and add R14 (human preconditions before launch), R15 (executor context budget) and R16 (concurrent-session host isolation).
- 2026-09-28: the [model-routing research](MODEL-ROUTING-RESEARCH.md) records the phase-43 Codex subscription-window audit. Proposed D6 is limited to outer delivery coordination handoff and routing, and depends on phase-44 measurement and an approved experiment. The research asserts no token-to-quota conversion, quality equivalence, accepted ADR or execution readiness.
- 2026-09-28: workstream C (C1–C4 = P44-B, P44-C, P44-E, P44-F) moved here from phase 44 under the ADR-021 amendment; it waits for the phase-43 epic.

Next formal step: use the supported authenticated Shipyard/GSD investigation and planning path, reconcile current upstream owners and shared-file edits, obtain the required ADR review, then materialize typed planner/checker artifacts and run validate-graph. Do not use a private host or infer a passing gate from this scope document.
