---
status: accepted
---
# ADR-019 — Reduce pipeline subscription overhead through existing mechanisms

- **Status:** accepted
- **Date:** 2026-09-25
- **Decision owner:** repository maintainer; scope approved in this conversation
- **Scope:** phase 41, P41-A–F; implementation details belong to its plans
- **Supersedes:** none
- **Related:** ADR-011, ADR-013, ADR-014, ADR-016, ADR-017
- **UI design:** none

## Context

The user requested a pipeline/session efficiency audit, adding the important
findings to phase 41, and starting its decomposition in an isolated worktree.
The accepted phase context defines six priorities and explicit correctness and
ownership constraints. Four canonical INV-006 research lines now have real
Codex receipts and sealed artifacts. Their full reports and limitations remain
in ../investigations/INV-006-pipeline-subscription-overhead/RESEARCH.md.

The audit reports 252,061,225 processed input tokens, mostly cache reads; parent
sessions dominate, false wakes and executor replay are observed, and judgment
packets carried the entire backlog. These are processing counts, not measured
subscription savings. Phase 39 has since merged; the planning worktree is based
on main d0c2804e517dda9e1924312362749f04f429caff (release 0.63.0).

## Decision

- REQ-151 / P41-A: measure complete assembled prompts and observed first-response usage with installed host/policy identity. Build on integrated T-39-17 selection/bounds; preserve governing and transitive constraints and correct only reproduced residual gaps.
- REQ-152 / P41-B: use the existing session-handoff/controller for compact durable checkpoints at safe phase boundaries and long waits. Preserve accepted decisions, unresolved findings, attempts, artifact digests, pending gates, owner identity and exact next action; no active dispatch may be orphaned or duplicated.
- REQ-153 / P41-C: verify installed T-39-03 arming and callers; prevent foreign/unchanged work from causing model replies while preserving one wake on a relevant owner transition. Count shell polling separately. Extend only a demonstrated residual gap.
- REQ-154 / P41-D: persist authenticated completed-execution evidence before trusted finalization and recover it idempotently without automatically rerunning executor. Bind repository/ticket/worktree/tree/head/base/graph/plan/policy/receipt/verification. Changed identity must explicitly revalidate affected checks or refuse; failed/pending gates remain visible.
- REQ-155 / P41-E: compute each GSD projection fingerprint from its actual governing inputs and dependency edges; preserve relevant aggregate invalidation and read-only consistency checks. Unrelated phase artifacts remain byte-identical after a local change.
- REQ-156 / P41-F: extend existing usage/overhead attribution with a deduplicated parent/child-to-verified-outcome join, retaining unknown data and failed/interrupted/parked/recovery work. Report cache categories, output, model turns/retries, cohort total and median/p90 per verified completion with quality signals.
- Preserve canonical runtime-specific model floors, authenticated host dispatch and artifacts, independent checker/integrator judgments and all verification/merge gates.
- Keep phase 39 → 41 → 40 ordering. Map shared files explicitly and adjust later phase-40 ownership/order when needed; no circular cross-phase dependency or duplicate phase-40 feature.
- Use the user-authorized private host only as local planning bootstrap pending phase 40. Its receipts prove exercised operations; no phase-40 completion or production rollout is inferred.

## Consequences

- Existing mechanisms are reused; this phase does not introduce another orchestration framework or accounting ledger.
- Engineering must make checkpoint inputs, recovery refusal conditions and projection invalidation sets explicit in executable plans.
- Initial handoffs use existing safe explicit boundaries. Automatic threshold-driven session rotation is deferred; measurement includes collection/startup/cache-warmup cost.
- Changed-base recovery defaults to refusal unless the plan defines and preserves the complete required revalidation contract. No verification bypass is authorized.
- Measurement uses matched runtime/model/effort and role scope, one behavioral treatment at a time, and existing 20-completion/95%-attribution and quality readiness criteria. Insufficient evidence is inconclusive; verified functional fixes need not wait for the live sample.
- Newly integrated phase-39 source must be reconciled with the older audit and research baseline. Installed behavior remains distinct from source integration.

## Out of scope

- Global model downgrades, reduced independent review, adaptive research fan-out, a new sentinel daemon, broad ticket resizing or a full instruction-document rewrite.
- Reimplementing T-39-17 packet selection or T-39-03 arming.
- Phase-40 shared planning sealer, producer/consumer fixture migration, general host provenance, dispatch request construction, or finalizer formatting work.
- Promising a fixed subscription-credit or financial saving from token totals.
