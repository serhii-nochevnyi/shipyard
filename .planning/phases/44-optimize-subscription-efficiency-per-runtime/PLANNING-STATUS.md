# Phase 44 queue and readiness

Status: FIRST PASS PLANNED (2026-09-27) — seven tickets T-44-01..07 (P44-A, P44-D, P44-G; REQ-176..REQ-184) from ADR-021 / INV-009. Typed researcher, planner and checker ran through `claude-decompose-host.cjs` with verified receipts (Claude opus/medium); the checker's sealed decomposition index matches CONTEXT.md and all seven PLAN files; Gate 2 (`validate-graph.cjs`) exits 0. T-44-04 and T-44-05 carry `human_checkpoint: true` and were preauthorized by the user at Gate 2. Jira export is disabled for this repository.
Second pass: P44-B, P44-C, P44-E and P44-F are planned after the phase-43 epic merges to main (ADR-021 decision 1).

The text below is the 2026-09-26 queue record, kept for history. Its "Blocking formal decomposition" section is superseded: the installed decompose hosts carry the planning artifact contract (INV-009 RESEARCH.md, "Deployment"), and ADR-021 is the accepted design.


Status: QUEUED — scoped preparation available; NOT EXECUTION-READY.
Registered by supported GSD phase.add on 2026-09-26. No delivery PLAN files, global requirement IDs, tickets, PRs or Jira issues were fabricated. No active delivery run was started.

## Completed preparation

- Phase 44 reserved after checking registered worktrees for existing phase 44+ directories.
- User scope, provider-specific contracts, exclusions and dependency order recorded in CONTEXT.md.
- Prior audit and implementation evidence copied into this phase with SHA-256 manifest.
- Nine bounded proposed work packages with acceptance/refusal cases prepared.
- Active planning runtime resolved to Codex through installed pipeline-config.
- `gsd-tune --check --runtime codex` reports tuning-only drift (heavy xhigh vs suggested high), not a required delivery blocker; settings were preserved.

## Blocking formal decomposition

The loaded shipyard-decompose skill requires a trusted planning artifact envelope/index plus verified typed researcher/planner/checker receipts. Its instruction says: “The trusted consumer checks containment, source revision, phase/repository/ADR identity, and every listed digest before Gate 2.”

The installed `/Users/serhii/.codex/shipyard/scripts/codex-decompose-host.cjs` currently accepts only gsd_role/prompt/signals/dispatch_id and returns launchAgent directly. It does not expose the required planning artifact destination/identity/sealing contract. This is the phase-40 planning-host dependency, not a reason to bypass receipt checks, use a private bootstrap, or switch providers. No doomed model launch was performed.

The source-backed proposal also has no closed authenticated investigation/accepted ADR for this new scope. Queue registration is authorized by the user's request; it must not be misrepresented as a passed architectural or delivery gate.

## Automatic continuation contract for the next planning session

1. Reconcile phase-40/41/42 installed state and earlier target-scale F6/F17/F18 ownership by requirement content.
2. Resolve runtime and preflight the installed delivery rules. Verify planning artifact support before any researcher launch. Read current CONTEXT and evidence manifest rather than replaying the conversation.
3. Through the shipped authenticated research path, validate the recorded design and close factual uncertainties; create/review the ADR package without silently enabling production policy changes or experiments.
4. Use the shipped Codex decomposition host for exact gsd-phase-researcher, gsd-planner and gsd-plan-checker roles, with native model policy and materialized artifact indexes. Retain original receipts.
5. Assign global requirement and ticket IDs, materialize PLAN files, and run the real validate-graph gate. Run projections only against the intended authoritative planning tree; do not overwrite concurrent unrelated state.
6. Mark execution-ready only after verified artifact/checker/graph gates and dependency readiness. A roadmap queue entry is not a runnable ticket graph.

## Queue order

After the currently queued phase 42 recovery and phase 40 delivery/planning seams; consume phase-41 measurement/handoff interfaces. This entry does not change current execution ownership or existing release order.

## Verification

Preparation checks and test results are recorded in PREPARATION-CHECKS.md after execution. Prior research test passes are not substituted for current gate or implementation evidence.
