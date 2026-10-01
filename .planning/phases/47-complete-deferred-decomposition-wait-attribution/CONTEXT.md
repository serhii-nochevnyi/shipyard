# Phase 47 — Deferred production decomposition wait attribution

Status: queued for future planning; no executable ticket graph.

## Authority and evidence

The operator explicitly approved moving additional phase-45 changes into subsequent planning. Phase-45 CONTEXT.md D-01 and its second-pass table reserve `commands/decompose.md` and P4 `deliver-dispatch.cjs` caller changes because phase 43 owns those seams. ADR-023 / INV-008 remain the source decisions; no requirement or quality gate is weakened.

Authenticated native checker `dispatch-muoaegbw-a2721fd8-30b3-4b66-aaf8-b1696b9b4b5a` reviewed fifteen phase-45 plans and confirmed the first-pass corrections while retaining the full REQ-193 blocker. Authenticated native planner adoption explicitly approved the first-pass candidate for conveyor continuation and retained the same second-pass blocker. This entry records that open work; it is not an implementation or verified result.

## Required result

Keep the existing REQ-193 definition. The production decomposition parent must invoke the blocking wait, emit its own measured `wait_poll` row, and attribute child model activity separately under the same original dispatch identity. Unknown child counts must stay unknown and outside measured totals. Results remain inconclusive until matched cohorts exist; no assumed savings.

## Planning and ownership boundaries

Wait for phase-43 caller ownership to clear and phase-45 host changes to merge. Inspect the then-current native Codex and Claude adapters and established caller paths. Establish exact file ownership, dependency edges and risks through Shipyard decomposition before any executor starts. Do not modify or duplicate phase-46 native model-ladder work. Review adjacent deferred S1/R16/P1 caller items from the existing follow-up backlog separately; this queued entry does not silently add them.

## Acceptance evidence to plan

A real detached production invocation must show a blocked parent until completion, an actual parent wait row and a separately attributed child row. Preserve original receipt identity, strict refusals and independent review. Include a multi-turn child regression and unknown-count coverage. Fixtures alone cannot close the production-caller requirement.

## Synchronization

REQ-193 stays open with completion ownership in Phase 47. Phase-45 first-pass integration evidence must disclose the deferral. Generate managed GSD projections through `gsd-sync.cjs`; do not hand-mark STATE, REQUIREMENTS, SUMMARY, UAT or VERIFICATION green.
