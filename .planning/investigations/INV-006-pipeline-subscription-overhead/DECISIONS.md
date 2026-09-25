# Decisions

## Phase 41 starts with the accepted measured scope

**Why:** The user requested adding the important audit findings to phase 41 and
then asked to start that phase here.
**What was rejected:** Nothing new is being selected on the user's behalf;
implementation alternatives remain open below.
**Scope fence:** P41-A–F in the phase CONTEXT.md. Scope acceptance does not mark
an ADR accepted, tickets executable, or gates passed.

## Preserve the phase 39 → phase 41 → phase 40 delivery order

**Why:** This ordering is recorded in the existing phase context and Claude
session evidence; T-39-17 already owns judgment packet selection/bounds.
**What was rejected:** Duplicate packet fixes and circular phase dependencies.
**Scope fence:** Research/planning may proceed before phase 39 finishes. Final
file ownership and source baselines must be reconciled before execution.

## Use a temporary local planning host before phase 40

**Why:** On 2026-09-25 the user explicitly requested “полікуй локально поки ми не реалізували стадію 40”.
**What was rejected:** Waiting for phase 40 solely to enable this investigation.
**Scope fence:** A private worktree-bound runtime and trusted artifact consumer;
no global install replacement, fabricated receipts, product-code commit or
phase-40 completion claim. Four canonical research lines have now run through
that host. Typed researcher/planner/checker remain separate steps.

## Carry the approved six-priority scope into ADR-019

**Why:** The user requested phase-41 decomposition and reiterated planner/checker
progress. ADR-019 records P41-A–F already present in the accepted context;
implementation contracts are delegated to the phase researcher/planner.
**What was rejected:** Expanding to automatic rotation, a new daemon, ledger or
orchestration framework; lowering review/model requirements.
**Scope fence:** Use safe explicit handoff boundaries; changed-base recovery
refuses unless the plan defines complete revalidation. Measurements retain the
existing matched-cohort/readiness/quality rules and may remain inconclusive.
These are conservative implementations of the existing acceptance criteria,
not permission to bypass a gate or deliver phase-40 code.
