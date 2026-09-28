# Phase 45 — Close residual pipeline efficiency gaps

Status: queued; scoped work packages prepared; authenticated investigation and decomposition pending.
Authorized: the user asked to move the previously identified phase-44 gaps into a phase on 2026-09-26.
Planning runtime: resolve from the installed pipeline configuration at formal planning time. Target behavior: Claude Code and Codex through their own native hosts.

## Goal

Correct the armed Claude Stop gate's cross-session board selection, then remove avoidable repeated model work and uncontrolled launches left outside phase 44 while preserving completed-outcome quality, native receipts, independent reviews, required instructions, tests, approval, and live merge checks. Compare each provider's subscription observations within its own account and reset window; do not translate token totals or API prices into quota. S1 is judged by correctness and installed-host behavior, not quota savings.

## Order and prerequisites

Phase 45 follows phase 44 in the roadmap. Its planning-reliability workstream also needs the phase-40 authenticated planning host and phase-42 trusted recovery boundary; delivery-efficiency changes need phase-41 outcome attribution and phase-44 provider-specific observation. S1 depends on the existing phase-39 arming and phase-41 scoped-run behavior, but not on provider-specific observation or the efficiency treatments. Prioritize and, if necessary, release S1 independently after its own formal gates so the correctness fix does not wait for quota experiments. Numbering is not proof those dependencies are installed or verified. Do not activate a work package until its own prerequisite receipts exist.

## In scope

The phase-local identifiers below map to the acceptance cases in [WORK-PACKAGES.md](WORK-PACKAGES.md). They are not global REQ IDs or materialized tickets.

- S1: bind an armed Claude Stop-gate session to its selected delivery board/run; refuse selection of a newer foreign worktree board. Give this correctness fix its own high-risk ticket and checkpoint.
- P1–P5: planning worktree single-writer lease; completed judgment-role timeout recovery; bounded checker revision protocol; Codex parent/wait overhead treatment; exact-revision INV reuse and stable research reporting.
- R18: investigate exact merge-result CI attestation for a clean PR after its epic base moves, so an unrelated merge does not mechanically change the ticket head ([merge-base research](MERGE-BASE-RESEARCH.md)); no stale check, GitHub `CLEAN` status or old-run rerun is accepted as proof.
- R10/R17: classify reviewer sandbox failures before spending another judgment turn, and persist and recover executor-owned publication payload without replaying a completed model turn ([environment/recovery research](ENVIRONMENT-RECOVERY-RESEARCH.md)); no waiver or artifact synthesis is authorized.
- D1–D6: host-owned sentinel duty scheduling; stage/runtime delivery instruction loading; repair grouping with measured ticket granularity; exact-input drift-scan reuse; run/phase aggregate admission budget; bounded Codex outer-agent coordination handoff and routing (D6), subject to phase-44 measurement and an approved model experiment, see [model-routing research](MODEL-ROUTING-RESEARCH.md).

Keep each treatment independent for measurement and rollback. Shared source and host files need serialized ticket ownership when the graph is planned.

## Existing owners and exclusions

Phase 44 (delivered in 0.68.0) owns subscription collection/reporting, rotation advice and the native effort-experiment protocol. Exact arch-review reuse, mandatory instruction coverage, fact indexing and checkpoint reasons were carried into this phase as workstream C (C1–C4, ADR-021). Phases 40–42 own planning artifact sealing, delivery dispatch/preflight, wake/handoff, complete-prompt measurement and executor finalization recovery. Phase 45 may consume their contracts but must not implement them again. The repair loop may not weaken independent reviewer or CI requirements; the admission budget may not convert missing quota into a green verdict.

Adaptive 1/2/4 investigation fan-out conflicts with phase 44's four independent perspectives and is not authorized here. Automatic session transfer, provider fallback or quota-based cross-provider scheduling, global model downgrades, and an always-on sentinel daemon are excluded. Each would need a separately accepted design, capability proof and quality evaluation.

The reproduced [armed Stop-gate foreign-board defect](../../backlog/stop-gate-selects-foreign-session-board.md) is S1, a separate correctness package in this phase. It must not be hidden inside D1's routine sentinel scheduling or counted as an efficiency treatment. S1 must preserve the historical stale-main-cwd/live-phase-worktree case while rejecting another session's newer board.

## Completion and promotion criteria

Formal planning requires authenticated investigation, reviewed ADR where policy/contracts change, typed researcher/planner/checker artifact indexes, global requirement IDs, bounded PLAN files, and the real graph gate. S1 requires an independent PLAN/ticket, a high-risk human checkpoint, a two-armed-session fixture, and verification of the installed copied Claude hook. The P/D treatments require native installed-host tests and one treatment at a time. A treatment can be promoted only on comparable verified completions with failed/abandoned work included, no lost gate or ownership invariant, and provider-specific quota observations where attribution is possible. Missing or confounded data is inconclusive, not a saving.

This queue entry authorizes planning the work, not dispatching model jobs or turning on experiments.
