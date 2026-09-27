---
status: closed
closed: 2026-09-27
adr: .planning/architecture/ADR-021-subscription-efficiency-per-runtime.md
---

# Problem — subscription efficiency per runtime (phase 44)

## What we are solving

Settle the contracts for the seven phase-44 scope items P44-A–G (passive
provider-specific subscription observation, exact-input architecture-review
reuse with single-flight, mandatory instruction coverage per runtime, rotation
advice on comparable measurements, a research fact/source index, typed
checkpoint reasons, and a disabled-by-default native effort experiment
harness) against the installed Claude and Codex hosts and the phase-40–43
owners, so that the phase can be decomposed into authenticated PLAN files.
The user queued the phase on 2026-09-26 after reviewing the runtime-specific
research and asked for its decomposition on 2026-09-27; decomposition stopped
because no accepted ADR covers this scope (ADR-019 covers phase 41 only).

## For whom

The repository maintainer running Shipyard through Claude Code and Codex
subscriptions, and maintainers who must judge whether an optimization kept
the completed-outcome quality.

## Current pain

The 2026-09-25 audits (`docs/audits/2026-09-25-pipeline-subscription-efficiency.md`,
`docs/audits/2026-09-25-claude-session-efficiency.md`,
`docs/audits/2026-09-25-codex-phase41-pipeline-behavior.md`, copied under
`.planning/phases/44-optimize-subscription-efficiency-per-runtime/evidence/`)
show repeated architecture reviews on identical inputs, duplicated research
reads, required instructions that are loaded differently (or not at all) per
runtime, rotation advice without comparable measurements, and no subscription
observation at all: the conveyor cannot tell how much of a provider's quota a
verified completion consumed. Any saving claimed today is an inference from
token counts, which are not quota.

## What success will be

Four authenticated research lines confirm current behavior and close the
factual unknowns listed in the phase-44 RESEARCH.md (final shared-file owners
after phases 40/42/43, effective Codex instruction loading, authenticated
Codex rate-limit snapshot availability, completeness of the review reuse key,
the checkpoint reason interface, supported experimental effort pairs). An
accepted ADR fixes identities, refusal conditions, ownership boundaries and
rollout order for P44-A–G. The typed researcher/planner/checker chain then
materializes phase-44 PLAN files with global requirement IDs and a passing
graph gate. Efficiency stays inconclusive until matched cohorts support a
conclusion; no fixed savings percentage is a success condition.

## What is definitely out of scope

Reimplementing phase-40–43 contracts (planning artifact sealing, trusted
finalization recovery, bounded handoff ownership, changed-base verdict carry,
F17 merge/approval semantics, F18 remedy policy); phase-45 work (INV-008,
owned by another session); blanket model downgrades; mandatory
double-provider review; provider fallback or quota-based cross-provider
scheduling; new daemons; automatic session transfer; destructive instruction
cleanup in target repositories; API-price or token-to-quota conversion;
activating any efficiency experiment or production policy change; code
implementation during the investigation.

## Inputs

- [Phase 44 context](../../phases/44-optimize-subscription-efficiency-per-runtime/CONTEXT.md), [research handoff](../../phases/44-optimize-subscription-efficiency-per-runtime/RESEARCH.md), [work packages](../../phases/44-optimize-subscription-efficiency-per-runtime/WORK-PACKAGES.md), [planning status](../../phases/44-optimize-subscription-efficiency-per-runtime/PLANNING-STATUS.md)
- [Evidence manifest](../../phases/44-optimize-subscription-efficiency-per-runtime/evidence/MANIFEST.json): REPORT.md, IMPLEMENTATION-RESEARCH.md, RUNTIME-SPECIFIC-ADDENDUM.md
- Accepted ADR-014, ADR-019, ADR-020 and the phase-40–43 plans; source material, not approval of new phase-44 policy.
